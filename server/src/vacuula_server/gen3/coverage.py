"""How much of the floor a gen3 run cleaned, from its track (gen3/live_position.py) and its map.

Cleaned: the cells the track passes with the cleaning width (the main brush, CLEANING_WIDTH_MM) around
it. Missed: free floor of the area that none of that reached. The area is the run's zone when it
cleaned one, else all free floor of the run's map. Free cells next to a wall are left out: the robot's
round body keeps its brush away from them, on every run alike.
"""
from __future__ import annotations

import numpy as np

CLEANING_WIDTH_MM = 270   # D7 main brush; an assumption, to be adjusted against what looks missed
MM_PER_CELL = 40          # gen3 map cell (as the app assumes; not verified exactly)
FREE, WALL = 1, 2


def _disc(radius: float) -> np.ndarray:
    r = int(np.ceil(radius))
    dy, dx = np.mgrid[-r:r + 1, -r:r + 1]
    keep = dx * dx + dy * dy <= radius * radius
    return np.stack([dy[keep], dx[keep]], axis=1)


def _covered(shape: tuple[int, int], track: list[list[float]], radius: float) -> np.ndarray:
    """Cells within `radius` of the track (a line through the points)."""
    h, w = shape
    pts = np.asarray(track, dtype=float)
    # points along every segment at most half a cell apart, so the band has no gaps
    samples = [pts[:1]]
    for a, b in zip(pts[:-1], pts[1:]):
        n = max(1, int(np.ceil(np.hypot(*(b - a)) / 0.5)))
        samples.append(a + (b - a) * (np.arange(1, n + 1)[:, None] / n))
    s = np.rint(np.concatenate(samples)).astype(int)
    s = np.unique(s, axis=0)
    disc = _disc(radius)
    cells = (s[:, None, ::-1] + disc[None, :, :]).reshape(-1, 2)  # (v, u) + (dy, dx)
    ok = (cells[:, 0] >= 0) & (cells[:, 0] < h) & (cells[:, 1] >= 0) & (cells[:, 1] < w)
    covered = np.zeros(shape, dtype=bool)
    covered[cells[ok, 0], cells[ok, 1]] = True
    return covered


def _inside(shape: tuple[int, int], polygon: list[list[float]]) -> np.ndarray:
    """Cells whose centre lies inside the polygon (cell coordinates)."""
    h, w = shape
    v, u = np.mgrid[0:h, 0:w]
    x, y = u + 0.5, v + 0.5
    inside = np.zeros(shape, dtype=bool)
    poly = np.asarray(polygon, dtype=float)
    for (x0, y0), (x1, y1) in zip(poly, np.roll(poly, -1, axis=0)):
        crosses = (y0 > y) != (y1 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xi = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        inside ^= crosses & (x < xi)
    return inside


def _rle(mask: np.ndarray) -> list[list[int]]:
    flat = mask.astype(np.uint8).ravel()
    edges = np.flatnonzero(np.diff(flat)) + 1
    starts = np.concatenate([[0], edges])
    lengths = np.diff(np.concatenate([starts, [flat.size]]))
    return [[int(flat[s]), int(n)] for s, n in zip(starts, lengths)]


def measure(floor: np.ndarray, track: list[list[float]], zone: list[list[float]] | None = None) -> dict | None:
    """Cleaned share of the area (`zone` in cells of `floor`, else all free floor), and the missed cells
    as RLE over the grid. None without a usable area or track."""
    if len(track) < 2:
        return None
    free = floor == FREE
    wall_near = np.zeros_like(free)
    walls = floor == WALL
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            wall_near |= np.roll(np.roll(walls, dy, axis=0), dx, axis=1)
    area = free & ~wall_near
    if zone:
        area &= _inside(floor.shape, zone)
    total = int(area.sum())
    if total == 0:
        return None
    covered = _covered(floor.shape, track, CLEANING_WIDTH_MM / 2 / MM_PER_CELL)
    cleaned = int((area & covered).sum())
    missed = area & ~covered
    cell_m2 = (MM_PER_CELL / 1000) ** 2
    return {
        "percent": round(100 * cleaned / total, 1),
        "areaM2": round(total * cell_m2, 2),
        "missedM2": round(int(missed.sum()) * cell_m2, 2),
        "zone": bool(zone),
        "width": int(floor.shape[1]),
        "height": int(floor.shape[0]),
        "missed": _rle(missed),
    }
