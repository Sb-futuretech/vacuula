# About this fork

This is a fork of [Vacuula](https://github.com/vacuula/vacuula) by Philip, the custom server for
Neato robot vacuums whose cloud is gone. It follows upstream closely (currently based on
**1.1.0-b9**) and adds features and fixes on top, mostly for **Gen3 robots**.

Everything here was built and tested on a **Neato Botvac D7 Connected, firmware 4.5.3-189**. Other
Gen3 models (D3–D6) will probably behave similarly, but have not been tested. Gen4 robots (D8–D10)
run the upstream code paths; most additions are Gen3 only.

Changes that make sense for everyone are kept on their own branches cut from upstream, so they can
be offered back as pull requests.

## What this fork adds

### Cleaning
- **Several zones in one go (Gen3).** The D7 accepts a `startCleaning` with several `boundaryIds`
  but ignores them and cleans the whole map. The server keeps a zone queue instead and starts the
  zones one after another (`/api/robot/<serial>/zone-queue`), with the cleaning mode of your choice.
- **Zone progress on the home page:** which zone is running, which are done, a *Skip rest* button
  (the running zone is finished and still shown), and afterwards which zones could not be reached
  and why.
- **Manual drive (Gen3)**, like the old Neato app: hold an arrow to drive, left/right turn on the
  spot, with forward they curve; vacuum, brush and turbo toggles; arrow keys on a keyboard. The
  server holds the robot's drive socket, browsers cannot sign it themselves.
- Deep navigation can no longer be combined with Eco (the robot rejects it).
- Schedule: several days at once with presets (daily, weekdays, weekend).
- Schedule times are local time (the server's timezone). The D7 runs its schedule in UTC, so the
  server converts them, and moves the robot's events after a DST switch so 8:00 stays 8:00.

### Map
- **Desktop layout** from 900 px: side navigation, wider pages; the map page shows its panel next
  to the map instead of over it.
- Smooth wheel and trackpad-pinch zoom, zoom buttons, double-click and `+` / `-` / `0` keys.
- **Draw zones with the mouse**: click to add points, click a point to select it, arrow keys move it
  5 cm (shift: 25 cm), Backspace removes it, Enter closes the zone. The 10-point limit of Gen3 is
  enforced (the robot silently drops the rest).
- **Coverage heatmap** on the map page: how often each part of the floor was cleaned in the last
  10 / 30 runs, and which free floor no run reached.

### Home page
- Optional **map of the last cleaning** instead of the mascot (*Settings → Home page*): the covered
  area, walls, zones (the cleaned ones highlighted), dock, start flag and the mascot where the robot
  ended; swipe or use the arrows to flip through the last 20 runs.
- Battery percentage stays visible while charging; Gen3 battery is polled (the robot only pushes
  state changes).
- Narrow phones: the control buttons shrink instead of running off the screen.

### Fixes
- Concurrent commands to a Gen3 robot are serialised (shared request ids and interleaved socket
  writes made the robot disconnect).
- Run maps that end away from the dock no longer fail to upload.
- Zones and no-go lines of gen3 maps are kept on the server, so pages load without asking the
  robot each time and show them while it is offline.
- Gen3 dock position is taken from the run map's dock marker only (it used to be mixed with the
  start position).
- Gen3 run maps: the background is no longer drawn as path (whole map tinted).
- Names with umlauts and other non-ASCII characters no longer get mangled on every save.
- Battery cycles / model in the settings are fetched again when the first request fails.
- The robot's `life_stats` and `push_notifications` requests are answered and logged (they used to
  return 404).

## What we learned about the D7
Useful if you work on Gen3 support yourself:

- `startCleaning` with `boundaryIds` is accepted and ignored; only one `boundaryId` per run works.
- Schedule events only hold mode, day, start time and zone. A `navigationMode` (e.g. Deep) is
  dropped silently, and `setSchedule` still answers `ok`. `getSchedule` right after `setSchedule`
  can return the old list for a few seconds.
- The mapping run (`startPersistentMapExploration`) vacuums: it runs as a house clean.
- Mode combinations (checked with `build/pi/d7_mode_test.py`): spot cleaning accepts everything
  but always runs Eco with normal navigation; zone cleaning takes every combination except Eco +
  Deep (`invalid_entry`, the same as for house cleaning).
- Scheduled starts run as map cleaning on the stored map, so with its no-go lines.
- `getLocalStats` answers `command_not_found`; `life_stats` uploads are empty.
- The robot has no timezone: schedule events (`day`, `startTime`) are UTC. Started without a
  `mapId`, a map run first tries the last used floor plan (`nav_floorplan_localization_fail` if the
  robot now stands at another base).
- RunMap pixel values: `128` background, a thin `3` track of the robot's centre, and 4×4 marker
  blocks: `100` dock (only in completed runs), `200` start and `150` end position (the last two from
  little data so far). FloorMap and RunMap of a run have the same size and line up cell for cell.
  A run's grid only covers the part of its stored map it reached (smaller with doors closed); the
  run names the map in `persistent_map_id`, and the app places it by matching the walls.
- Manual drive: `getRobotManualCleaningInfo` returns the robot's IP and port (8081). The robot then
  accepts a WebSocket at `ws://<ip>:8081/drive` with `Authorization: NEATOAPP <hmac>`, where the
  HMAC-SHA256 is over `lowercase(serial) + "\n" + date + "\n"` with the robot's secret, and a
  matching `Date` header. Messages: `{"combo": "forward" | "back" | "stop" | "arc-left" | "arc-right"
  | "pivot-left" | "pivot-right"}` (repeat while moving) and `{"command": "vacuum-on" | ...}`.

## Running it
This fork has no published image; build it yourself. Set up the robot with the upstream
[installer](README.md#configure-the-robot) as usual.

```yaml
# docker-compose.yaml
services:
  vacuula:
    image: vacuula:sb            # the image you build below
    network_mode: host
    environment:
      - GEN3_PORT=335
      - GEN4_PORT=3443
      - VACUULA_PORT=80          # keep the port your robot was set up with: it uploads maps to it
      - GEN3_ENABLED=True
      - GEN4_ENABLED=True
      - MDNS_ENABLED=True
      - TZ=Europe/Berlin
      - VACUULA_TZ=Europe/Berlin
      - LOG_LEVEL=INFO           # DEBUG shows every robot message
    volumes:
      - vacuula-data:/server/data
    restart: unless-stopped
volumes:
  vacuula-data:
```

Upstream changed the default web port from 80 to **8050** in 1.1.0-b8. If your robot was set up on
port 80, set `VACUULA_PORT=80` explicitly, or run the installer again for the new port.

[`build/pi/deploy.sh`](build/pi/deploy.sh) pulls the branch, builds the image, restarts it with
docker compose and keeps the last builds for a rollback:

```bash
./build/pi/deploy.sh                    # pull, build, restart
./build/pi/deploy.sh --list             # builds kept for rollback
./build/pi/deploy.sh --rollback <tag>   # run an earlier build again
```

Set `REPO_DIR` and `COMPOSE_DIR` at the top of the script (or when calling it) to your paths.

## License
Same as upstream: [AGPL-3.0](LICENSE). All credit for Vacuula itself goes to Philip and the upstream
contributors.
