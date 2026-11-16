"""Short ids for gen3 zones and no-go lines: the robot keeps the short form, the app sees the real one.

The D7 answers every save with all zones and lines of the map, and if that answer passes ~2044
bytes it hangs up (sb1) or stops answering (huugo, 4.6.0). Most of the answer is not geometry: a
36-character uuid per feature, its name and its colour. So the robot only gets a short id ("a", "b",
... "ba"), an empty name and an empty colour (the `color` field itself is required), coordinates to 3
decimals; the real id, name and colour stay here and are put back into everything the robot sends.
Measured on huugo 2026-11-15: its map's answer went from 1928 to ~1400 bytes.

Short ids belong to one robot and are never reused, so a run, a schedule or a queue that holds a
real id always finds its zone. Features saved before this keep their uuid on the robot until the
next save; ids the table does not know pass through unchanged both ways.

A short id is used in a start or a schedule only once the robot has it (`on_robot`: it came back in
the robot's answer to a save). Until then the real id goes out, which is what the robot still
keeps. (2026-11-16: a Pi schedule started sb1's zones with short ids made up at the start, ids the
robot did not know, and it answered nav_floorplan_zone_wrong_floor.)
"""
from __future__ import annotations

import json
import logging
import os
import threading

from vacuula_server.constants import DATA_DIR

logger = logging.getLogger(__name__)

FILE = DATA_DIR / "boundary_aliases.json"
# the robot's answer to a save must stay at or below this (measured: 2044 OK on sb1 with a 4-digit
# reqId, 2045 OK on huugo with a 3-digit one; one more hangs up)
REPLY_LIMIT = 2044
# {"version":1,"reqId":"1234","result":"ok","data": {"boundaries": [...]}} around the list
REPLY_ENVELOPE = 67

_lock = threading.Lock()
# serial -> {"next": int, "ids": {short: {"id", "name", "color"}}}
_data: dict | None = None
# serial -> {real id: short}
_reverse: dict[str, dict[str, str]] = {}


def _load() -> dict:
    global _data
    if _data is None:
        try:
            _data = json.loads(FILE.read_text())
        except FileNotFoundError:
            _data = {}
        except ValueError:
            logger.error("%s is not readable JSON, starting a new one (old file kept as .broken)", FILE)
            FILE.replace(FILE.with_suffix(".broken"))
            _data = {}
        for serial, robot in _data.items():
            for v in robot["ids"].values():
                # from before `on_robot`: only a save gave a colour, and every save then went through
                v.setdefault("on_robot", bool(v.get("color")))
            _reverse[serial] = {v["id"]: short for short, v in robot["ids"].items()}
    return _data


def _save() -> None:
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_data, ensure_ascii=False))
    os.replace(tmp, FILE)


def _short_name(n: int) -> str:
    """0 -> "a", 25 -> "z", 26 -> "ba", ... (letters only)."""
    out = ""
    while True:
        out = chr(97 + n % 26) + out
        n //= 26
        if n == 0:
            return out


def _robot(serial: str) -> dict:
    return _load().setdefault(serial, {"next": 0, "ids": {}})


def _short_for(serial: str, real: str, name: str | None = None, color: str | None = None) -> tuple[str, bool]:
    """The short id of `real` (a new one if it has none); (short, table changed). Name and colour are
    kept when given."""
    robot = _robot(serial)
    rev = _reverse.setdefault(serial, {})
    short = rev.get(real)
    changed = False
    if short is None:
        if real in robot["ids"]:  # already a short id (sent back by an app that saw the robot's form)
            return real, False
        short = _short_name(robot["next"])
        while short in robot["ids"]:
            robot["next"] += 1
            short = _short_name(robot["next"])
        robot["next"] += 1
        robot["ids"][short] = {"id": real, "name": "", "color": "", "on_robot": False}
        rev[real] = short
        changed = True
    meta = robot["ids"][short]
    for key, value in (("name", name), ("color", color)):
        if value is not None and meta.get(key) != value:
            meta[key] = value
            changed = True
    return short, changed


def _on_robot(serial: str, real: str) -> str:
    """The id the robot keeps for `real`: its short id once the robot has it, else `real` itself."""
    short = _reverse.get(serial, {}).get(real)
    return short if short is not None and _robot(serial)["ids"][short].get("on_robot") else real


def _round3(points):
    return [[round(float(x), 3), round(float(y), 3)] for x, y in points]


# ---- to the robot --------------------------------------------------------------------------------
def to_robot(serial: str, cmd: dict) -> dict:
    """`cmd` as the robot should get it (a copy when something changed)."""
    name = cmd.get("cmd")
    params = cmd.get("params")
    if not isinstance(params, dict) or name not in ("setMapBoundaries", "startCleaning", "setSchedule"):
        return cmd
    params = json.loads(json.dumps(params))
    with _lock:
        changed = False
        if name == "setMapBoundaries":
            for b in params.get("boundaries") or []:
                if not isinstance(b, dict) or not b.get("id"):
                    continue
                b["id"], c = _short_for(serial, str(b["id"]), str(b.get("name") or ""), str(b.get("color") or ""))
                changed |= c
                b["name"], b["color"] = "", ""
                if isinstance(b.get("vertices"), list):
                    b["vertices"] = _round3(b["vertices"])
                if isinstance(b.get("relevancy"), list) and len(b["relevancy"]) == 2:
                    b["relevancy"] = [round(float(v), 3) for v in b["relevancy"]]
        elif name == "startCleaning":
            _load()
            if params.get("boundaryId"):
                params["boundaryId"] = _on_robot(serial, str(params["boundaryId"]))
            if isinstance(params.get("boundaryIds"), list):
                params["boundaryIds"] = [_on_robot(serial, str(real)) for real in params["boundaryIds"]]
        else:  # setSchedule
            _load()
            for e in params.get("events") or []:
                if isinstance(e, dict) and e.get("boundaryId"):
                    e["boundaryId"] = _on_robot(serial, str(e["boundaryId"]))
        if changed:
            _save()
    return {**cmd, "params": params}


def reply_bytes(boundaries: list) -> int:
    """Bytes of the robot's answer to saving `boundaries` (already in the robot's form): compact JSON
    of the fields it keeps, a space after "vertices": for each one, and the envelope."""
    echo = [{"id": b.get("id"), "type": b.get("type"), "vertices": b.get("vertices"), "name": b.get("name"),
             "color": b.get("color"), "enabled": False} for b in boundaries if isinstance(b, dict)]
    return REPLY_ENVELOPE + len(json.dumps(echo, separators=(",", ":"), ensure_ascii=False).encode()) + len(echo)


def too_big(serial: str, cmd: dict) -> int | None:
    """The predicted answer size when the setMapBoundaries `cmd` (app form) would pass the limit once
    shortened, else None. Changes nothing: a new feature is counted with a 3-letter id."""
    if cmd.get("cmd") != "setMapBoundaries":
        return None
    with _lock:
        _load()
        rev = _reverse.get(serial, {})
        robot = [{**b, "id": rev.get(str(b.get("id")), "aaa"), "name": "", "color": "",
                  "vertices": _round3(b.get("vertices") or [])}
                 for b in (cmd.get("params") or {}).get("boundaries") or [] if isinstance(b, dict)]
    size = reply_bytes(robot)
    return size if size > REPLY_LIMIT else None


# ---- from the robot ------------------------------------------------------------------------------
def from_robot(serial: str, msg: dict) -> bool:
    """Put real ids, names and colours back into a message from the robot, in place; True if changed.
    A short id in the robot's list of zones and lines marks it as kept by the robot."""
    with _lock:
        robot = _load().get(serial)
        if not robot or not robot["ids"]:
            return False
        confirmed: list[str] = []
        changed = _restore(robot["ids"], msg, confirmed)
        new = [s for s in confirmed if not robot["ids"][s].get("on_robot")]
        for s in new:
            robot["ids"][s]["on_robot"] = True
        if new:
            _save()
        return changed


def _restore(ids: dict, node, confirmed: list[str]) -> bool:
    changed = False
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "boundaryId" and isinstance(value, str) and value in ids:
                node[key] = ids[value]["id"]
                changed = True
            elif key == "boundaryIds" and isinstance(value, list):
                new = [ids[v]["id"] if isinstance(v, str) and v in ids else v for v in value]
                if new != value:
                    node[key], changed = new, True
            elif key == "boundary" and isinstance(value, dict):
                changed |= _restore_feature(ids, value)
            elif key == "boundaries" and isinstance(value, list):
                for b in value:
                    if isinstance(b, dict):
                        if isinstance(b.get("id"), str) and b["id"] in ids:
                            confirmed.append(b["id"])
                        changed |= _restore_feature(ids, b)
            elif isinstance(value, (dict, list)):
                changed |= _restore(ids, value, confirmed)
    elif isinstance(node, list):
        for item in node:
            changed |= _restore(ids, item, confirmed)
    return changed


def _restore_feature(ids: dict, b: dict) -> bool:
    meta = ids.get(b.get("id")) if isinstance(b.get("id"), str) else None
    if meta is None:
        return False
    b["id"] = meta["id"]
    if "name" in b or meta.get("name"):
        b["name"] = meta.get("name", "")
    if "color" in b:
        b["color"] = meta.get("color", "")
    return True
