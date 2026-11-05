import { MEASURED_HINT } from "@flightpath/flightpath/format";

/** The "measured" tag on a size read off the context's rise;
 * each lens styles it with its own class. */
export function MeasuredTag({ className }: { className: string }) {
  return (
    <span className={className} title={MEASURED_HINT}>
      measured
    </span>
  );
}
