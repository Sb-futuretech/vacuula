"""Coverage of a stored gen3 map over its runs, worked out once per run and kept.

What the app's coverage heatmap used to build itself on every opening (components/map/heatmap.ts),
with dozens of requests: which cells of the stored map each run cleaned. A run never changes, so its
cells are worked out once and kept per map, and so is the verdict that a run does not lie on the map;
a new run is worked out on top. The heatmap of the last N runs is then a sum.

Which runs, and how they are placed, as in the app:
- a run that names the map lies on it and is placed by laying its own floor map's walls over the
  stored map's walls (it may cover only part of it); one that doesn't fit well enough is left out;
- a run that names no map (the D7 leaves the id out of some uploads) counts if its grid has the
  stored map's size and its dock lies within SAME_FLOOR_CELLS of the stored map's;
- what it cleaned: its black box track (the brush width around its real way, track.json) if it has
  one, else its RunMap path widened to the robot's size; only free floor counts.
"""
from __future__ import annotations

import json
import logging
import math
import threading
from pathlib import Path

import numpy as np
from sqlalchemy import select

from vacuula_server.constants import DATA_DIR, MAPS_DIR
from vacuula_server.db import get_session
from vacuula_server.models.persistent_map import PersistentMap
from vacuula_server.models.run import Gen3__Run

logger = logging.getLogger(__name__)

STORE = DATA_DIR / "coverage_maps"
FREE, WALL = 1, 2
RUN_DOCK = 100
RUN_NOT_PATH = (128, 100, 150, 200)   # background and marker blocks of a RunMap
SAME_FLOOR_CELLS = 10
ROBOT_RADIUS_CELLS = 165 / 40
BLOCK = 4                             # coarse search in blocks of 4 cells
FINE_RANGE = BLOCK + 2
MIN_WALL_MATCH = 0.6                  # share of the run's walls that must land on stored walls
MAX_FREE_ON_WALL = 0.03               # share of the run's free floor that may land on stored walls

_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_lock = threading.Lock()


def _lock(serial: str, map_id: str) -> threading.Lock:
    with _locks_lock:
        return _locks.setdefault((serial, map_id), threading.Lock())


def _grid(meta: dict) -> np.ndarray:
    flat = np.concatenate([np.full(n, v, dtype=np.uint8) for v, n in meta["rle"]])
    return flat.reshape(meta["height"], meta["width"])


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


# ---- placing a run on the stored map (components/map/gen3Run.ts alignToStored) ----------------------
def _blocks(walls: np.ndarray, block: int) -> np.ndarray:
    """Which BLOCK-sized blocks hold a wall cell."""
    h, w = walls.shape
    hb, wb = math.ceil(h / block), math.ceil(w / block)
    padded = np.zeros((hb * block, wb * block), dtype=bool)
    padded[:h, :w] = walls
    return padded.reshape(hb, block, wb, block).any(axis=(1, 3))


def _grow(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= _shift(mask, dx, dy)
    return out


def _shift(mask: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """mask moved by (dx, dy), cut to its own size."""
    out = np.zeros_like(mask)
    h, w = mask.shape
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = mask[ys, xs]
    return out


def _coarse(run: np.ndarray, stored: np.ndarray) -> tuple[int, int]:
    """The block offset laying most of the run's wall blocks on stored wall blocks, over every overlap
    (all offsets at once, by FFT cross-correlation)."""
    hr, wr = run.shape
    hs, ws = stored.shape
    H, W = hs + hr, ws + wr
    a = np.zeros((H, W)); a[:hs, :ws] = stored
    b = np.zeros((H, W)); b[:hr, :wr] = run
    corr = np.real(np.fft.ifft2(np.fft.fft2(a) * np.conj(np.fft.fft2(b))))
    # corr[dy % H, dx % W] = hits of the run moved by (dx, dy); offsets from -size of the run to the stored size
    best, best_off = -1.0, (0, 0)
    for dy in range(-hr, hs + 1):
        row = corr[dy % H]
        for dx in (range(-wr, ws + 1)):
            v = row[dx % W]
            if v > best + 0.5:
                best, best_off = v, (dx, dy)
    return best_off


def _hits(points: tuple[np.ndarray, np.ndarray], target: np.ndarray, dx: int, dy: int) -> int:
    ys, xs = points[0] + dy, points[1] + dx
    ok = (ys >= 0) & (xs >= 0) & (ys < target.shape[0]) & (xs < target.shape[1])
    return int(target[ys[ok], xs[ok]].sum())


def align(run: np.ndarray, stored: np.ndarray) -> tuple[int, int] | None:
    """Where a run's grid lies in the stored map's grid (stored cell = run cell + offset), or None."""
    run_walls, stored_walls = run == WALL, stored == WALL
    if not run_walls.any():
        return None
    cdx, cdy = _coarse(_blocks(run_walls, BLOCK).astype(float), _blocks(stored_walls, BLOCK).astype(float))
    pts = np.nonzero(run_walls)
    best, off = -1, (0, 0)
    for dy in range(cdy * BLOCK - FINE_RANGE, cdy * BLOCK + FINE_RANGE + 1):
        for dx in range(cdx * BLOCK - FINE_RANGE, cdx * BLOCK + FINE_RANGE + 1):
            h = _hits(pts, stored_walls, dx, dy)
            if h > best:
                best, off = h, (dx, dy)
    return off if _fits(run, stored, *off) else None


def _fits(run: np.ndarray, stored: np.ndarray, dx: int, dy: int) -> bool:
    near = _grow(stored == WALL, 1)
    walls = np.nonzero(run == WALL)
    free = np.nonzero(run == FREE)
    n_walls, wall_hits = _count_in(walls, near, dx, dy)
    n_free, free_on_wall = _count_in(free, stored == WALL, dx, dy)
    return n_walls > 0 and wall_hits >= n_walls * MIN_WALL_MATCH and free_on_wall <= n_free * MAX_FREE_ON_WALL


def _count_in(points, target: np.ndarray, dx: int, dy: int) -> tuple[int, int]:
    """How many of the points land inside the target grid, and how many of those on a set cell."""
    ys, xs = points[0] + dy, points[1] + dx
    ok = (ys >= 0) & (xs >= 0) & (ys < target.shape[0]) & (xs < target.shape[1])
    return int(ok.sum()), int(target[ys[ok], xs[ok]].sum())


# ---- one run's cells --------------------------------------------------------------------------------
DISC = [(dx, dy) for dy in range(-math.ceil(ROBOT_RADIUS_CELLS), math.ceil(ROBOT_RADIUS_CELLS) + 1)
        for dx in range(-math.ceil(ROBOT_RADIUS_CELLS), math.ceil(ROBOT_RADIUS_CELLS) + 1)
        if dx * dx + dy * dy <= ROBOT_RADIUS_CELLS ** 2]


def _place(cells: np.ndarray, shape: tuple[int, int], dx: int, dy: int) -> np.ndarray:
    """A run-grid mask moved into the stored map's grid."""
    out = np.zeros(shape, dtype=bool)
    ys, xs = np.nonzero(cells)
    ys, xs = ys + dy, xs + dx
    ok = (ys >= 0) & (xs >= 0) & (ys < shape[0]) & (xs < shape[1])
    out[ys[ok], xs[ok]] = True
    return out


def _run_cells(serial: str, run_id: str, persistent_map: str | None, stored: np.ndarray,
               stored_dock: tuple[float, float] | None) -> tuple[np.ndarray, bool] | None:
    """The stored map's free cells a run cleaned and whether by its black box, or None if it doesn't
    lie on the map (or its files are missing)."""
    folder = MAPS_DIR / serial / run_id
    runmap_meta = _load_json(folder / "runmap.json")
    if not runmap_meta:
        return None
    runmap = _grid(runmap_meta)
    if persistent_map:
        floor_meta = _load_json(folder / "floormap.json")
        if not floor_meta:
            return None
        off = align(_grid(floor_meta), stored)
        if off is None:
            return None
    else:
        if runmap.shape != stored.shape:
            return None
        ys, xs = np.nonzero(runmap == RUN_DOCK)
        if stored_dock and len(ys):
            h, w = runmap.shape
            run_dock = ((xs.mean() + 0.5) / w, (ys.mean() + 0.5) / h)
            if math.hypot((run_dock[0] - stored_dock[0]) * w, (run_dock[1] - stored_dock[1]) * h) > SAME_FLOOR_CELLS:
                return None
        off = (0, 0)
    dx, dy = off
    floor = stored == FREE
    cov = (_load_json(folder / "track.json") or {}).get("coverage") or {}
    if cov.get("cleaned") and cov.get("width") == runmap.shape[1]:
        flat = np.concatenate([np.full(n, v, dtype=np.uint8) for v, n in cov["cleaned"]])
        if flat.size == runmap.size:
            return _place(flat.reshape(runmap.shape) == 1, stored.shape, dx, dy) & floor, True
    path = (runmap != 0) & ~np.isin(runmap, RUN_NOT_PATH)
    centre = _place(path, stored.shape, dx, dy)
    wide = np.zeros_like(centre)
    for ox, oy in DISC:
        wide |= _shift(centre, ox, oy)
    return wide & floor, False


# ---- the map's store --------------------------------------------------------------------------------
def _store_path(serial: str, map_id: str) -> Path:
    return STORE / serial / f"{map_id.replace(':', '-')}.npz"


def _load_store(path: Path, shape: tuple[int, int]) -> dict:
    """{"runs": {run_id: (start, black_box, packed cells)}, "off": set of run ids not on the map}"""
    empty = {"runs": {}, "off": set()}
    if not path.is_file():
        return empty
    try:
        with np.load(path) as z:
            meta = json.loads(z["meta"].tobytes())
            if tuple(meta["shape"]) != shape:
                return empty  # the stored map changed size: start over
            packed = z["packed"]
        runs = {r: (start, bb, packed[i]) for i, (r, start, bb) in enumerate(meta["runs"])}
        return {"runs": runs, "off": set(meta["off"])}
    except Exception as e:
        logger.info("Coverage store %s not readable (%s): starting over", path, e)
        return empty


def _save_store(path: Path, shape: tuple[int, int], store: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ids = list(store["runs"])
    meta = {"shape": list(shape), "runs": [[r, store["runs"][r][0], store["runs"][r][1]] for r in ids],
            "off": sorted(store["off"])}
    packed = np.array([store["runs"][r][2] for r in ids], dtype=np.uint8) if ids else np.zeros((0, 0), np.uint8)
    np.savez_compressed(path, packed=packed, meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))


def update(serial: str, map_id: str) -> tuple[np.ndarray, dict] | None:
    """Work out the runs of the map not seen yet and keep them. The stored map's grid and the store."""
    stored_meta = _load_json(MAPS_DIR / serial / map_id / "floormap.json")
    if not stored_meta:
        return None
    stored = _grid(stored_meta)
    with get_session() as db:
        pm = db.get(PersistentMap, map_id)
        rows = db.execute(select(Gen3__Run.id, Gen3__Run.run).where(Gen3__Run.robot == serial)).all()
    base = pm.base if pm is not None else None
    stored_dock = (float(base[0]), float(base[1])) if isinstance(base, (list, tuple)) and len(base) >= 2 else None
    path = _store_path(serial, map_id)
    with _lock(serial, map_id):
        store = _load_store(path, stored.shape)
        new = 0
        for run_id, run in rows:
            named = (run or {}).get("persistent_map_id")  # as the app: the id the run itself names
            if named and named != map_id:
                continue
            if run_id in store["runs"] or run_id in store["off"]:
                continue
            if not (MAPS_DIR / serial / run_id / "runmap.json").is_file():
                continue  # its maps are not here (yet): not decided
            got = _run_cells(serial, run_id, (run or {}).get("persistent_map_id"), stored, stored_dock)
            if got is None:
                store["off"].add(run_id)
            else:
                cells, bb = got
                store["runs"][run_id] = ((run or {}).get("start_at") or run_id, bb, np.packbits(cells.ravel()))
            new += 1
        if new:
            _save_store(path, stored.shape, store)
            logger.info("Coverage of %s, map %s: %d runs worked out, %d on the map", serial, map_id, new,
                        len(store["runs"]))
    return stored, store


def heatmap(serial: str, map_id: str, last: int) -> dict | None:
    """In how many of the map's last `last` runs each cell was cleaned, as RLE over the stored map
    ([value, count]), with the number of runs and how many of them by their black box."""
    got = update(serial, map_id)
    if got is None:
        return None
    stored, store = got
    newest = sorted(store["runs"].items(), key=lambda kv: kv[1][0], reverse=True)[:max(1, last)]
    counts = np.zeros(stored.size, dtype=np.uint16)
    for _, (_, _, packed) in newest:
        counts += np.unpackbits(packed, count=stored.size).astype(np.uint16)
    change = np.flatnonzero(np.diff(counts)) + 1
    starts = np.concatenate([[0], change])
    lengths = np.diff(np.concatenate([starts, [counts.size]]))
    return {"width": int(stored.shape[1]), "height": int(stored.shape[0]), "runs": len(newest),
            "blackBoxRuns": int(sum(1 for _, (_, bb, _) in newest if bb)),
            "counts": [[int(counts[s]), int(n)] for s, n in zip(starts, lengths)]}


def update_later(serial: str, map_id: str | None) -> None:
    """After a run of the map came in: work it out in the background."""
    if not map_id:
        return
    threading.Thread(target=lambda: _safe_update(serial, map_id), name="coverage-map", daemon=True).start()


def _safe_update(serial: str, map_id: str) -> None:
    try:
        update(serial, map_id)
    except Exception:
        logger.exception("Coverage of %s, map %s not worked out", serial, map_id)
