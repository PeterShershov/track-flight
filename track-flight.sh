#!/usr/bin/env bash
#
# track-flight.sh - Watch one flight and show a macOS notification when something changes.
#
# Usage:
#   ./track-flight.sh [-i SECONDS] [-p MINUTES] [-d YYYY-MM-DD] FLIGHT
#
#   FLIGHT   Flight number, for example UA125 or UAL125.
#   -i       Seconds between checks. Default: 120.
#   -p       Minutes between position updates while in the air. Default: 30. Use 0 to turn off.
#   -d       Departure date, in local time at the origin airport.
#            Default: the flight that FlightAware shows now.
#
# It notifies when the flight leaves the gate, takes off, lands and arrives at the gate.
# It also notifies on delays, new arrival estimates, gate changes, cancellation and diversion.
# The script stops after the flight arrives at the gate, or when the flight is cancelled.
#
# Run it in the background and keep a log:
#   nohup ./track-flight.sh UA125 >> ~/track-flight.log 2>&1 &
#
# Flight data comes from the public FlightAware flight page (not an official API).
# Place names come from OpenStreetMap Nominatim. Needs curl and jq (both ship with macOS 15+).

set -uo pipefail

FA=https://www.flightaware.com
BROWSER_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
SCRIPT_UA="track-flight.sh/1.0 (personal flight tracker)"
SHIFT_MIN=10    # Notify when an estimate moves by this many minutes or more.
MAX_FAILS=5     # Notify once after this many failed checks in a row.

INTERVAL=120
POS_MIN=30
DATE=""

usage() {
  sed -n '3,12s/^# \{0,1\}//p' "$0"
  exit "${1:-0}"
}

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

die() { log "Error: $*" >&2; exit 1; }

# notify TITLE MESSAGE [sound]
notify() {
  log "$1 | $2"
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$1" -message "$2" -open "$FA$link" ${3:+-sound default} >/dev/null
  else
    osascript \
      -e 'on run argv' \
      -e 'if item 3 of argv is "" then' \
      -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
      -e 'else' \
      -e 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"' \
      -e 'end if' \
      -e 'end run' \
      "$1" "$2" "${3:-}" >/dev/null
  fi
}

# fetch_json PATH: print the flight JSON that FlightAware embeds in the page at PATH.
fetch_json() {
  curl -fsSL --compressed -m 30 -A "$BROWSER_UA" "$FA$1" |
    sed -n 's/.*var trackpollBootstrap = //p' |
    sed 's/;<\/script>.*//'
}

# resolve_ident FLIGHT: convert an airline IATA code to ICAO (UA125 -> UAL125).
resolve_ident() {
  local q found
  q=$(printf '%s' "$1" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
  found=$(curl -fsS -m 20 -A "$BROWSER_UA" "$FA/ajax/ignoreall/omnisearch/flight.rvt?v=50&locale=en_US&searchterm=$q&q=$q" 2>/dev/null |
    jq -r '((.data | map(select(.major_airline == "1"))) + .data)[0].ident // empty' 2>/dev/null)
  printf '%s\n' "${found:-$q}"
}

# pick_by_date JSON DATE: print the link of the flight that departs on DATE (origin local time).
pick_by_date() {
  jq -r '.flights | to_entries[0].value.activityLog.flights[]
    | [.permaLink, (.origin.TZ // ":UTC" | ltrimstr(":")), (.gateDepartureTimes.scheduled // .takeoffTimes.scheduled // 0)]
    | @tsv' <<<"$1" |
    while IFS=$'\t' read -r l tz ts; do
      if [ "$(TZ="$tz" date -r "$ts" +%F)" = "$2" ]; then
        printf '%s\n' "$l"
        break
      fi
    done
}

# read_state JSON: set one shell variable for each flight field we use.
read_state() {
  local vars
  vars=$(jq -r 'def n: if type == "number" then floor else "" end;
    .flights | to_entries[0].value | select(.displayIdent != null) | @sh "
    name=\(.friendlyIdent // .displayIdent)
    cancelled=\(.cancelled // false)
    diverted=\(.diverted // false)
    org=\(.origin.iata // .origin.icao // "")
    org_tz=\(.origin.TZ // ":UTC" | ltrimstr(":"))
    org_gate=\(.origin.gate // "")
    org_term=\(.origin.terminal // "")
    dst=\(.destination.iata // .destination.icao // "")
    dst_tz=\(.destination.TZ // ":UTC" | ltrimstr(":"))
    dst_gate=\(.destination.gate // "")
    dst_term=\(.destination.terminal // "")
    dep_sched=\(.gateDepartureTimes.scheduled // "")
    dep_est=\(.gateDepartureTimes.estimated // "")
    dep_act=\(.gateDepartureTimes.actual // "")
    off_act=\(.takeoffTimes.actual // "")
    on_act=\(.landingTimes.actual // "")
    arr_sched=\(.gateArrivalTimes.scheduled // "")
    arr_est=\(.gateArrivalTimes.estimated // "")
    arr_act=\(.gateArrivalTimes.actual // "")
    alt=\(.altitude | n)
    speed=\(.groundspeed | n)
    remaining=\(.distance.remaining | n)
    lon=\((.track[-1].coord // .coord // [])[0] // "")
    lat=\((.track[-1].coord // .coord // [])[1] // "")
    pos_time=\(.track[-1].timestamp // "")
  "' <<<"$1" 2>/dev/null) || return 1
  [ -n "$vars" ] || return 1
  eval "$vars"
}

FIELDS="cancelled diverted dst org_gate org_term dst_gate dst_term dep_act off_act on_act arr_act"

save_prev() {
  local v
  for v in $FIELDS; do eval "p_$v=\$$v"; done
}

# fmt_time EPOCH TZ: "13:27", or "Thu 06:05" when the day is not today in TZ.
fmt_time() {
  [ -n "$1" ] || { printf 'unknown'; return; }
  if [ "$(TZ="$2" date -r "$1" +%F)" = "$(TZ="$2" date +%F)" ]; then
    TZ="$2" date -r "$1" '+%H:%M'
  else
    TZ="$2" date -r "$1" '+%a %H:%M'
  fi
}

# commas 36000: "36,000".
commas() {
  local n=$1 out=""
  while [ ${#n} -gt 3 ]; do
    out=",${n: -3}$out"
    n=${n:0:${#n}-3}
  done
  printf '%s' "$n$out"
}

# Convert nautical miles (or knots) to km (or km/h).
to_km() { printf '%d' $(( $1 * 1852 / 1000 )); }

# Convert FlightAware altitude (hundreds of feet) to meters, rounded to 10 m.
to_meters() { printf '%d' $(( ($1 * 3048 + 500) / 1000 * 10 )); }

# gate_text TERMINAL GATE: "Terminal B, gate C71".
gate_text() {
  local t=""
  [ -n "$1" ] && t="Terminal $1"
  [ -n "$2" ] && t="${t:+$t, }gate $2"
  printf '%s' "${t:-gate not assigned yet}"
}

# moved NEW OLD: true when two times are SHIFT_MIN minutes or more apart.
moved() {
  [ -n "$1" ] && [ -n "$2" ] || return 1
  local d=$(( $1 - $2 ))
  [ "${d#-}" -ge $(( SHIFT_MIN * 60 )) ]
}

late_text() {
  [ -n "$dep_sched" ] || return 0
  local d=$(( (${dep_est:-$dep_sched} - dep_sched) / 60 ))
  [ "$d" -ge 5 ] && printf ' (%d min late)' "$d"
}

place_name() {
  curl -fsS -m 15 -A "$SCRIPT_UA" \
    "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=8&accept-language=en&lat=$1&lon=$2" 2>/dev/null |
    jq -r '.display_name // empty' 2>/dev/null
}

position_text() {
  [ -n "$lat" ] || { printf 'No position yet.'; return; }
  local where text age
  where=$(place_name "$lat" "$lon")
  text="📍 Over ${where:-water}"
  [ -n "$alt" ] && [ "$alt" -gt 0 ] && text+=" · $(commas "$(to_meters "$alt")") m"
  [ -n "$speed" ] && [ "$speed" -gt 0 ] && text+=" · $(commas "$(to_km "$speed")") km/h"
  [ -n "$remaining" ] && text+=" · $(commas "$(to_km "$remaining")") km to go"
  text+=" · arrives ~$(fmt_time "${arr_est:-$arr_sched}" "$dst_tz")"
  if [ -n "$pos_time" ]; then
    age=$(( ($(date +%s) - pos_time) / 60 ))
    [ "$age" -ge 15 ] && text+=" (position $age min old)"
  fi
  printf '%s' "$text"
}

summary() {
  if [ "$cancelled" = true ]; then
    printf '❌ Flight cancelled.'
  elif [ -n "$arr_act" ]; then
    printf '✅ Arrived at %s at %s.' "$dst" "$(fmt_time "$arr_act" "$dst_tz")"
  elif [ -n "$on_act" ]; then
    printf '🛬 Landed at %s at %s. Arrival: %s.' "$dst" "$(fmt_time "$on_act" "$dst_tz")" "$(gate_text "$dst_term" "$dst_gate")"
  elif [ -n "$off_act" ]; then
    printf '✈️ In the air since %s. Arrives ~%s.' "$(fmt_time "$off_act" "$org_tz")" "$(fmt_time "${arr_est:-$arr_sched}" "$dst_tz")"
  elif [ -n "$dep_act" ]; then
    printf '🚪 Left the gate at %s. Taxiing to the runway.' "$(fmt_time "$dep_act" "$org_tz")"
  else
    printf '🕒 Departs %s%s from %s.' "$(fmt_time "${dep_est:-$dep_sched}" "$org_tz")" "$(late_text)" "$(gate_text "$org_term" "$org_gate")"
  fi
}

in_air() { [ -n "$off_act" ] && [ -z "$on_act" ]; }

# Compare this check with the previous one and notify for each change.
check_changes() {
  if [ "$cancelled" = true ] && [ "$p_cancelled" != true ]; then
    notify "$title" "❌ Flight cancelled." sound
  fi
  if { [ "$diverted" = true ] && [ "$p_diverted" != true ]; } || { [ -n "$dst" ] && [ "$dst" != "$p_dst" ]; }; then
    notify "$title" "⚠️ Diverted to $dst." sound
  fi

  if [ -n "$dep_act" ] && [ -z "$p_dep_act" ]; then
    notify "$title" "🚪 Left the gate at $(fmt_time "$dep_act" "$org_tz")."
  fi
  if [ -n "$off_act" ] && [ -z "$p_off_act" ]; then
    notify "$title" "🛫 Took off at $(fmt_time "$off_act" "$org_tz"). Arrives ~$(fmt_time "${arr_est:-$arr_sched}" "$dst_tz")." sound
    last_pos=$(date +%s)
  fi
  if [ -n "$on_act" ] && [ -z "$p_on_act" ]; then
    notify "$title" "🛬 Landed at $dst at $(fmt_time "$on_act" "$dst_tz"). Arrival: $(gate_text "$dst_term" "$dst_gate")." sound
  fi
  if [ -n "$arr_act" ] && [ -z "$p_arr_act" ]; then
    notify "$title" "✅ At the gate at $(fmt_time "$arr_act" "$dst_tz"). $(gate_text "$dst_term" "$dst_gate")." sound
  fi

  # Estimates can show up late. Use the first one we see as the base.
  [ -n "$n_dep_est" ] || n_dep_est=$dep_est
  [ -n "$n_arr_est" ] || n_arr_est=$arr_est

  # Before departure: delays and departure gate changes.
  if [ -z "$dep_act" ]; then
    if moved "$dep_est" "$n_dep_est"; then
      notify "$title" "🕒 Departure now $(fmt_time "$dep_est" "$org_tz")$(late_text). It was $(fmt_time "$n_dep_est" "$org_tz")."
      n_dep_est=$dep_est
    fi
    if [ -n "$org_term$org_gate" ] && [ "$org_term|$org_gate" != "$p_org_term|$p_org_gate" ]; then
      notify "$title" "🚪 Departure at $org: $(gate_text "$org_term" "$org_gate")."
    fi
  fi

  # Before arrival: new arrival estimates and arrival gate changes.
  if [ -z "$on_act" ] && moved "$arr_est" "$n_arr_est"; then
    notify "$title" "🕒 Arrival now ~$(fmt_time "$arr_est" "$dst_tz"). It was $(fmt_time "$n_arr_est" "$dst_tz")."
    n_arr_est=$arr_est
  fi
  if [ -z "$arr_act" ] && [ -n "$dst_term$dst_gate" ] && [ "$dst_term|$dst_gate" != "$p_dst_term|$p_dst_gate" ]; then
    notify "$title" "🚪 Arrival at $dst: $(gate_text "$dst_term" "$dst_gate")."
  fi

  # In the air: a position update every POS_MIN minutes.
  if in_air && [ "$POS_MIN" -gt 0 ] && [ $(( $(date +%s) - last_pos )) -ge $(( POS_MIN * 60 )) ]; then
    notify "$title" "$(position_text)"
    last_pos=$(date +%s)
  fi
}

# Print one status line to the log for each check.
log_status() {
  local s
  s=$(summary)
  if in_air; then
    [ -n "$alt" ] && s+=" Altitude $(commas "$(to_meters "$alt")") m."
    [ -n "$remaining" ] && s+=" $(commas "$(to_km "$remaining")") km to go."
  fi
  log "$s"
}

# True when there is nothing more to track.
finished() {
  [ "$cancelled" = true ] && return 0
  [ -n "$arr_act" ] && return 0
  # Some flights never get a gate arrival time. Stop one hour after landing.
  [ -n "$on_act" ] && [ $(( $(date +%s) - on_act )) -ge 3600 ]
}

main() {
  while getopts "i:p:d:h" opt; do
    case $opt in
      i) INTERVAL=$OPTARG ;;
      p) POS_MIN=$OPTARG ;;
      d) DATE=$OPTARG ;;
      h) usage 0 ;;
      *) usage 1 ;;
    esac
  done
  shift $(( OPTIND - 1 ))
  [ $# -eq 1 ] || usage 1
  [[ $INTERVAL =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 30 ] || die "-i must be 30 seconds or more."
  [[ $POS_MIN =~ ^[0-9]+$ ]] || die "-p must be a number of minutes."
  [ -z "$DATE" ] || [[ $DATE =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "-d must look like 2026-10-07."
  command -v jq >/dev/null || die "jq is not installed. Run: brew install jq"

  local ident json
  ident=$(resolve_ident "$1")
  log "Looking up $ident on FlightAware..."
  json=$(fetch_json "/live/flight/$ident") || die "Could not load FlightAware."

  if [ -n "$DATE" ]; then
    link=$(pick_by_date "$json" "$DATE")
    [ -n "$link" ] || die "FlightAware lists no $ident flight on $DATE. It shows about 2 days ahead."
  else
    link=$(jq -r '.flights | to_entries[0].value | select(.displayIdent != null) | .links.permanent // empty' <<<"$json" 2>/dev/null)
    [ -n "$link" ] || die "FlightAware does not know flight $1."
  fi
  log "Following $FA$link"

  # Keep the Mac awake (idle sleep only) while this script runs.
  caffeinate -i -w $$ &
  trap 'log "Stopped."; exit 0' INT TERM

  local first=1 fails=0 msg
  while :; do
    if json=$(fetch_json "$link") && read_state "$json"; then
      fails=0
      if [ $first = 1 ]; then
        first=0
        title="$name · $org → $dst"
        n_dep_est=$dep_est
        n_arr_est=$arr_est
        last_pos=$(date +%s)
        if in_air; then
          msg="✈️ In the air since $(fmt_time "$off_act" "$org_tz"). $(position_text)"
        else
          msg=$(summary)
        fi
        notify "$title" "$msg" sound
        [ -n "$arr_act" ] && [ -z "$DATE" ] && log "This flight already arrived. Use -d YYYY-MM-DD to track another day."
      else
        check_changes
      fi
      save_prev
      log_status
      finished && { log "Done."; exit 0; }
    else
      fails=$(( fails + 1 ))
      log "Could not read the flight from FlightAware (try $fails)."
      [ "$fails" -eq "$MAX_FAILS" ] && notify "${title:-$ident}" "⚠️ Cannot reach FlightAware. Still trying."
    fi
    sleep "$INTERVAL"
  done
}

main "$@"
