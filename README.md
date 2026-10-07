# track-flight ✈

Your flight is in the air and you are refreshing Google. Stop. Watch it fly instead.

﻿﻿﻿<img width="1840" height="1106" alt="Screenshot 2026-10-07 at 10 59 23" src="https://github.com/user-attachments/assets/2ae7cbb1-253b-4914-89d6-e6359c4cf6ef" />

A full-screen terminal dashboard with a map, graphs and a plane. It is TypeScript, and you run it straight from `flight-tui.ts`.

## How to run it (step by step)

You do not need to know how to code. You need a Mac and 5 minutes.

1. **Open Terminal.** Press `Cmd + Space`, type `Terminal`, press `Enter`.
2. **Check for Node.** Type this and press `Enter`:

   ```bash
   node -v
   ```

   - If you see a number like `v24.1.0`, go to step 3. The number must be 22.18 or higher.
   - If you see `command not found`, install Node. Go to [nodejs.org](https://nodejs.org), download the installer and run it. Then close Terminal, open it again and repeat this step.

3. **Download this project.** Run:

   ```bash
   git clone https://github.com/PeterShershov/track-flight.git
   cd track-flight
   ```

   No `git`? Click the green **Code** button on the GitHub page, choose **Download ZIP** and unzip it. Then in Terminal type `cd ` (with a space), drag the unzipped folder into the window and press `Enter`.

4. **Find your flight number.** It is on your ticket. It has an airline code and a number, for example `UA125` or `LY001`. Do not use spaces.
5. **Start the dashboard.** Run:

   ```bash
   ./flight-tui.ts UA125
   ```

   Replace `UA125` with your flight number. The screen fills with a map, graphs and a plane.

6. **Quit.** Press `q`.

If something goes wrong:

| What you see | What to do |
|---|---|
| `permission denied` | Run `chmod +x flight-tui.ts`, then try again |
| `command not found: node` | Install Node (step 2) |
| The screen looks squashed | Make the Terminal window bigger (100 columns by 30 rows or more) |
| `FlightAware does not know flight ...` | Check the flight number. Try the date: `./flight-tui.ts UA125 -d 2026-10-09` |

## Run it (short version)

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

(The link still finds `land.json`, because Node follows it back to the real file.)

Make the window at least 100x30 and you get the full show: route map (lit by the real sun, so you can watch night fall), altitude and speed graphs, gates, delays and local times.

Keys: `q` quit · `r` refresh.

| Option | What it does |
|---|---|
| `-d 2026-10-09` | Follow the flight that departs on this date |
| `-i 60` | Seconds between checks (minimum 30) |
| `--once` | Print one frame and exit |

## Hacking

```bash
npm install     # dev tools only: TypeScript, ESLint, Prettier
npm test        # typecheck, lint, prettier, then the tests
```

## Good to know

- Metric units, 24-hour clock, local time at each airport.
- The data comes from the public FlightAware page, not an official API. If they change the page, this breaks. If you refresh too often, they send a `429`. The dashboard waits and retries.
- `land.json` is a general world map (Natural Earth 1:50m, public domain), not a map of one flight. It zooms to fit any route.
