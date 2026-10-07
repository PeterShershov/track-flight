// Command line: read the options, then print one frame or run the dashboard.

import { parseArgs } from "node:util";
import { App, type Options } from "./app.ts";
import { render } from "./panels.ts";
import { runTui } from "./tui.ts";

export const USAGE = `flight-tui - a live, full-screen flight tracker for your terminal.

Usage:
  ./flight-tui.ts [options] FLIGHT          for example: ./flight-tui.ts UA125

Options:
  -d, --date YYYY-MM-DD   Follow the flight that departs on this date (local time at the origin).
  -i, --interval SECONDS  Seconds between data checks. Default 60. Minimum 30.
  --pos-every MINUTES     Send a position notification this often in the air. Default 30. 0 = off.
  --no-notify             Do not send macOS notifications.
  --once                  Print one frame and exit (no full-screen mode).
  --size WxH              Frame size for --once, for example 110x34.
  --json FILE             Test aid: read the flight from a saved FlightAware JSON file.
  --now EPOCH             Test aid: pretend this is the current time.
  -h, --help              Show this text.

Keys:  q quit   r refresh now   n notifications on/off

Flight data comes from the public FlightAware flight page (not an official API).
`;

export interface Cli {
  opts: Options;
  help: boolean;
  once: boolean;
  /** Frame size for --once, as [columns, rows]. */
  size: [number, number] | null;
  now: number | null;
}

function whole(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number.`);
  return n;
}

/** Read the command line. Throws an Error with a plain message when it is not valid. */
export function parseCli(args: string[]): Cli {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      date: { type: "string", short: "d" },
      interval: { type: "string", short: "i" },
      "pos-every": { type: "string" },
      "no-notify": { type: "boolean" },
      once: { type: "boolean" },
      size: { type: "string" },
      json: { type: "string" },
      now: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    throw new Error("-d must look like 2026-10-07.");
  }
  const size = values.size === undefined ? null : /^(\d+)x(\d+)$/i.exec(values.size);
  if (values.size !== undefined && !size) throw new Error("--size must look like 110x34.");
  return {
    opts: {
      flight: positionals[0] ?? "",
      date: values.date ?? null,
      interval: whole("-i", values.interval, 60),
      posEvery: whole("--pos-every", values["pos-every"], 30),
      notify: !values["no-notify"],
      json: values.json ?? null,
    },
    help: values.help ?? false,
    once: values.once ?? false,
    size: size ? [Number(size[1]), Number(size[2])] : null,
    now: values.now === undefined ? null : Number(values.now),
  };
}

/** Run the program. Returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const { stdin, stdout, stderr } = process;
  let cli: Cli;
  try {
    cli = parseCli(args);
  } catch (e) {
    stderr.write(`${e instanceof Error ? e.message : "Bad options."}\n`);
    return 2;
  }
  if (cli.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!cli.opts.flight && !cli.opts.json) {
    stderr.write(USAGE);
    return 1;
  }

  const app = new App(cli.opts);
  if (cli.once) {
    try {
      await app.load();
    } catch (e) {
      stderr.write(`Error: ${e instanceof Error ? e.message : "could not load the flight"}\n`);
      return 1;
    }
    const [w, h] = cli.size ?? [stdout.columns || 110, stdout.rows || 34];
    stdout.write(render(app, w, h, cli.now ?? Date.now() / 1000).join("\n") + "\n");
    return 0;
  }
  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write("flight-tui needs a terminal. Use --once to print a single frame.\n");
    return 1;
  }
  await runTui(app);
  process.exit(0); // A check may still be waiting on the network. Do not wait for it.
}
