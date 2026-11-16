"""What a gen3 robot's lidar sees, from its black box (packet type 27, "LDSPkt"; D7 firmware 4.5.3-189).

One packet per turn of the lidar, 5 a second: 360 x (distance u16 in mm, signal strength u16), one per
degree counter-clockwise (the same way as the heading of the Coords packets), degree 0 straight ahead.
A distance with its top bit set is no reading (the low bits are an error code). 6 bytes follow
("5a a5 00 c0" and two more).

Checked on a D7 on 2026-11-14 against 221 turns on the spot (the scan turns by the robot's turn), 639
straight drives (the distance ahead shrinks by the way driven, to 0.4 mm in the median) and its stored
map: 69 % of the points lie on the map's walls (21 % by chance) with the lidar LIDAR_BEHIND_MM behind
the robot's position and the turn's time LIDAR_LAG_S before the packet's clock.

A Run collects the scans of one clean into a grid of CELL_MM cells in the robot's own frame (mm, y up):
how often each cell was hit (something stands there) and how often a beam went through it (free).
It needs no stored map; with one, the robot's frame is the map's (live_position's calibration).
"""
from __future__ import annotations

import base64
import io
import json
import math
from collections import deque

import numpy as np
from PIL import Image

PKT_LDS = 27
LDS_BYTES = 1446
UNITS_PER_MM = 525_000 / 40   # Coords units (live_position.UNITS_PER_CELL per 40 mm map cell)
CLOCK_HZ = 24_000_000
LIDAR_BEHIND_MM = 110
LIDAR_LAG_S = 0.15
MIN_MM, MAX_MM = 150, 6000    # closer is the robot itself, farther is too vague to place

CELL_MM = 20
GRID_CELLS = 1500             # 30 m square, centred where the first scan was taken
HIT_MIN = 2                   # a cell counts as something standing there after this many hits ...
HIT_SHARE = 0.3               # ... if at least this share of the beams that reached it stopped there
PNG_FREE, PNG_HIT = 128, 255  # grey values in the grid's PNG (0: not seen)
POSES_KEPT = 64               # Coords come 10 a second: 6 s to look back in


def ranges(data: bytes) -> np.ndarray | None:
    """The 360 distances of an LDSPkt in mm, NaN where there is no reading."""
    if len(data) < 1440:
        return None
    d = np.frombuffer(data[:1440], dtype="<u2").reshape(360, 2)[:, 0].astype(np.float32)
    d[d >= 0x8000] = np.nan
    return d


ANGLES = np.radians(np.arange(360, dtype=np.float32))


class Run:
    """The lidar of one clean: the robot's poses (to place each turn where it was taken), the last
    scan, and the grid of everything seen."""

    def __init__(self) -> None:
        self.poses: deque[tuple[float, float, float, float]] = deque(maxlen=POSES_KEPT)  # (s, x mm, y mm, heading)
        self._clock_last: int | None = None
        self._clock_wraps = 0
        self.hits: np.ndarray | None = None
        self.free: np.ndarray | None = None
        self.centre: tuple[float, float] = (0.0, 0.0)  # mm at the grid's middle
        self.box: list[int] | None = None              # rows and columns seen so far: [r0, r1, c0, c1)
        self.last: dict | None = None                  # {"t", "pose": [x, y, heading deg], "pts": [[x, y], ...]} mm
        self.scans = 0
        self.version = 0                               # grows with every scan added

    # the black box clock is u32 at 24 MHz: it wraps every 179 s
    def _seconds(self, clock: int) -> float:
        if self._clock_last is not None and clock < self._clock_last - (1 << 31):
            self._clock_wraps += 1
        self._clock_last = clock
        return (clock + (self._clock_wraps << 32)) / CLOCK_HZ

    def pose(self, clock: int, x_units: float, y_units: float, heading: float) -> None:
        """A Coords packet: the robot's position (its units) and heading (radians, counter-clockwise)."""
        self.poses.append((self._seconds(clock), x_units / UNITS_PER_MM, y_units / UNITS_PER_MM, heading))

    def _pose_at(self, s: float) -> tuple[float, float, float] | None:
        """Where the robot was at `s`, between the two poses around it."""
        if not self.poses or s < self.poses[0][0] - 0.5 or s > self.poses[-1][0] + 0.5:
            return None
        prev = self.poses[0]
        for p in self.poses:
            if p[0] >= s:
                if p is prev or p[0] == prev[0]:
                    return p[1:]
                f = (s - prev[0]) / (p[0] - prev[0])
                dh = (p[3] - prev[3] + math.pi) % (2 * math.pi) - math.pi
                return prev[1] + (p[1] - prev[1]) * f, prev[2] + (p[2] - prev[2]) * f, prev[3] + dh * f
            prev = p
        return self.poses[-1][1:]

    def scan(self, clock: int, data: bytes) -> bool:
        """An LDSPkt: placed where the robot was when it was taken, kept as the last scan and added to
        the grid. False if it could not be placed (no pose around it yet)."""
        d = ranges(data)
        if d is None:
            return False
        pose = self._pose_at(self._seconds(clock) - LIDAR_LAG_S)
        if pose is None:
            return False
        x, y, h = pose
        ok = (d > MIN_MM) & (d < MAX_MM)
        if not ok.any():
            return False
        # the lidar sits behind the robot's position
        lx, ly = x - LIDAR_BEHIND_MM * math.cos(h), y - LIDAR_BEHIND_MM * math.sin(h)
        a = h + ANGLES[ok]
        px, py = lx + d[ok] * np.cos(a), ly + d[ok] * np.sin(a)
        self.last = {"pose": [round(x), round(y), round(math.degrees(h) % 360, 1)],
                     "pts": np.stack([px, py], 1).round().astype(int).tolist()}
        self._add(lx, ly, px, py)
        self.scans += 1
        self.version += 1
        return True

    def _cells(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Grid columns and rows (row 0 at the top: y up becomes down)."""
        half = GRID_CELLS // 2
        c = np.floor((x - self.centre[0]) / CELL_MM).astype(np.int64) + half
        r = half - 1 - np.floor((y - self.centre[1]) / CELL_MM).astype(np.int64)
        return c, r

    def _add(self, lx: float, ly: float, px: np.ndarray, py: np.ndarray) -> None:
        if self.hits is None:
            self.centre = (lx, ly)
            self.hits = np.zeros((GRID_CELLS, GRID_CELLS), dtype=np.uint16)
            self.free = np.zeros((GRID_CELLS, GRID_CELLS), dtype=np.uint16)
        # free: points along each beam every cell, up to one cell short of where it stopped
        lengths = np.hypot(px - lx, py - ly)
        steps = np.maximum(0, (lengths // CELL_MM).astype(np.int64) - 1)
        if steps.sum():
            beam = np.repeat(np.arange(len(px)), steps)
            k = np.arange(steps.sum()) - np.repeat(np.cumsum(steps) - steps, steps) + 0.5
            f = (k * CELL_MM) / lengths[beam]
            self._count(self.free, lx + (px[beam] - lx) * f, ly + (py[beam] - ly) * f)
        self._count(self.hits, px, py)

    def _count(self, grid: np.ndarray, x: np.ndarray, y: np.ndarray) -> None:
        c, r = self._cells(x, y)
        inside = (c >= 0) & (c < GRID_CELLS) & (r >= 0) & (r < GRID_CELLS)
        r, c = r[inside], c[inside]
        if not len(r):
            return
        lo_r, hi_r, lo_c, hi_c = int(r.min()), int(r.max()) + 1, int(c.min()), int(c.max()) + 1
        b = self.box
        self.box = [lo_r, hi_r, lo_c, hi_c] if b is None else [min(b[0], lo_r), max(b[1], hi_r), min(b[2], lo_c), max(b[3], hi_c)]
        flat = np.unique(r * GRID_CELLS + c)  # once per scan and cell
        g = grid.reshape(-1)
        g[flat] = np.minimum(g[flat].astype(np.uint32) + 1, 65535).astype(np.uint16)

    def picture(self) -> dict | None:
        """The grid as seen so far, cropped to what was seen (see grid_picture)."""
        if self.hits is None or self.box is None:
            return None
        hits, free, x0, y0 = self._crop()
        return grid_picture(hits, free, x0, y0)

    def _crop(self) -> tuple[np.ndarray, np.ndarray, int, int]:
        """The seen part of the grid and where its top left corner lies (mm, robot frame)."""
        r0, r1, c0, c1 = self.box
        half = GRID_CELLS // 2
        return (self.hits[r0:r1, c0:c1], self.free[r0:r1, c0:c1],
                round(self.centre[0] + (c0 - half) * CELL_MM), round(self.centre[1] + (half - r0) * CELL_MM))

    def save(self, path, track: list[list[int]], map_info: dict | None) -> bool:
        """The run's grid (the counts, so runs can be put together later), its way (mm) and the stored map
        its frame lay on, as one compressed file. False if nothing was seen."""
        if self.hits is None or self.box is None or not self.last:
            return False
        hits, free, x0, y0 = self._crop()
        meta = {"x0": x0, "y0": y0, "cell": CELL_MM, "pose": self.last["pose"], "map": map_info, "scans": self.scans}
        np.savez_compressed(path, hits=hits, free=free, track=np.array(track, dtype=np.int32).reshape(-1, 2),
                            meta=np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8))
        return True


def load(path) -> dict:
    """A saved run (Run.save) in the shape of the live view: grid picture, pose, way and map."""
    with np.load(path) as f:
        meta = json.loads(f["meta"].tobytes())
        return {"running": False, "map": meta.get("map"), "pose": meta["pose"], "scans": meta.get("scans"),
                "grid": grid_picture(f["hits"], f["free"], meta["x0"], meta["y0"]), "track": f["track"].tolist()}


def grid_picture(hits: np.ndarray, free: np.ndarray, x0: int, y0: int) -> dict:
    """A grid of counts as a grey PNG of 0 unknown, PNG_FREE free, PNG_HIT something there, with where
    its top left corner lies (mm, robot frame) and the cell size."""
    hits = hits.astype(np.float32)
    free = free.astype(np.float32)
    # far apart, so a browser's colour handling of the PNG can't turn one into the other
    img = np.zeros(hits.shape, dtype=np.uint8)
    img[free > 0] = PNG_FREE
    img[(hits >= HIT_MIN) & (hits >= HIT_SHARE * (hits + free))] = PNG_HIT
    buf = io.BytesIO()
    Image.fromarray(img, mode="L").save(buf, format="PNG", compress_level=6)
    return {"png": base64.b64encode(buf.getvalue()).decode(), "x0": int(x0), "y0": int(y0), "cell": CELL_MM,
            "width": int(img.shape[1]), "height": int(img.shape[0])}
