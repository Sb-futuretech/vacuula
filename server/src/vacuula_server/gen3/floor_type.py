"""Floor type on a gen3 robot's map, from the brush load in its black box (gen3/live_position.py).

Field 17 of the black box's motor packet (type 44) rises with the floor's resistance at the same brush
speed (field 18). Measured on a D7 (2026-11-08): hard floor about 16,700, a low runner about 42,000,
a high pile carpet about 74,000. Every run adds its samples to its map, so the picture grows with the
runs that pass a place; a cell shows what most of its samples say.

Connected carpet areas of at least MIN_PATCH_M2 come with a rectangle around them, as a zone to offer.
"""
from __future__ import annotations

import json
import logging
import threading

from vacuula_server.constants import DATA_DIR

logger = logging.getLogger(__name__)

PKT_MOTORS = 44
LOAD_FIELD, BRUSH_RPM_FIELD = 17, 18   # int32 fields of the motor packet
HARD, LOW, HIGH = 1, 2, 3
LOW_FROM, HIGH_FROM = 25_000, 55_000   # brush load: runner from, high pile from
# where the brush acts: about 10 cm ahead of the robot's centre (from edge crossings on a D7: the load
# changes ~20 cm later leaving a carpet than entering it at the same edge, motor lag included)
BRUSH_AHEAD_CELLS = 2.5
BRUSH_SIDE_CELLS = 1.5    # each sample counts across the brush this far to either side (about 6 cm of its 13.5)
CLOSE_CELLS = 5            # gaps between lanes up to this wide are filled (not where hard floor was measured)
CELL_M2 = 0.04 * 0.04
MIN_PATCH_M2 = 0.5
FLOOR_FILE = DATA_DIR / "live_floor.json"

_lock = threading.Lock()


def sample(packet: bytes) -> int | None:
    """The brush load of one motor packet, None while the brush stands."""
    if len(packet) < 4 * (BRUSH_RPM_FIELD + 1):
        return None
    load = int.from_bytes(packet[4 * LOAD_FIELD:4 * LOAD_FIELD + 4], "little", signed=True)
    rpm = int.from_bytes(packet[4 * BRUSH_RPM_FIELD:4 * BRUSH_RPM_FIELD + 4], "little", signed=True)
    return load if rpm > 0 else None


def kind(load: int) -> int:
    return HIGH if load >= HIGH_FROM else LOW if load >= LOW_FROM else HARD


def _load_file() -> dict:
    try:
        return json.loads(FLOOR_FILE.read_text())
    except (OSError, ValueError):
        return {}


def add_run(serial: str, map_id: str, samples: list[tuple[float, float, int, float, float]]) -> None:
    """A run's samples (map cells u, v where the brush was, brush load, and the unit vector across the
    brush in cells) onto its map's counts: per cell [hard, low, high]."""
    if not samples:
        return
    per_run: dict[tuple[int, int], list[int]] = {}
    for u, v, load, side_u, side_v in samples:
        k = kind(load) - 1
        # a short line across the brush (side_u, side_v: unit vector to its side, in cells)
        steps = int(BRUSH_SIDE_CELLS * 2)
        cells = {(round(u + side_u * BRUSH_SIDE_CELLS * i / steps), round(v + side_v * BRUSH_SIDE_CELLS * i / steps))
                 for i in range(-steps, steps + 1)}
        for c in cells:
            per_run.setdefault(c, [0, 0, 0])[k] += 1
    with _lock:
        data = _load_file()
        cells = data.setdefault(serial, {}).setdefault(map_id, {})
        for (u, v), counts in per_run.items():
            # each run counts once per cell: what most of its samples there said
            c = cells.setdefault(f"{u},{v}", [0, 0, 0])
            c[max(range(3), key=lambda i: counts[i])] += 1
        FLOOR_FILE.write_text(json.dumps(data))
    logger.info("Floor type of %s: %d samples of this run added to map %s", serial, len(samples), map_id)


def _patches(cells: dict[tuple[int, int], int]) -> list[dict]:
    """Connected areas of carpet (high pile, and runner or more) with a rectangle around each."""
    out = []
    for name, wanted in (("high", {HIGH}), ("runner", {LOW})):
        left = {c for c, k in cells.items() if k in wanted}
        while left:
            start = left.pop()
            comp, todo = {start}, [start]
            while todo:
                u, v = todo.pop()
                for n in ((u + 1, v), (u - 1, v), (u, v + 1), (u, v - 1)):
                    if n in left:
                        left.remove(n)
                        comp.add(n)
                        todo.append(n)
            if len(comp) * CELL_M2 < MIN_PATCH_M2:
                continue
            us = [c[0] for c in comp]
            vs = [c[1] for c in comp]
            u0, u1, v0, v1 = min(us), max(us) + 1, min(vs), max(vs) + 1
            box = (u1 - u0) * (v1 - v0)
            out.append({
                "kind": name,
                "areaM2": round(len(comp) * CELL_M2, 2),
                "share": round(len(comp) / box, 2),   # how much of the rectangle is this floor
                "rect": [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
            })
    return sorted(out, key=lambda p: -p["areaM2"])


def _close(cells: dict[tuple[int, int], int]) -> dict[tuple[int, int], int]:
    """Fill the unmeasured gaps between the lanes inside carpet areas: an unmeasured cell takes the
    carpet kind if that kind lies within CLOSE_CELLS on both sides of it, across or along. Measured
    cells, hard floor included, stay as they are, so a carpet doesn't grow past its edges."""
    out = dict(cells)
    us = [c[0] for c in cells] or [0]
    vs = [c[1] for c in cells] or [0]
    for u in range(min(us), max(us) + 1):
        for v in range(min(vs), max(vs) + 1):
            if (u, v) in cells:
                continue
            for k in (HIGH, LOW):
                def seen(du: int, dv: int) -> bool:
                    return any(cells.get((u + du * i, v + dv * i)) == k for i in range(1, CLOSE_CELLS + 1))
                if (seen(1, 0) and seen(-1, 0)) or (seen(0, 1) and seen(0, -1)):
                    out[(u, v)] = k
                    break
    return out


def floor(serial: str, map_id: str) -> dict:
    """Per cell of the map its floor type ([u, v, kind], kind 1 hard, 2 runner, 3 high pile), and the
    carpet areas to offer as zones."""
    with _lock:
        stored = _load_file().get(serial, {}).get(map_id, {})
    measured = {}
    for key, counts in stored.items():
        u, v = (int(x) for x in key.split(","))
        measured[(u, v)] = max(range(3), key=lambda i: counts[i]) + 1
    cells = _close(measured)
    return {
        "cells": [[u, v, k] for (u, v), k in cells.items()],
        "patches": _patches(cells),
    }
