// Safe readers for JSON we do not control. Each one takes `unknown` and returns a plain, typed value.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A string, or "" when the value is not one. */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A finite number, or null when the value is not one. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function bool(v: unknown): boolean {
  return v === true;
}
