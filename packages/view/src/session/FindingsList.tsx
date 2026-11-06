// The session's findings as one heading above the step tree,
// with the worst grade's marker and the count. It opens to the
// same cards the detail panel shows. It starts open when any
// finding is worth fixing and shut otherwise, every time the
// screen opens, and renders nothing when there is nothing to say.

import { useEffect, useRef, useState } from "react";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { ChevronIcon } from "../components/icons.js";
import { findingHeadingId, FindingCard } from "./FindingCard.js";
import { anchoredStep, listLine, worstGrade } from "./findings.js";
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
    <h3 className="findings-heading">
      <button
        type="button"
        className="findings-toggle"
        aria-expanded={open}
        aria-controls={REGION_ID}
        onClick={onToggle}
      >
        <ChevronIcon open={open} size={14} />
        <GradeMarker grade={worstGrade(findings.map((f) => f.grade))} />
        <span className="findings-line">{listLine(findings)}</span>
      </button>
    </h3>
  );
}

// Only the person's own choice is stored, so a finding worth fixing
// that arrives or goes moves the default.
function useListOpen(
  findings: readonly Finding[],
): [boolean, (open: boolean) => void] {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const worthFixing = findings.some(
    (finding) => finding.grade === "Worth fixing",
  );
  return [chosen ?? worthFixing, setChosen];
}

interface PendingFocus {
  goneId: string;
  neighbour: Finding | undefined;
}

// Dismisses the finding at an index and, once the list has
// re-rendered without it, moves focus to a card that is still there.
function useDismissWithFocus(
  findings: readonly Finding[],
  dismiss: (findingId: string) => Promise<boolean>,
): (index: number) => void {
  const pendingFocus = useRef<PendingFocus | null>(null);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    if (findings.some((finding) => finding.id === pending.goneId)) return;
    pendingFocus.current = null;
    focusAfterDismiss(pending.neighbour);
  }, [findings]);
  return (index) => {
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
}

export function FindingsList({
  onShowInSteps,
}: {
  onShowInSteps: (stepId: number) => void;
}) {
  const { findings, anchors, failedId, dismiss } = useFindingsState();
  const [open, setOpen] = useListOpen(findings);
  const dismissAt = useDismissWithFocus(findings, dismiss);

  if (findings.length === 0) return null;

  // The next card takes focus, so the list stays open even when
  // the card dismissed was the last finding worth fixing.
  const dismissCard = (index: number): void => {
    setOpen(true);
    dismissAt(index);
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
