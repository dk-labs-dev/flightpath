import type { ReactNode } from "react";

// The page's one save bar, pinned to the bottom of the screen
// column: it appears while anything differs from what's
// saved, counts what needs fixing after a refused save, and
// shows the saved line for a few seconds after a save. The
// status element lives for as long as the form does, empty
// while there's nothing to say: a live region announces text
// put into it, but one inserted along with its text is often
// read by no screen reader at all.

interface SaveBarProps {
  changedCount: number;
  fixCount: number;
  savedFlash: boolean;
  onCancel: () => void;
  onSave: () => void;
}

export function SaveBar({
  changedCount,
  fixCount,
  savedFlash,
  onCancel,
  onSave,
}: SaveBarProps): ReactNode {
  const unsaved = !savedFlash && changedCount > 0;
  let className = "save-bar save-bar-idle";
  if (savedFlash) {
    className = "save-bar save-bar-saved";
  } else if (unsaved) {
    className = "save-bar";
  }
  return (
    <div
      className={className}
      {...(unsaved ? { role: "region", "aria-label": "Unsaved changes" } : {})}
    >
      <p className="save-bar-text save-bar-status" role="status">
        {savedFlash ? "Saved. New sessions use these settings." : ""}
      </p>
      {unsaved && (
        <>
          <span className="save-bar-text">
            <span className="save-dot" aria-hidden="true" />
            {barText(changedCount, fixCount)}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-brand" onClick={onSave}>
            Save changes
          </button>
        </>
      )}
    </div>
  );
}

function barText(changedCount: number, fixCount: number): ReactNode {
  if (fixCount > 0) {
    return (
      <span className="save-bar-error">
        {`${fixCount} field${fixCount === 1 ? "" : "s"} need${fixCount === 1 ? "s" : ""} fixing`}
      </span>
    );
  }
  return `${changedCount} unsaved change${changedCount === 1 ? "" : "s"}`;
}
