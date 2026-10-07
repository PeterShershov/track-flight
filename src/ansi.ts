// Colors, text styling and box drawing for the terminal. All text here is one column wide per character.

export type Rgb = readonly [number, number, number];

export const P = {
  acc: [88, 196, 255],
  flown: [255, 184, 64],
  plan: [96, 150, 200],
  ok: [96, 222, 150],
  warn: [255, 184, 64],
  bad: [255, 104, 110],
  txt: [226, 231, 238],
  dim: [122, 131, 145],
  line: [66, 76, 92],
  landDay: [104, 168, 132],
  landNight: [40, 66, 74],
  gratDay: [58, 68, 84],
  gratNight: [32, 38, 52],
  org: [130, 232, 176],
  dst: [255, 142, 164],
} as const satisfies Record<string, Rgb>;

const ESC = String.fromCharCode(27);
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
const ANSI_AT = new RegExp(`${ESC}\\[[0-9;]*m`, "y");
const ANSI_ALL = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const TRUECOLOR =
  ["truecolor", "24bit"].includes((process.env["COLORTERM"] ?? "").toLowerCase()) ||
  ["iTerm.app", "vscode", "WezTerm", "ghostty"].includes(process.env["TERM_PROGRAM"] ?? "");

function to256(r: number, g: number, b: number): number {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    const gray = Math.round((r - 8) / 10);
    return gray < 0 ? 16 : gray > 23 ? 231 : 232 + gray;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function colorCode(kind: 38 | 48, c: Rgb): string {
  const [r, g, b] = c.map(Math.round);
  if (r === undefined || g === undefined || b === undefined) return "";
  return TRUECOLOR ? `${ESC}[${kind};2;${r};${g};${b}m` : `${ESC}[${kind};5;${to256(r, g, b)}m`;
}

const fgCache = new Map<string, string>();

export function fg(c: Rgb): string {
  const key = c.map(Math.round).join(",");
  let code = fgCache.get(key);
  if (code === undefined) {
    code = colorCode(38, c);
    fgCache.set(key, code);
  }
  return code;
}

export function paint(text: string, c?: Rgb, bold = false): string {
  const pre = (bold ? BOLD : "") + (c ? fg(c) : "");
  return pre ? `${pre}${text}${RESET}` : text;
}

export function pill(text: string, c: Rgb): string {
  return `${colorCode(48, c)}${fg([14, 18, 24])}${BOLD} ${text} ${RESET}`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Visible width of a string: its length without color codes. */
export function vlen(s: string): number {
  return s.replace(ANSI_ALL, "").length;
}

/** Cut a string to w visible columns. Color codes stay. */
export function clip(s: string, w: number): string {
  let out = "";
  let shown = 0;
  let i = 0;
  while (i < s.length && shown < w) {
    ANSI_AT.lastIndex = i;
    const m = ANSI_AT.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      out += s.charAt(i);
      shown++;
      i++;
    }
  }
  return out + RESET;
}

/** Cut or pad a string to exactly w visible columns. */
export function fit(s: string, w: number): string {
  const n = vlen(s);
  return n >= w ? clip(s, w) : s + " ".repeat(w - n);
}

export function rightAlign(left: string, right: string, w: number): string {
  const gap = w - vlen(left) - vlen(right);
  return gap >= 1 ? left + " ".repeat(gap) + right : clip(left, w);
}

export interface BoxOptions {
  title?: string;
  right?: string;
  pad?: number;
}

/** A rounded box of exactly w x h cells. */
export function box(
  lines: readonly string[],
  w: number,
  h: number,
  { title = "", right = "", pad = 1 }: BoxOptions = {},
) {
  const bc = fg(P.line);
  const t = title ? ` ${title} ` : "";
  const r = right ? ` ${right} ` : "";
  const top = `${bc}╭─${RESET}${t}${bc}${"─".repeat(Math.max(w - 4 - vlen(t) - vlen(r), 0))}${RESET}${r}${bc}─╮${RESET}`;
  const out = [fit(top, w)];
  for (let i = 0; i < h - 2; i++) {
    const body = lines[i] ?? "";
    out.push(`${bc}│${RESET}${" ".repeat(pad)}${fit(body, w - 2 - 2 * pad)}${" ".repeat(pad)}${bc}│${RESET}`);
  }
  out.push(`${bc}╰${"─".repeat(w - 2)}╯${RESET}`);
  return out;
}

/** Put blocks of lines side by side. */
export function hjoin(cols: readonly (readonly string[])[], gap = 1): string[] {
  const rows = Math.max(0, ...cols.map((c) => c.length));
  return Array.from({ length: rows }, (_, i) => cols.map((c) => c[i] ?? "").join(" ".repeat(gap)));
}
