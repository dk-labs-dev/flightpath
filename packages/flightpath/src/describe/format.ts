// The describer's wording tools: how a missing value is
// said out loud, and the small text shapes sentences share.

// Telemetry is blamed only when the session's sources have none; else "unknown".
export function notRecorded(telemetrySeen: boolean | undefined): string {
  return telemetrySeen === false ? "not recorded (telemetry off)" : "unknown";
}

export function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
