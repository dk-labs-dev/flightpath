export function commandOutputName(command: string): string {
  return `Output of ${command}`;
}

/** A turn that ran steps can only be shown at the request a
 * compaction opened, so it is not called a reply. */
export function requestTurnName(sequence: number, stepCount: number): string {
  return stepCount === 0
    ? `Turn ${sequence} · Claude replied`
    : `Turn ${sequence} · first request after the compaction`;
}
