// The describer's wording tools: how a missing value is
// said out loud, and the small text shapes sentences share.

// Telemetry is blamed only when the session's sources have none; else "unknown".
export function notRecorded(telemetrySeen: boolean | undefined): string {
  return telemetrySeen === false ? "not recorded (telemetry off)" : "unknown";
}

export function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/** A path below the project, from the project's folder; any other path as
 * it was. A Windows project matches in any case and with either slash. */
export function relativeToProject(path: string, project: string): string {
  const root = project.replace(/[\\/]+$/, "");
  const windows = /^[A-Za-z]:/.test(root);
  const comparable = (text: string): string =>
    windows ? text.replaceAll("\\", "/").toLowerCase() : text;
  return comparable(path).startsWith(`${comparable(root)}/`)
    ? path.slice(root.length + 1)
    : path;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
