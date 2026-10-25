#!/usr/bin/env python3
"""Which fields does a D7 schedule event keep?

Runs on the Pi, talks to Vacuula on localhost; the robot does not move. The current schedule is
saved, the schedule is switched off, test events with extra fields are written and read back, and
the saved schedule (and its on/off state) is restored at the end, also after an error or Ctrl+C.

    python3 d7_schedule_test.py               # zones from "Test1" / "Test2"
    python3 d7_schedule_test.py --zone Kueche --zone2 Flur
"""
import argparse
import json
import time
import urllib.request

SERIAL = "GPC43118-40bd32e27da1"
URL = f"http://localhost/api/robot/{SERIAL}/command"
READ_BACK_S = 10  # getSchedule right after setSchedule can still return the old list
DAY = 3           # Wednesday; times 03:01, 03:02, ... (the schedule is off meanwhile anyway)


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


def writable(event: dict) -> dict:
    """An event as read back, in the form setSchedule takes (`boundary` -> `boundaryId`)."""
    e = {k: v for k, v in event.items() if k != "boundary"}
    if event.get("boundary"):
        e["boundaryId"] = event["boundary"]["id"]
    return e


def variants(map_id, zone, zone2):
    v = [
        ("baseline (mode only)", {"mode": 1}),
        ("navigationMode Deep", {"mode": 2, "navigationMode": 3}),
        ("navigation_mode Deep", {"mode": 2, "navigation_mode": 3}),
        ("navigationMode Extra Care", {"mode": 1, "navigationMode": 2}),
        ("modifier double", {"mode": 1, "modifier": 2}),
        ("category house", {"mode": 1, "category": 2}),
        ("category spot + size", {"mode": 1, "category": 3, "spotWidth": 200, "spotHeight": 200}),
    ]
    if zone:
        v += [
            ("boundaryId (known to work)", {"mode": 1, "boundaryId": zone}),
            ("boundaryId + mapId", {"mode": 1, "boundaryId": zone, "mapId": map_id}),
            ("boundaryId + navigationMode Deep", {"mode": 2, "boundaryId": zone, "navigationMode": 3}),
        ]
    if zone and zone2:
        v.append(("boundaryIds (two zones)", {"mode": 1, "boundaryIds": [zone, zone2]}))
    return [(label, {"day": DAY, "startTime": f"03:{i + 1:02d}", **fields}) for i, (label, fields) in enumerate(v)]


def kept(sent: dict, back: dict | None) -> str:
    if back is None:
        return "event dropped"
    out = []
    for k, v in sent.items():
        if k in ("day", "startTime"):
            continue
        got = back.get(k)
        if k == "boundaryId" and got is None and back.get("boundary"):
            got = back["boundary"].get("id")
        out.append(f"{k} {'kept' if got == v else f'-> {got!r}' if got is not None else 'dropped'}")
    return ", ".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zone", default="Test1")
    ap.add_argument("--zone2", default="Test2")
    args = ap.parse_args()

    saved = cmd({"cmd": "getSchedule"})
    if saved.get("result") != "ok":
        raise SystemExit(f"could not read the schedule: {saved.get('result')}")
    saved_events = [writable(e) for e in (saved.get("data") or {}).get("events", [])]
    saved_enabled = (saved.get("data") or {}).get("enabled")
    print(f"saved schedule: {len(saved_events)} events, {'on' if saved_enabled else 'off'}")

    z1, z2 = find_zone(args.zone), find_zone(args.zone2)
    if not z1:
        print(f"zone {args.zone!r} not found, zone tests skipped")
    tests = variants(z1[0] if z1 else None, z1[1] if z1 else None, z2[1] if z1 and z2 and z2[0] == z1[0] else None)

    results = []
    try:
        print("schedule off:", cmd({"cmd": "disableSchedule"}).get("result"))
        reply = cmd({"cmd": "setSchedule", "params": {"events": [e for _, e in tests]}})
        print("all test events at once:", reply.get("result"))
        if reply.get("result") == "ok":
            time.sleep(READ_BACK_S)
            back = (cmd({"cmd": "getSchedule"}).get("data") or {}).get("events", [])
            by_time = {e.get("startTime"): e for e in back if e.get("day") == DAY}
            results = [(label, "ok", kept(e, by_time.get(e["startTime"]))) for label, e in tests]
        else:
            # one rejected field fails the whole list: try them one by one
            for label, e in tests:
                r = cmd({"cmd": "setSchedule", "params": {"events": [e]}})
                if r.get("result") != "ok":
                    results.append((label, r.get("result"), "-"))
                    continue
                time.sleep(READ_BACK_S)
                back = (cmd({"cmd": "getSchedule"}).get("data") or {}).get("events", [])
                results.append((label, "ok", kept(e, back[0] if back else None)))
                print(f"   {label}: done")
    finally:
        r = cmd({"cmd": "setSchedule", "params": {"events": saved_events}})
        print(f"\nrestore {len(saved_events)} events: {r.get('result')}")
        if saved_enabled:
            print("schedule on:", cmd({"cmd": "enableSchedule"}).get("result"))
        time.sleep(READ_BACK_S)
        now = cmd({"cmd": "getSchedule"}).get("data") or {}
        key = lambda events: sorted(json.dumps(e, sort_keys=True) for e in events)
        same = key(writable(e) for e in now.get("events", [])) == key(saved_events) and bool(now.get("enabled")) == bool(saved_enabled)
        print("schedule restored:", "yes" if same else f"CHECK IN THE APP (now {len(now.get('events', []))} events, {'on' if now.get('enabled') else 'off'})")

    print("\n\ntest event                          | setSchedule | what the robot kept")
    print("-" * 95)
    for label, res, what in results:
        print(f"{label:35} | {str(res):11} | {what}")


if __name__ == "__main__":
    main()
