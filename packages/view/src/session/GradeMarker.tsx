// The shape that says a finding's grade without colour: a filled
// circle, a ring or a filled square, drawn in the text colour so
// forced-colour modes still tell the three apart.

import type { FindingGrade } from "@flightpath/flightpath/api/payloads";

import { gradeClass } from "./findings.js";

function Shape({ grade }: { grade: FindingGrade }) {
  switch (grade) {
    case "Worth fixing":
      return <circle cx="5" cy="5" r="5" fill="currentColor" />;
    case "Worth a look":
      return (
        <circle
          cx="5"
          cy="5"
          r="4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      );
    case "Did you know":
      return <rect x="0.5" y="0.5" width="9" height="9" fill="currentColor" />;
  }
}

/** Named, it is an image for a screen reader; without a name it
 * is decoration beside the words that already say the grade. */
export function GradeMarker({
  grade,
  name,
}: {
  grade: FindingGrade;
  name?: string;
}) {
  const label =
    name === undefined
      ? { "aria-hidden": true }
      : { role: "img", "aria-label": name };
  return (
    <svg
      className={`grade-marker ${gradeClass(grade)}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      {...label}
    >
      <Shape grade={grade} />
    </svg>
  );
}
