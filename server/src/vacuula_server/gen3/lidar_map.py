"""A stored map's lidar map: what the lidar saw over all runs on it (gen3/lidar.py), cell by cell.

Every run on a stored map lies in the same frame (the robot's, from its dock), and on a D7 its walls lie
on the other runs' walls within 0.4-1.1 cm (checked over 13 runs 2026-11-14), so the runs' grids are
put on top of each other as they are. Per cell: in how many runs it was seen and in how many something
stood there. From that share:

    fixed    something there (or a cell beside: runs scatter by about one) in nearly every run that saw it
             (walls, heavy furniture)
    movable  something there in some runs only (chairs, doors, boxes)
    free     seen, nothing there

A run whose walls lie clearly off the others' (WORST_FIT_CM) is left out: it found itself wrongly.
The result is kept per map (DATA_DIR/lidar_maps/<serial>/<map id>.npz) and made again when a run of the
map gets its lidar grid.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from vacuula_server.constants import DATA_DIR, MAPS_DIR
from vacuula_server.gen3 import lidar

logger = logging.getLogger(__name__)

STORE = DATA_DIR / "lidar_maps"
MIN_RUNS = 3          # a cell needs to be seen in this many runs to be called fixed or movable
FIXED_SHARE = 0.8     # something there in at least this share of the runs that saw it
MOVABLE_RUNS = 2      # hit in at least this many runs to be drawn as movable
WORST_FIT_CM = 2.5    # mean distance of a run's walls to the other runs' walls above this: left out
PNG = {"free": 80, "movable": 170, "fixed": 255}  # grey values of the picture (0: not seen)

_lock = threading.Lock()


def _run_grids(serial: str, map_id: str) -> list[dict]:
    """The lidar grids of the runs on a map: {"run", "x0", "y0", "occ", "seen"} (bool arrays)."""
    out = []
    for f in sorted((MAPS_DIR / serial).glob("*/" + "lidar.npz")):
        try:
            with np.load(f) as z:
                meta = json.loads(z["meta"].tobytes())
                if (meta.get("map") or {}).get("mapId") != map_id:
                    continue
                hits, free = z["hits"].astype(np.float32), z["free"].astype(np.float32)
        except Exception as e:
            logger.info("Lidar map: %s not readable: %s", f, e)
            continue
        occ = (hits >= lidar.HIT_MIN) & (hits >= lidar.HIT_SHARE * (hits + free))
        out.append({"run": f.parent.name, "x0": meta["x0"], "y0": meta["y0"], "occ": occ, "seen": (hits + free) > 0})
    return out


def _wall_distance(walls: np.ndarray) -> np.ndarray:
    """Per cell the distance (cells, capped at 6) to the nearest wall cell, by growing the walls."""
    dist = np.full(walls.shape, 6, dtype=np.uint8)
    cur = walls.copy()
    dist[cur] = 0
    for d in range(1, 6):
        grown = cur.copy()
        grown[1:] |= cur[:-1]; grown[:-1] |= cur[1:]; grown[:, 1:] |= cur[:, :-1]; grown[:, :-1] |= cur[:, 1:]
        dist[grown & ~cur] = d
        cur = grown
    return dist


def _grow(a: np.ndarray) -> np.ndarray:
    """A mask grown by one cell (8 neighbours)."""
    g = a.copy()
    g[1:] |= a[:-1]; g[:-1] |= a[1:]
    h = g.copy()
    h[:, 1:] |= g[:, :-1]; h[:, :-1] |= g[:, 1:]
    return h


def build(serial: str, map_id: str) -> dict | None:
    """Put the map's runs together and keep the result. None without runs."""
    runs = _run_grids(serial, map_id)
    if not runs:
        return None
    cell = lidar.CELL_MM
    x0 = min(r["x0"] for r in runs)
    y0 = max(r["y0"] for r in runs)
    w = max((r["x0"] - x0) // cell + r["occ"].shape[1] for r in runs)
    h = max((y0 - r["y0"]) // cell + r["occ"].shape[0] for r in runs)

    def placed(r, key):
        g = np.zeros((h, w), dtype=bool)
        c, rr = (r["x0"] - x0) // cell, (y0 - r["y0"]) // cell
        g[rr:rr + r[key].shape[0], c:c + r[key].shape[1]] = r[key]
        return g

    occ = [placed(r, "occ") for r in runs]
    seen = [placed(r, "seen") for r in runs]
    occ_n = np.sum(occ, axis=0, dtype=np.uint16)
    # a run that found itself wrongly: its walls far from the walls the others agree on
    used, left_out = [], []
    for i, r in enumerate(runs):
        if len(runs) >= 4:
            others = (occ_n - occ[i]) >= 2
            ys, xs = np.nonzero(occ[i])
            fit = float(_wall_distance(others)[ys, xs].mean()) * cell / 10 if len(ys) else 99.0
            if fit > WORST_FIT_CM:
                left_out.append((r["run"], round(fit, 1)))
                continue
        used.append(i)
    # something there in a run: hit there or right next to it (runs scatter by about a cell, so a thin
    # wall is hit in one run here and in the next one beside it; it is still fixed)
    occ_runs = np.sum([_grow(occ[i]) for i in used], axis=0, dtype=np.uint16)
    hit_runs = np.sum([occ[i] for i in used], axis=0, dtype=np.uint16)
    seen_runs = np.sum([_grow(seen[i]) for i in used], axis=0, dtype=np.uint16)
    meta = {"x0": int(x0), "y0": int(y0), "cell": cell, "runs": [runs[i]["run"] for i in used], "leftOut": left_out}
    path = STORE / serial / f"{map_id.replace(':', '-')}.npz"
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, occ_runs=occ_runs, hit_runs=hit_runs, seen_runs=seen_runs,
                        meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))
    logger.info("Lidar map of %s, map %s: %d runs put together%s", serial, map_id, len(used),
                f", left out (walls off by cm): {left_out}" if left_out else "")
    return meta


def rebuild_later(serial: str, map_id: str | None) -> None:
    """After a run of the map got its lidar grid: the map's lidar map again (in the background)."""
    if not map_id:
        return

    def run() -> None:
        with _lock:
            try:
                build(serial, map_id)
            except Exception:
                logger.exception("Lidar map of %s, map %s not built", serial, map_id)
    threading.Thread(target=run, name="lidar-map", daemon=True).start()


def picture(serial: str, map_id: str) -> dict | None:
    """The map's lidar map as a grey PNG (PNG values: free, movable, fixed; 0 not seen) with its top
    left corner (mm, robot frame), cell size and the runs in it. Built first if there is none yet."""
    path = STORE / serial / f"{map_id.replace(':', '-')}.npz"
    if not path.is_file():
        with _lock:
            if not path.is_file() and build(serial, map_id) is None:
                return None
    with np.load(path) as z:
        occ_runs, seen_runs = z["occ_runs"].astype(np.float32), z["seen_runs"].astype(np.float32)
        hit_runs = z["hit_runs"]
        meta = json.loads(z["meta"].tobytes())
    share = np.divide(occ_runs, seen_runs, out=np.zeros_like(occ_runs), where=seen_runs > 0)
    enough = seen_runs >= MIN_RUNS
    # drawn where a run hit; whether fixed or movable from the share of runs with something there or
    # next to it (see build)
    hit = hit_runs > 0
    img = np.zeros(occ_runs.shape, dtype=np.uint8)
    img[(seen_runs > 0) & ~hit] = PNG["free"]
    # movable: hit in at least MOVABLE_RUNS runs (once only is mostly noise: a passer-by, a reflection, or
    # something that lay there once -- that is for the run's own changes, not for the map)
    img[hit & (share < FIXED_SHARE) & (hit_runs >= MOVABLE_RUNS) & enough] = PNG["movable"]
    img[hit & (share >= FIXED_SHARE)] = PNG["fixed"]
    buf = io_png(img)
    return {"png": buf, "x0": meta["x0"], "y0": meta["y0"], "cell": meta["cell"], "width": int(img.shape[1]),
            "height": int(img.shape[0]), "runs": len(meta["runs"]), "leftOut": meta.get("leftOut", []),
            "values": PNG}


def io_png(img: np.ndarray) -> str:
    import base64
    import io
    b = io.BytesIO()
    Image.fromarray(img, mode="L").save(b, format="PNG", compress_level=6)
    return base64.b64encode(b.getvalue()).decode()


# ---- what changed in a run --------------------------------------------------------------------------
CHANGE_EVIDENCE_RUNS = 4   # the place was seen free in at least this many other runs (on average)
CHANGE_FREE_SHARE = 0.1    # ... and something stood there in at most this share of them
CHANGE_MIN_CELLS = 8       # hit cells of the run there: fewer is noise
OBSTACLE_CM = 30           # a new thing this long (its side the lidar saw) is reported
DOOR_CM, DOOR_THICK_CM = 60, 16  # a door (closed): a new straight line this long, at most this thick ...
DOOR_WALL_CELLS = 5        # ... whose both ends reach a fixed wall within this (10 cm) ...
DOOR_SIDE_CELLS = 10       # ... with floor that is usually free this far (20 cm) on both sides of it
# (by its place, not its shape: a thin new thing along a wall or by a door that stayed closed is an
# obstacle -- seen 2026-11-14 at a door that was closed as always)


def _blobs(mask: np.ndarray) -> list[np.ndarray]:
    """The 8-connected parts of a mask, as arrays of (row, col)."""
    left = {(int(r), int(c)) for r, c in zip(*np.nonzero(mask))}
    out = []
    while left:
        start = left.pop()
        part, todo = [start], [start]
        while todo:
            r, c = todo.pop()
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    n = (r + dr, c + dc)
                    if n in left:
                        left.remove(n)
                        part.append(n)
                        todo.append(n)
        out.append(np.array(part))
    return out


def _closes_gap(rows: np.ndarray, cols: np.ndarray, fixed: np.ndarray, usual_free: np.ndarray) -> bool:
    """A new line (its cells) lies like a closed door: both its ends reach a fixed wall and the floor on
    both sides of it is usually free."""
    pts = np.vstack([cols, rows]).astype(float)
    c = pts.mean(1)
    _, vecs = np.linalg.eigh(np.cov(pts))
    d = vecs[:, 1]                       # along the line
    n = np.array([-d[1], d[0]])          # across it
    t = d @ (pts - c[:, None])
    h, w = fixed.shape

    def near(mask: np.ndarray, p: np.ndarray, r: int) -> bool:
        y, x = int(round(p[1])), int(round(p[0]))
        return bool(mask[max(0, y - r):min(h, y + r + 1), max(0, x - r):min(w, x + r + 1)].any())

    if not (near(fixed, c + d * t.min(), DOOR_WALL_CELLS) and near(fixed, c + d * t.max(), DOOR_WALL_CELLS)):
        return False
    for side in (1, -1):
        along = [c + d * (t.min() + f * (t.max() - t.min())) + n * side * DOOR_SIDE_CELLS for f in (0.3, 0.5, 0.7)]
        if sum(near(usual_free, p, 1) for p in along) < 2:
            return False
    return True


def changes(serial: str, run_id: str, map_id: str | None) -> list[dict] | None:
    """What stood in a run where its map's other runs agree it is free: new obstacles and closed doors
    ({"kind": "obstacle"|"door", "lengthCm", "x", "y", "box": [x1, y1, x2, y2]}, mm of the robot's frame).
    None if it can't be told (no map, too few other runs, or the run found itself wrongly)."""
    if not map_id:
        return None
    runs = _run_grids(serial, map_id)
    me = next((r for r in runs if r["run"] == run_id), None)
    # the runs the map's lidar map left out (they found themselves wrongly) don't say what is usual
    left_out = set()
    try:
        with np.load(STORE / serial / f"{map_id.replace(':', '-')}.npz") as z:
            left_out = {r for r, _ in json.loads(z["meta"].tobytes()).get("leftOut", [])}
    except Exception:
        pass
    others = [r for r in runs if r is not me and r["run"] not in left_out]
    if me is None or len(others) < CHANGE_EVIDENCE_RUNS:
        return None
    cell = lidar.CELL_MM
    x0 = min(r["x0"] for r in runs)
    y0 = max(r["y0"] for r in runs)
    w = max((r["x0"] - x0) // cell + r["occ"].shape[1] for r in runs)
    h = max((y0 - r["y0"]) // cell + r["occ"].shape[0] for r in runs)

    def placed(r, key):
        g = np.zeros((h, w), dtype=bool)
        c, rr = (r["x0"] - x0) // cell, (y0 - r["y0"]) // cell
        g[rr:rr + r[key].shape[0], c:c + r[key].shape[1]] = r[key]
        return g

    occ_o = np.sum([_grow(placed(r, "occ")) for r in others], axis=0, dtype=np.uint16)
    seen_o = np.sum([_grow(placed(r, "seen")) for r in others], axis=0, dtype=np.uint16)
    mine = placed(me, "occ")
    # the run itself must lie right: its walls on the others'
    walls = occ_o >= 2
    ys, xs = np.nonzero(mine)
    if len(ys) and float(_wall_distance(walls)[ys, xs].mean()) * cell / 10 > WORST_FIT_CM:
        return None
    usual_free = (seen_o >= 3) & (occ_o <= CHANGE_FREE_SHARE * seen_o)
    fixed = (seen_o >= 3) & (occ_o >= FIXED_SHARE * seen_o)
    new = mine & usual_free
    found = []
    for part in _blobs(_grow(new)):
        rows, cols = part[:, 0], part[:, 1]
        hit = new[rows, cols]
        if hit.sum() < CHANGE_MIN_CELLS or seen_o[rows[hit], cols[hit]].mean() < CHANGE_EVIDENCE_RUNS:
            continue
        r0, r1, c0, c1 = rows[hit].min(), rows[hit].max() + 1, cols[hit].min(), cols[hit].max() + 1
        length = max(r1 - r0, c1 - c0) * cell / 10
        thick = min(r1 - r0, c1 - c0) * cell / 10
        if length >= DOOR_CM and thick <= DOOR_THICK_CM and _closes_gap(rows[hit], cols[hit], fixed, usual_free):
            kind = "door"
        elif length >= OBSTACLE_CM:
            kind = "obstacle"
        else:
            kind = None
        if not kind:
            continue
        bx1, bx2 = x0 + c0 * cell, x0 + c1 * cell
        by1, by2 = y0 - r1 * cell, y0 - r0 * cell
        # plain ints: numpy's don't go into JSON
        found.append({"kind": kind, "lengthCm": int(round(float(length))), "x": int(bx1 + bx2) // 2,
                      "y": int(by1 + by2) // 2, "box": [int(bx1), int(by1), int(bx2), int(by2)]})
    return sorted(found, key=lambda f: -f["lengthCm"])
