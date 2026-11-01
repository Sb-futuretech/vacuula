# About this fork

This is a fork of [Vacuula](https://github.com/vacuula/vacuula) by Philip, the custom server for
Neato robot vacuums whose cloud is gone. It follows upstream closely (currently based on
**1.1.0**) and adds features and fixes on top, mostly for **Gen3 robots**.

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
- **Schedule entries the robot cannot keep** (Extra Care / Deep, several zones) are run by the
  server: the schedule page decides on save. A robot entry within 15 minutes of such an entry is
  its fallback: the server switches the robot's schedule off around its own start (noted in the
  bell), so without the server the robot still cleans.
- Schedule times are local time (the server's timezone). A D7 set up without a timezone runs its
  schedule in UTC, so the server converts them, and moves the robot's events after a DST switch so
  8:00 stays 8:00. A robot set up with a timezone (newer installer) is recognised at its first
  scheduled run: the conversion is switched off for it and its events are moved back.

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
- Gen3 battery is polled (the robot only pushes state changes).
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
- Names the robot stored escaped before upstream's UTF-8 fix (`B\\u00fcro`) are shown and saved
  as real text again.
- Battery cycles / model in the settings are fetched again when the first request fails.
- The robot's `life_stats` and `push_notifications` requests are answered and logged (they used to
  return 404).

## What we learned about the D7
Useful if you work on Gen3 support yourself:

- `startCleaning` with `boundaryIds` is accepted and ignored; only one `boundaryId` per run works.
- Schedule events only keep `mode`, `day`, `startTime`, one `boundaryId` and its `mapId`
  (checked with `build/pi/d7_schedule_test.py`). `navigationMode` (Deep, Extra Care), `modifier`,
  `category`, spot size and `boundaryIds` are dropped silently, and `setSchedule` still answers `ok`. `getSchedule` right after `setSchedule`
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

Copy both compose files from [`build/docker`](build/docker) into one folder on your server:
- [`compose.yaml`](build/docker/compose.yaml): this fork, image `vacuula:sb` built by `deploy.sh`.
- [`docker-compose.upstream.yaml`](build/docker/docker-compose.upstream.yaml): upstream's original
  file with the official image.

Both use the same database, so you can switch between this fork and the official server:

```bash
docker compose up -d                                        # this fork (compose.yaml)
docker compose -f docker-compose.upstream.yaml pull         # official image: pull first
docker compose -f docker-compose.upstream.yaml up -d        # official server on the same data
```

- Keep both files in the **same folder**: docker names the data volume after the folder, so a
  compose file elsewhere starts on a new, empty database.
- The official image has to be **1.1.0 or newer**. An older one (for example a stale local copy of
  `latest` that was never pulled) does not know the database version and stops at startup.
- While the official server runs, this fork's extras rest (server-run schedule entries,
  notifications, the map tools).
- This works since the fork keeps its own database changes in a separate migration chain (see the
  release notes, 2026-11-01). Its first start converts an older database once; a fork build from
  before that change does not start on a converted database, so back up the data volume first.

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

## Versions
The settings page shows both versions, for example `Vacuula 1.1.0 · sb 1.0.0 (a7274e5)`:
- `1.1.0` is the upstream version this fork is built on. It stays upstream's, because the installer
  and mDNS compare it.
- `sb 1.0.0` is this fork's version, set in
  [`fork_version.py`](server/src/vacuula_server/fork_version.py). Raise the minor number for new
  features and the last one for fixes, and the major one when the fork moves to a new upstream
  release. Tag the release `sb-<version>`.
- In brackets is the commit the image was built from. `deploy.sh` passes it in; without it (for
  example from source) it is left out.

## Release notes
What changed since October 25, tested on a D7 (Gen3, firmware 4.5.3-189) unless noted.

### New features at a glance

**Map**
- **Rulers** along the top and left edge, in real distance (cm / m). A ruler button in the zoom
  column switches them on; while drawing they are always on.
- **Exact point positions:** tap a drawn point to type its X / Y in cm, see its distance to the
  previous point, or delete it. Points can be selected on touch screens too.
- **Tap a zone or line on the map** (or in the list) to open its details: on/off, clean the zone,
  edit, delete. The selection is highlighted on the map; an empty spot goes back to the list.
- **Tap an empty spot** to get *Add feature here*: pick the type and start drawing right there.
- **Add feature asks for the type first** (Cleaning Zone, No-Go Line; Gen4 also No-Go Zone), each
  explained. A No-Go Line can no longer turn into a zone by accident.
- **Help button (?)** next to the zoom buttons: moving around, selecting, drawing. A small bubble
  hints at tapping zones and lines until the first tap.
- On phones the map opens with the feature list folded.

**Home page**
- **Mode and Cleaning framed together as *Next run*:** what is cleaned, and how.
- **One Cleaning button** for suction and navigation, opening one sheet with every option
  explained. Eco + Deep is shown as blocked, with the reason, instead of changing silently.
- **Map of the last cleaning** by default (*Settings → Home page* for the mascot).
- While cleaning, the state shows zone or map, mode and navigation.

**Schedule**
- Edit entries in place; repeating robot events grouped into one row; server-run entries can be
  paused.
- Mode and navigation explained under their fields; Save says what is still missing.

**Statistics and runs**
- Area per minute, battery minutes per charge per week, a battery index against each run's mode,
  per-zone statistics, recharged runs measured by their stretches, and a battery card that marks a
  battery change.
- A run's map opens full screen.
- Battery card: *time to empty* in the right unit (the battery reports minutes; it read as
  seconds before, e.g. 7 h as "7 min"), hidden while charging, and labelled *idle* since it is
  read with the robot standing after the run.

**Server and database**
- **Switch between this fork and the official server on the same database.** The fork keeps its
  own database changes in a separate migration chain, so the official image (1.1.0 or newer) starts
  on a database the fork has used, and the fork starts again afterwards. Its first start converts an
  older database once. `build/docker/compose.yaml` (fork) and `docker-compose.upstream.yaml`
  (official) are ready for it, see *Running it*.

**Connection**
- Fixed: the robot kept disconnecting after saving zones (messages split over several chunks).
- The log says why a connection ended; a successful state poll counts as a heartbeat.

### All commits
Every commit, newest first; *Upstream* rows come from Vacuula itself (release 1.1.0).

| Date | Commit | Area | Change |
|---|---|---|---|
| 2026-11-01 | [`e0d19e8`](https://github.com/Sb-futuretech/vacuula/commit/e0d19e8) | Statistics | Battery time to empty is minutes, hide 65535, say it is measured idle |
| 2026-11-01 | [`35770e6`](https://github.com/Sb-futuretech/vacuula/commit/35770e6) | Server | This fork as compose.yaml, upstream's file kept as docker-compose.upstream.yaml |
| 2026-11-01 | [`3056659`](https://github.com/Sb-futuretech/vacuula/commit/3056659) | Database | Keep the fork's migrations in their own chain so upstream can start too |
| 2026-11-01 | [`f415048`](https://github.com/Sb-futuretech/vacuula/commit/f415048) | Home | Thicker, stronger frame around the Next run group |
| 2026-11-01 | [`a4ecc97`](https://github.com/Sb-futuretech/vacuula/commit/a4ecc97) | Home | Frame Mode and Cleaning together as "Next run" |
| 2026-11-01 | [`a42d39c`](https://github.com/Sb-futuretech/vacuula/commit/a42d39c) | Map | Tapping an empty spot offers "add feature here" |
| 2026-11-01 | [`2d2a875`](https://github.com/Sb-futuretech/vacuula/commit/2d2a875) | Map | Tap bubble says "to see its details" |
| 2026-11-01 | [`8298fcf`](https://github.com/Sb-futuretech/vacuula/commit/8298fcf) | Map | Open a map with the feature sheet folded (phone) |
| 2026-11-01 | [`cbea39a`](https://github.com/Sb-futuretech/vacuula/commit/cbea39a) | Map | "tap a zone or line" bubble at the help button, touch icon in the help |
| 2026-11-01 | [`db5f6b3`](https://github.com/Sb-futuretech/vacuula/commit/db5f6b3) | Map | One selection for map taps and the list; rulers toggle, help always |
| 2026-11-01 | [`d0495f9`](https://github.com/Sb-futuretech/vacuula/commit/d0495f9) | Map | Tap a zone or line on the map to edit it |
| 2026-11-01 | [`9a2e6af`](https://github.com/Sb-futuretech/vacuula/commit/9a2e6af) | Connection | Read the robot's command connection as proper HTTP chunks |
| 2026-10-31 | [`4200bfa`](https://github.com/Sb-futuretech/vacuula/commit/4200bfa) | Map | Rulers and an editable position for drawn points |
| 2026-10-31 | [`5ec25b4`](https://github.com/Sb-futuretech/vacuula/commit/5ec25b4) | Map | Pick the feature type before drawing (Add-feature chooser) |
| 2026-10-31 | [`f6972f0`](https://github.com/Sb-futuretech/vacuula/commit/f6972f0) | Map | A "?" (in edit mode) below the zoom controls explains how to draw |
| 2026-10-31 | [`7c1cda8`](https://github.com/Sb-futuretech/vacuula/commit/7c1cda8) | Home | One Cleaning button + combined suction/navigation sheet (gen3) |
| 2026-10-31 | [`4dd802f`](https://github.com/Sb-futuretech/vacuula/commit/4dd802f) | Schedule | Explain the cleaning mode and navigation options |
| 2026-10-31 | [`bb3f111`](https://github.com/Sb-futuretech/vacuula/commit/bb3f111) | Home | Default the home page to the last cleaning's map |
| 2026-10-31 | [`3e91588`](https://github.com/Sb-futuretech/vacuula/commit/3e91588) | Schedule | Explain why Save is disabled, and hint the time format |
| 2026-10-28 | [`b979106`](https://github.com/Sb-futuretech/vacuula/commit/b979106) | Statistics | Battery card from the robot's own figures, detect a new battery |
| 2026-10-28 | [`f96a22e`](https://github.com/Sb-futuretech/vacuula/commit/f96a22e) | Statistics | Measure battery use of recharged runs by their stretches |
| 2026-10-28 | [`619c7ec`](https://github.com/Sb-futuretech/vacuula/commit/619c7ec) | Runs | Open a run's map full screen |
| 2026-10-28 | [`9724f0c`](https://github.com/Sb-futuretech/vacuula/commit/9724f0c) | Statistics | Show runs per week that could not be measured (recharged) |
| 2026-10-27 | [`b8b0f8e`](https://github.com/Sb-futuretech/vacuula/commit/b8b0f8e) | Statistics | Battery over time as an index against each run's own mode |
| 2026-10-27 | [`afcf1fc`](https://github.com/Sb-futuretech/vacuula/commit/afcf1fc) | Statistics | Battery minutes per charge per week, and per-zone statistics |
| 2026-10-27 | [`cee1e30`](https://github.com/Sb-futuretech/vacuula/commit/cee1e30) | Statistics | Area per minute of cleaning, overall and per mode + navigation |
| 2026-10-27 | [`3d56c1b`](https://github.com/Sb-futuretech/vacuula/commit/3d56c1b) | Schedule | Stop converting robot schedule times, only log the robot's clock |
| 2026-10-27 | [`f20ab9a`](https://github.com/Sb-futuretech/vacuula/commit/f20ab9a) | Server | Log why a robot's command connection ends and when it is missing |
| 2026-10-27 | [`2da517d`](https://github.com/Sb-futuretech/vacuula/commit/2da517d) | Schedule | Learn a robot's own fixed clock offset from its scheduled runs |
| 2026-10-26 | [`8699b4b`](https://github.com/Sb-futuretech/vacuula/commit/8699b4b) | Schedule | Edit entries in place, group repeating robot events, pause Pi entries |
| 2026-10-26 | [`358685d`](https://github.com/Sb-futuretech/vacuula/commit/358685d) | Server | Count a successful gen3 state poll as heartbeat (no more N/A while cleaning) |
| 2026-10-26 | [`2884c15`](https://github.com/Sb-futuretech/vacuula/commit/2884c15) | Home | Show zone/map, mode and navigation of the running clean next to the state (gen3) |
| 2026-10-25 | [`d96e3ca`](https://github.com/Sb-futuretech/vacuula/commit/d96e3ca) | Upstream | Links + how to update |
| 2026-10-25 | [`d5573ba`](https://github.com/Sb-futuretech/vacuula/commit/d5573ba) | Upstream | Docker compose fix |
| 2026-10-25 | [`dadf239`](https://github.com/Sb-futuretech/vacuula/commit/dadf239) | Upstream | Update configs release:1.1.0 |

### Known issues
- **After the database conversion (2026-11-01), a fork build from before it does not start**: it
  tries to create the fork's tables again. Back up the data volume before deploying, and don't roll
  back past that build without restoring the backup.
- **Too many zone/line points per map make the D7 drop its connection after every save.** There
  is no error reply; the robot just closes the connection and keeps doing so until the map is back
  under the limit. On one D7: 44 points over 10 zones and lines were fine; one more 2-point line (44
  points, 11 features) or a 5th zone (47 points, 10 features) were not. The best guess so far is
  *points + number of zones and lines ≤ 54*. To recover, delete the last point or feature and save.
- **The map scale is not verified.** Gen3 maps carry no resolution; the app assumes 40 mm per map
  cell. A door measured on one D7 suggests the rulers read short, so check them against a known
  distance before relying on them.
- Narrow no-go "corridors" (e.g. around a ramp) can make the area behind them unreachable: the
  robot keeps a margin to no-go lines like to walls.

## License
Same as upstream: [AGPL-3.0](LICENSE). All credit for Vacuula itself goes to Philip and the upstream
contributors.
