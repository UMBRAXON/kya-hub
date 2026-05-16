export function fill(
  s: string,
  vars: Record<string, string | number>
): string {
  return s.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{${key}}`
  );
}
