export function stringifyValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
