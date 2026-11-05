// A small "?" beside a word the page uses, opening its
// one-line explanation. It works by click, tap and keyboard —
// never hover alone — and closes the same way it opened.

import { useId, useLayoutEffect, useRef, useState } from "react";

import {
  CHARS_PER_TOKEN,
  ESTIMATE_HINT,
  MEASURED_HINT,
} from "@flightpath/flightpath/format";

// The box that clips the note: its nearest ancestor that
// scrolls. A lens is a scrolling column whose edge can
// start well inside the window, and a note past that edge
// is cut off even while it is still on the screen.
function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node !== null) {
    const style = getComputedStyle(node);
    if (
      style.overflowY === "auto" ||
      style.overflowY === "scroll" ||
      style.overflowX === "auto" ||
      style.overflowX === "scroll"
    )
      return node;
    node = node.parentElement;
  }
  return null;
}

export function Explain({
  term,
  text,
  align,
}: {
  term: string;
  text: string;
  /** A word at the screen's right edge opens its note
   * leftwards, so the note stays on the screen. */
  align?: "right";
}) {
  const [open, setOpen] = useState(false);
  const noteRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const note = noteRef.current;
    if (!open || note === null) return;
    const box = note.getBoundingClientRect();
    // Where nothing is laid out there is no box to keep
    // inside the column, and nothing to shift.
    if (box.width === 0) return;
    // The note hangs from its "?", and a word can wrap too
    // close to the column's edge for the note to fit on the
    // side it opens to. Shift it back inside the column.
    const clip = scrollingAncestor(note)?.getBoundingClientRect();
    const left = clip === undefined ? 0 : clip.left;
    const right = clip === undefined ? window.innerWidth : clip.right;
    let shift = 0;
    if (box.left < left + 1) shift = left + 1 - box.left;
    else if (box.right > right - 1) shift = right - 1 - box.right;
    if (shift !== 0) note.style.transform = `translateX(${shift}px)`;
  }, [open]);
  return (
    <span className={align === "right" ? "explain explain-right" : "explain"}>
      <button
        type="button"
        className="explain-button"
        aria-label={`What is ${term}?`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        ?
      </button>
      {open && (
        <span className="explain-note" id={id} role="note" ref={noteRef}>
          {text}
        </span>
      )}
    </span>
  );
}

export const CONTEXT_EXPLANATION =
  "Everything Claude is holding in mind for the next request: instructions, the conversation so far, and tool results.";

export const WINDOW_HINT =
  "If this looks wrong, run /context once in Claude Code, and Flightpath reads the exact size from it. Its report goes into the conversation (about 9K tokens), so once is enough.";

export const COMPACTION_EXPLANATION =
  "Claude Code summarised the conversation to free up room in the context.";

export const RISES_EXPLANATION = `Totals are measured from Claude Code's own usage figures. A tool result that arrives alone is measured from its rise. Other sizes are estimated at about ${CHARS_PER_TOKEN} characters per token, so they won't add up exactly; the difference is shown as other.`;

export const MEASURED_EXPLANATION = MEASURED_HINT;

export const ESTIMATE_EXPLANATION = ESTIMATE_HINT;

export const NAMED_EXPLANATION =
  "How much of the context Flightpath can put a name to. The rest is listed as Other.";

export const OTHER_EXPLANATION =
  "The part of the context Flightpath can't name, mostly earlier conversation.";

export const FIXED_LOAD_EXPLANATION =
  "What Claude Code sends with every request before any work: its instructions, tool descriptions, CLAUDE.md and the skills list.";

export const LINK_EXPLANATION =
  "Steps linked: Claude Code's transcript says which step's result went into this request. Found by time: the steps that finished between the two requests.";
