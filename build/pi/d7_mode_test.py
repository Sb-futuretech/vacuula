#!/usr/bin/env python3
"""Which mode / navigation combinations does the D7 take for spot and zone cleaning?

Runs on the Pi, talks to Vacuula on localhost. For each combination: start, wait, read what the
robot reports, stop, send it home and wait until it is docked again. Only numbers are printed.

    python3 d7_mode_test.py                 # zone "Test1", spot 100x100 cm
    python3 d7_mode_test.py --zone Kueche   # another zone (name as in the app)
    python3 d7_mode_test.py --only spot     # just the spot part (or: --only zone)
"""
import argparse
import json
import time
import urllib.request

SERIAL = "GPC43118-40bd32e27da1"
URL = f"http://localhost/api/robot/{SERIAL}/command"
MODES = {1: "Eco", 2: "Normal"}
NAVS = {1: "Normal", 2: "Extra Care", 3: "Deep"}
RUN_S = 20          # how long each combination runs before it is checked
DOCK_TIMEOUT_S = 240


def cmd(c: dict) -> dict:
    req = urllib.request.Request(URL, data=json.dumps(c).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"result": f"http {e.code}"}


def state() -> dict:
    return cmd({"cmd": "getRobotState"})


def wait_docked() -> bool:
    end = time.time() + DOCK_TIMEOUT_S
    while time.time() < end:
        s = state()
        if s.get("state") == 1 and (s.get("details") or {}).get("isDocked"):
            return True
        time.sleep(5)
    return False


def find_zone(name: str):
    maps = json.loads(urllib.request.urlopen(f"http://localhost/api/robot/{SERIAL}/maps").read())
    for m in maps:
        if not m.get("enabled"):
            continue
        b = cmd({"cmd": "getMapBoundaries", "params": {"mapId": m["id"]}})
        for z in (b.get("data") or {}).get("boundaries", []):
            if z.get("type") == "polygon" and z.get("name", "").lower() == name.lower():
                return m["id"], z["id"]
    return None


def run(label: str, params: dict) -> dict:
    print(f"\n== {label}")
    if not wait_docked():
        return {"label": label, "start": "robot not docked/idle, skipped"}
    reply = cmd({"cmd": "startCleaning", "params": params})
    result = reply.get("result")
    print(f"   start: {result}")
    row = {"label": label, "start": result, "mode": "-", "nav": "-", "alert": reply.get("alert") or "-"}
    if result != "ok":
        return row
    time.sleep(RUN_S)
    s = state()
    c = s.get("cleaning") or {}
    row.update(mode=MODES.get(c.get("mode"), c.get("mode")), nav=NAVS.get(c.get("navigationMode"), c.get("navigationMode")),
               alert=s.get("alert") or s.get("error") or "-", state=s.get("state"))
    print(f"   robot reports: mode {row['mode']}, navigation {row['nav']}, alert {row['alert']}")
    cmd({"cmd": "stopCleaning"})
    time.sleep(3)
    cmd({"cmd": "sendToBase"})
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zone", default="Test1")
    ap.add_argument("--spot", type=int, default=100, help="spot width/height in cm")
    ap.add_argument("--only", choices=["spot", "zone"])
    args = ap.parse_args()

    rows = []
    if args.only != "zone":
        for mode in MODES:
            for nav in NAVS:
                rows.append(run(f"Spot   {MODES[mode]:6} + {NAVS[nav]}", {
                    "category": 3, "mode": mode, "navigationMode": nav, "modifier": 1,
                    "spotWidth": args.spot, "spotHeight": args.spot}))
    if args.only != "spot":
        zone = find_zone(args.zone)
        if not zone:
            print(f"zone {args.zone!r} not found")
        else:
            for mode in MODES:
                for nav in NAVS:
                    rows.append(run(f"Zone   {MODES[mode]:6} + {NAVS[nav]}", {
                        "category": 4, "mode": mode, "navigationMode": nav, "mapId": zone[0], "boundaryId": zone[1]}))
    wait_docked()

    print("\n\nasked for                     | start        | robot reports        | alert")
    print("-" * 85)
    for r in rows:
        print(f"{r['label']:29} | {str(r['start']):12} | {str(r.get('mode', '-')):6} + {str(r.get('nav', '-')):12} | {r.get('alert', '-')}")


if __name__ == "__main__":
    main()
