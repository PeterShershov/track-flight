# track-flight ✈

Your flight is in the air and you are refreshing Google. Stop. Watch it fly instead.

﻿﻿﻿<img width="1840" height="1106" alt="Screenshot 2026-10-07 at 10 59 23" src="https://github.com/user-attachments/assets/2ae7cbb1-253b-4914-89d6-e6359c4cf6ef" />

- `flight-tui.ts`: a full-screen terminal dashboard with a map, graphs and a plane. TypeScript, run straight from the file.
- `track-flight.sh`: a quiet background script that sends macOS notifications.

## Run it

```bash
./flight-tui.ts UA125
```

No `node` in front, no build, no `npm install`. The first line of the file is a shebang (`#!/usr/bin/env node`) and the file is executable, so your shell knows what to do. Node runs TypeScript natively, so there is nothing to compile.

You need Node 22.18 or newer (`.nvmrc` says 24). macOS does not ship with Node, so if `node -v` fails: `brew install node`.

Want to run it from anywhere, without the `./`? Link it into a folder on your `PATH`:

```bash
ln -s "$PWD/flight-tui.ts" ~/.local/bin/flight
flight UA125
```

(Same trick works for `track-flight.sh`. The link still finds `land.json`, because Node follows it back to the real file.)

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

## Hacking

```bash
npm install     # dev tools only: TypeScript, ESLint, Prettier
npm test        # typecheck, lint, prettier, then the tests
```

## Good to know

- Metric units, 24-hour clock, local time at each airport.
- The data comes from the public FlightAware page, not an official API. If they change the page, this breaks. If you refresh too often, they send a `429`. The dashboard waits and retries.
- `land.json` is a general world map (Natural Earth 1:50m, public domain), not a map of one flight. It zooms to fit any route.
