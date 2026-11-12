export function AlertIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"></path>
      <path d="M 12 9v4"></path>
      <path d="M 12 17h.01"></path>
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M 4 7h16M 4 12h16M 4 17h16"></path>
    </svg>
  );
}

/** The paper plane's path data, drawn once for every place
 * the plane appears — the app's mark, a running step's tile,
 * the curve's live tip, the share card's canvas. Colour
 * comes from the context the plane sits in: classes in the
 * stylesheet, the palette on the canvas. */
export const PLANE_BODY_PATH =
  "M21.5 3 2.5 10.2l7.3 2.7L21.5 3l-8.9 11.6 2.7 7.4L21.5 3z";
export const PLANE_LINE_PATH = "M9.8 12.9 12.6 14.6";

function PlanePaths() {
  return (
    <>
      <path
        d={PLANE_BODY_PATH}
        className="plane-body"
        strokeWidth="1.7"
        strokeLinejoin="round"
      ></path>
      <path d={PLANE_LINE_PATH} className="plane-line" strokeWidth="1.7"></path>
    </>
  );
}

/** The paper plane, at the size its context asks for. */
export function PlaneIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <PlanePaths />
    </svg>
  );
}

export function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <path
        d="M 2.5 23.5 C 7 23.5, 9.5 17.5, 14.5 15"
        className="mark-trail"
      ></path>
      <g transform="translate(6.2 0.2) scale(0.92)">
        <PlanePaths />
      </g>
    </svg>
  );
}

export function SessionsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M 4 6h16M 4 12h16M 4 18h10"></path>
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M 4 7h10M 18 7h2M 4 17h4M 12 17h8"></path>
      <circle cx="16" cy="7" r="2"></circle>
      <circle cx="10" cy="17" r="2"></circle>
    </svg>
  );
}

/** The chevron that says a row opens or closes: right when shut, down when open. */
export function ChevronIcon({ open, size }: { open: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      <path d="M 9 5l7 7-7 7"></path>
    </svg>
  );
}

/** The share glyph: three points joined, as the button
 * that makes the share card carries it. */
export function ShareIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3"></circle>
      <circle cx="6" cy="12" r="3"></circle>
      <circle cx="18" cy="19" r="3"></circle>
      <path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"></path>
    </svg>
  );
}

/** The mark beside a link that opens in a new tab. */
export function NewTabIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>
    </svg>
  );
}
