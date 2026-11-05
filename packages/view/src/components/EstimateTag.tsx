import { ESTIMATE_HINT } from "@flightpath/flightpath/format";

/** The "est." tag on an estimated size; each lens styles it
 * with its own class. */
export function EstimateTag({ className }: { className: string }) {
  return (
    <span className={className} title={ESTIMATE_HINT}>
      est.
    </span>
  );
}
