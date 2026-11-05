// One finding as a card. The finding's own sentences, list and
// suggested text are printed as the API sent them; the card
// words only its controls. The same card serves the detail
// panel and the session list, so a finding reads one way in both.

import { useEffect, useRef, useState } from "react";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { NewTabIcon } from "../components/icons.js";
import { gradeClass } from "./findings.js";
import { GradeMarker } from "./GradeMarker.js";
import { useSessionStore } from "./store.js";

const COPIED_MS = 2_000;

type CopyState = "idle" | "copied" | "failed";

/** The DOM id of a card's grade heading, which takes focus when
 * a neighbouring card is dismissed. The panel's card and the
 * list's card for one finding have different ids. */
export function findingHeadingId(
  place: "panel" | "list",
  findingId: string,
): string {
  return `finding-${place}-${findingId}`;
}

type ResetTimer = { current: ReturnType<typeof setTimeout> | null };

function cancelReset(timer: ResetTimer): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

function useCopy(text: string) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const timer = resetTimer;
    return () => cancelReset(timer);
  }, []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setState("failed");
      return;
    }
    // A second press while "Copied" shows starts the two seconds over.
    cancelReset(resetTimer);
    setState("copied");
    useSessionStore.getState().announce("Copied the suggested text.");
    resetTimer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return { state, copy };
}

function CopyButton({
  state,
  onCopy,
}: {
  state: CopyState;
  onCopy: () => void;
}) {
  const copied = state === "copied";
  return (
    <button
      type="button"
      className={copied ? "finding-copy finding-copied" : "finding-copy"}
      aria-label={
        copied ? "Copied the suggested text" : "Copy the suggested text"
      }
      onClick={onCopy}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function SuggestedText({ text, state }: { text: string; state: CopyState }) {
  return (
    <>
      <pre className="finding-code">
        <code>{text}</code>
      </pre>
      <p className="finding-status" role="status">
        {state === "failed"
          ? "Couldn't copy. Select the text above and copy it yourself."
          : ""}
      </p>
    </>
  );
}

function CardActions({
  finding,
  copy,
  onShowInSteps,
  onDismiss,
}: {
  finding: Finding;
  copy: ReturnType<typeof useCopy>;
  onShowInSteps: (() => void) | undefined;
  onDismiss: () => void;
}) {
  return (
    <div className="finding-actions">
      <a
        className="finding-doc"
        href={finding.doc.url}
        target="_blank"
        rel="noreferrer"
      >
        {finding.doc.label}
        <NewTabIcon />
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      {onShowInSteps !== undefined && (
        <button type="button" className="finding-show" onClick={onShowInSteps}>
          Show in steps
        </button>
      )}
      <span className="finding-buttons">
        {finding.copy !== null && (
          <CopyButton state={copy.state} onCopy={() => void copy.copy()} />
        )}
        <button
          type="button"
          className="finding-dismiss"
          aria-label="Dismiss this suggestion"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}

export function FindingCard({
  finding,
  place,
  dismissFailed,
  onShowInSteps,
  onDismiss,
}: {
  finding: Finding;
  place: "panel" | "list";
  dismissFailed: boolean;
  /** Present on a card whose finding is pinned to a step. */
  onShowInSteps?: (() => void) | undefined;
  onDismiss: () => void;
}) {
  const headingId = findingHeadingId(place, finding.id);
  const copy = useCopy(finding.copy ?? "");
  return (
    <article className="finding-card" aria-labelledby={headingId}>
      <h4
        id={headingId}
        tabIndex={-1}
        className={`finding-grade ${gradeClass(finding.grade)}`}
      >
        <GradeMarker grade={finding.grade} />
        {finding.grade}
      </h4>
      <p className="finding-headline">{finding.headline}</p>
      <p className="finding-body">{finding.body}</p>
      {finding.list.length > 0 && (
        <ul className="finding-items">
          {finding.list.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
      {finding.copy !== null && (
        <SuggestedText text={finding.copy} state={copy.state} />
      )}
      <CardActions
        finding={finding}
        copy={copy}
        onShowInSteps={onShowInSteps}
        onDismiss={onDismiss}
      />
      <p className="finding-status" role="status">
        {dismissFailed ? "Couldn't dismiss this suggestion. Try again." : ""}
      </p>
    </article>
  );
}
