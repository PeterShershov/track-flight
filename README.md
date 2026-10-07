# track-flight ✈

Your flight is in the air and you are refreshing Google. Stop. Watch it fly instead.

- `flight-tui.py`: a full-screen terminal dashboard with a map, graphs and a plane.
- `track-flight.sh`: a quiet background script that sends macOS notifications.

## Run it

```bash
./flight-tui.py UA125
```

No `python3` in front, no packages to install. The first line of the file is a shebang (`#!/usr/bin/env python3`), and the file is executable, so your shell knows what to do. Python 3.9+ is all you need.

Want to run it from anywhere, without the `./`? Link it into a folder on your `PATH`:

```bash
ln -s "$PWD/flight-tui.py" ~/.local/bin/flight
flight UA125
```

(Same trick works for `track-flight.sh`. The link still finds `land.json` next to the real file.)

Make the window at least 100x30 and you get the full show: route map (lit by the real sun, so you can watch night fall), altitude and speed graphs, gates, delays and local times.

Keys: `q` quit · `r` refresh · `n` notifications on/off.

| Option | What it does |
|---|---|
| `-d 2026-10-09` | Follow the flight that departs on this date |
| `-i 60` | Seconds between checks (minimum 30) |
| `--pos-every 30` | Minutes between position pings in the air. `0` = never |
| `--no-notify` | Silence the notifications |
| `--once` | Print one frame and exit |

## Notifications only

For people who prefer to be told, not shown:

```bash
nohup ./track-flight.sh UA125 >> ~/track-flight.log 2>&1 &
```

It speaks up for gate, takeoff, landing, delays of 10+ minutes, gate changes, cancellation and diversion. Needs `curl` and `jq`. Stop it with `pkill -f track-flight.sh`.

## Good to know

- Metric units, 24-hour clock, local time at each airport.
- The data comes from the public FlightAware page, not an official API. If they change the page, this breaks. If you refresh too often, they send a `429`. The dashboard waits and retries.
- `land.json` is a general world map (Natural Earth 1:50m, public domain), not a map of one flight. It zooms to fit any route.
