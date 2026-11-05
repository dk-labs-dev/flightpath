// The detail panel's two tabs, shown only for a step that has
// suggestions: Details is the panel as it always was, Suggestions
// holds the step's cards. The tabs follow the ARIA pattern, with
// the arrow keys moving between them and selecting as they go.

import { useRef, type KeyboardEvent, type ReactNode } from "react";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { FindingCard } from "./FindingCard.js";
import { worstGrade } from "./findings.js";
import { useFindingsState } from "./findings-context.js";
import { GradeMarker } from "./GradeMarker.js";
import type { DetailTab } from "./store.js";

const TABS: readonly DetailTab[] = ["details", "suggestions"];

function targetTab(key: string, from: number): number | null {
  const last = TABS.length - 1;
  switch (key) {
    case "ArrowRight":
      return from === last ? 0 : from + 1;
    case "ArrowLeft":
      return from === 0 ? last : from - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

function SuggestionCards({
  suggestions,
  onDismissed,
}: {
  suggestions: readonly Finding[];
  onDismissed: () => void;
}) {
  const { failedId, dismiss } = useFindingsState();
  return suggestions.map((finding) => (
    <FindingCard
      key={finding.id}
      finding={finding}
      place="panel"
      dismissFailed={failedId === finding.id}
      onDismiss={() => {
        void dismiss(finding.id).then((done) => {
          if (done) onDismissed();
        });
      }}
    />
  ));
}

function DetailTabList({
  suggestions,
  tab,
  onTab,
}: {
  suggestions: readonly Finding[];
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}) {
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const next = targetTab(event.key, index);
    const nextTab = next === null ? undefined : TABS[next];
    if (next === null || nextTab === undefined) return;
    event.preventDefault();
    onTab(nextTab);
    tabButtons.current[next]?.focus();
  };
  return (
    <div className="detail-tabs" role="tablist" aria-label="Step">
      {TABS.map((name, index) => (
        <button
          key={name}
          ref={(button) => {
            tabButtons.current[index] = button;
          }}
          type="button"
          role="tab"
          id={`detail-tab-${name}`}
          aria-selected={name === tab}
          aria-controls={`detail-panel-${name}`}
          tabIndex={name === tab ? 0 : -1}
          className={name === tab ? "detail-tab detail-tab-on" : "detail-tab"}
          onClick={() => onTab(name)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {name === "details" ? (
            "Details"
          ) : (
            <>
              <GradeMarker
                grade={worstGrade(suggestions.map((s) => s.grade))}
              />
              {`Suggestions · ${suggestions.length}`}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export function DetailTabs({
  suggestions,
  tab,
  onTab,
  onDismissed,
  children,
}: {
  suggestions: readonly Finding[];
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  /** Called once a card's dismissal is done, to place focus. */
  onDismissed: () => void;
  /** The Details panel's content. */
  children: ReactNode;
}) {
  return (
    <>
      <DetailTabList suggestions={suggestions} tab={tab} onTab={onTab} />
      <div
        role="tabpanel"
        id="detail-panel-details"
        aria-labelledby="detail-tab-details"
        className="detail-tabpanel"
        hidden={tab !== "details"}
      >
        {children}
      </div>
      <div
        role="tabpanel"
        id="detail-panel-suggestions"
        aria-label={suggestions.length === 1 ? "Suggestion" : "Suggestions"}
        className="detail-tabpanel detail-cards"
        hidden={tab !== "suggestions"}
      >
        <SuggestionCards suggestions={suggestions} onDismissed={onDismissed} />
      </div>
    </>
  );
}
