// The session's findings as one collapsed line above the step
// tree. It opens to the same cards the detail panel shows. It
// starts shut every time the screen opens, and renders nothing
// when there is nothing to say.

import { useEffect, useRef, useState } from "react";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { ChevronIcon } from "../components/icons.js";
import { findingHeadingId, FindingCard } from "./FindingCard.js";
import { anchoredStep, listLine } from "./findings.js";
import { useFindingsState } from "./findings-context.js";
import { GradeMarker } from "./GradeMarker.js";

const REGION_ID = "findings-list-region";

// Focus goes to the next card, else the previous one; when the
// list itself is gone, to the tree's tab stop, else the search box.
function focusAfterDismiss(neighbour: Finding | undefined): void {
  const target =
    neighbour === undefined
      ? (document.querySelector<HTMLElement>(
          '.tree-scroll [role="treeitem"][tabindex="0"]',
        ) ?? document.getElementById("step-search"))
      : document.getElementById(findingHeadingId("list", neighbour.id));
  target?.focus();
}

function ListToggle({
  findings,
  open,
  onToggle,
}: {
  findings: readonly Finding[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="findings-toggle"
      aria-expanded={open}
      aria-controls={REGION_ID}
      onClick={onToggle}
    >
      <ChevronIcon open={open} size={14} />
      <span className="findings-line">{listLine(findings)}</span>
      {!open && (
        <span className="findings-grades" aria-hidden="true">
          {findings.map((finding) => (
            <GradeMarker key={finding.id} grade={finding.grade} />
          ))}
        </span>
      )}
    </button>
  );
}

interface PendingFocus {
  goneId: string;
  neighbour: Finding | undefined;
}

export function FindingsList({
  onShowInSteps,
}: {
  onShowInSteps: (stepId: number) => void;
}) {
  const { findings, anchors, failedId, dismiss } = useFindingsState();
  const [open, setOpen] = useState(false);
  const pendingFocus = useRef<PendingFocus | null>(null);

  // Focus moves once the list has re-rendered without the
  // dismissed card, so it lands on a card that is still there.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (findings.some((finding) => finding.id === pending.goneId)) return;
    pendingFocus.current = null;
    focusAfterDismiss(pending.neighbour);
  }, [findings]);

  if (findings.length === 0) return null;

  const dismissCard = (index: number): void => {
    const gone = findings[index];
    if (gone === undefined) return;
    pendingFocus.current = {
      goneId: gone.id,
      neighbour: findings[index + 1] ?? findings[index - 1],
    };
    void dismiss(gone.id).then((done) => {
      if (!done) pendingFocus.current = null;
    });
  };

  return (
    <div className="findings-list">
      <ListToggle
        findings={findings}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      <div
        id={REGION_ID}
        className="findings-region"
        role="region"
        aria-label="Suggestions for this session"
        hidden={!open}
      >
        {findings.map((finding, index) => {
          const step = anchoredStep(anchors.get(finding.id));
          return (
            <FindingCard
              key={finding.id}
              finding={finding}
              place="list"
              dismissFailed={failedId === finding.id}
              onShowInSteps={
                step === null ? undefined : () => onShowInSteps(step)
              }
              onDismiss={() => dismissCard(index)}
            />
          );
        })}
      </div>
    </div>
  );
}
