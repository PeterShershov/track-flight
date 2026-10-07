// Full-screen terminal mode: keys, resizing and redrawing.

import type { App } from "./app.ts";
import { clip, RESET, vlen } from "./ansi.ts";
import { render } from "./panels.ts";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** Run the dashboard until the user quits. Restores the terminal when it ends. */
export function runTui(app: App): Promise<void> {
  const { stdin, stdout } = process;
  let last = "";
  let clearScreen = true;
  let noticeUntil = 0;
  let restored = false;

  const draw = () => {
    const now = Date.now() / 1000;
    if (app.notice && now > noticeUntil) app.notice = "";
    const w = stdout.columns || 100;
    const h = stdout.rows || 30;
    if (clearScreen) {
      stdout.write(`${ESC}[2J`);
      clearScreen = false;
      last = "";
    }
    const lines = render(app, w, h, now).slice(0, h);
    const frame = `${ESC}[H${lines.map((l) => (vlen(l) > w ? clip(l, w) : l)).join(`${ESC}[K\n`)}${ESC}[K${ESC}[J`;
    if (frame !== last) {
      stdout.write(frame);
      last = frame;
    }
  };

  const say = (text: string) => {
    app.notice = text;
    noticeUntil = Date.now() / 1000 + 2;
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    stdout.write(`${ESC}[?25h${ESC}[?1049l${RESET}`);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };

  return new Promise((resolve) => {
    const timer = setInterval(draw, 500);
    const quit = () => {
      clearInterval(timer);
      app.stop();
      restore();
      resolve();
    };

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "q" || ch === "Q" || ch === CTRL_C) return quit();
        if (ch === "r" || ch === "R") {
          app.refresh();
          say("refreshing…");
        }
      }
      draw();
    });
    stdout.on("resize", () => {
      clearScreen = true;
      draw();
    });
    process.once("SIGTERM", quit);
    process.once("SIGHUP", quit);
    process.once("exit", restore);

    stdout.write(`${ESC}[?1049h${ESC}[?25l`);
    void app.poll();
    draw();
  });
}
