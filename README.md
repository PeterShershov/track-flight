# track-flight

Follow one flight from your Mac. Two tools use the same data:

- `flight-tui.py` is a full-screen terminal dashboard.
- `track-flight.sh` runs in the background and sends macOS notifications.

## Dashboard

```bash
./flight-tui.py UA125
```

The dashboard shows:

- A braille-dot world map with the planned route, the flown track and the plane. Land is lit by the real sun, so you see where it is night.
- Altitude and ground speed graphs, heading, position and the region under the plane.
- Departure and arrival boxes with gates, delays and local times.
- A progress bar with distance flown, distance to go and time to landing.

Keys: `q` quit, `r` refresh now, `n` notifications on or off.

| Option | Meaning |
|---|---|
| `-d 2026-10-09` | Follow the flight that departs on this date (local time at the origin). |
| `-i 60` | Seconds between checks. Minimum 30. |
| `--pos-every 30` | Minutes between position notifications in the air. `0` turns them off. |
| `--no-notify` | Do not send notifications. |
| `--once` | Print one frame and exit. |

The dashboard needs Python 3.9 or newer and a terminal of at least 80x20. A width of 100 or more shows the cockpit panel.
It sends the same notifications as the script below.

## Notifications only

```bash
nohup ./track-flight.sh UA125 >> ~/track-flight.log 2>&1 &
```

It notifies on gate departure, takeoff, landing and arrival at the gate. It also notifies on delays of 10 minutes or more, gate changes, cancellation and diversion. Run `./track-flight.sh -h` for options. It needs `curl` and `jq`.

## Notes

- Units are metric and times are 24-hour, in local time at each airport.
- Flight data comes from the public FlightAware flight page. This is not an official API. It can break when FlightAware changes the page, and FlightAware may rate-limit frequent requests.
- `land.json` is a general world map (not specific to one flight). It is the Natural Earth 1:50m land data, simplified. Natural Earth is public domain: https://www.naturalearthdata.com
