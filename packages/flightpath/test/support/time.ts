export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The value at a fraction through a set of timings. */
export function percentileOf(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * fraction)] ?? 0;
}

/** The reported middle value of a set of timings. */
export function medianOf(values: number[]): number {
  return percentileOf(values, 0.5);
}

// Hosted macOS runners have no GPU, so a frame budget there measures the runner (ci.yml).
export const frameBudgetHolds = process.env.FLIGHTPATH_NO_GPU !== "1";

// Hosted runners pause processes now and then, so a timing bound there measures the runner.
export const onHostedRunner = process.env.GITHUB_ACTIONS === "true";
