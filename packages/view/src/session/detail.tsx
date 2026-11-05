// The step detail panel: the step's sentence, then the
// panel facts the read API words for it, then the request
// that produced it. On a phone it is a sheet over the tree:
// it takes focus when it opens, traps it while open, and
// gives it back to the step's row when it closes.

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

import {
  formatClock,
  formatCount,
  formatDuration,
  formatTokens,
} from "@flightpath/flightpath/format";

import { DetailTabs } from "./DetailTabs.js";
import { findingsOnStep } from "./findings.js";
import { useFindingsState } from "./findings-context.js";
import { useSessionStore, type DetailState } from "./store.js";
import type {
  StepDetail,
  StepRequest,
} from "@flightpath/flightpath/api/payloads";

const KEEPS_NOTE =
  "Flightpath keeps paths, commands and sizes. File contents and tool output stay in Claude Code.";

/** A phone's width, asked the way the stylesheet asks it:
 * view.css lays the sheet out under the same query. */
export function isPhoneWidth(): boolean {
  return window.matchMedia("(max-width: 759px)").matches;
}

function tokenCell(value: number | null): string {
  return value === null ? "not recorded" : formatTokens(value, { exact: true });
}

function RequestTable({ request }: { request: StepRequest }) {
  return (
    <table className="request-table">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">In</th>
          <th scope="col">Out</th>
          <th scope="col">Cache read</th>
          <th scope="col">Cache write</th>
          <th scope="col">Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{request.model ?? "not recorded"}</td>
          <td>{tokenCell(request.inputTokens)}</td>
          <td>{tokenCell(request.outputTokens)}</td>
          <td>{tokenCell(request.cacheReadTokens)}</td>
          <td>{tokenCell(request.cacheWriteTokens)}</td>
          <td>
            {request.durationMs === null
              ? "not recorded"
              : formatDuration(request.durationMs)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function RequestFacts({
  request,
  position,
  total,
}: {
  request: StepRequest;
  /** The request's order within the step: 1-based. */
  position: number;
  total: number;
}) {
  const parts: string[] = [];
  if (request.startedAt !== null) {
    parts.push(`Started ${formatClock(request.startedAt)}`);
  }
  if (total > 1) {
    parts.push(`request ${formatCount(position)} of ${formatCount(total)}`);
  }
  return (
    <div className="detail-group">
      <h3>Request</h3>
      <RequestTable request={request} />
      {request.facts.length > 0 && (
        <dl className="fact-list">
          {request.facts.map((fact) => (
            <div className="fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="detail-meta">{parts.join(" · ")}</p>
    </div>
  );
}

function DetailBody({ data }: { data: StepDetail }) {
  const openStep = useSessionStore((s) => s.openStep);
  const printedBy = data.savedOutputStepId;
  return (
    <>
      <dl className="fact-list">
        {data.facts.map((fact) => (
          <div className="fact" key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {printedBy !== null && (
        <button
          type="button"
          className="detail-link"
          onClick={() => openStep(printedBy)}
        >
          Open the step that printed it
        </button>
      )}
      {data.requests.map((request, index) => (
        <RequestFacts
          key={request.id}
          request={request}
          position={index + 1}
          total={data.requests.length}
        />
      ))}
      <p className="detail-keeps">{KEEPS_NOTE}</p>
    </>
  );
}

function trapTab(panel: HTMLElement, event: globalThis.KeyboardEvent): void {
  // The tab order's ends: a tab left out of it, or a panel
  // that is hidden, is not somewhere focus can rest.
  const focusable = Array.from(
    panel.querySelectorAll<HTMLElement>("button, [href], input, [tabindex]"),
  ).filter((el) => el.tabIndex >= 0 && el.closest("[hidden]") === null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** The phone sheet owns focus while it is open; closing
 * returns focus to the step's row in the tree. */
function usePhoneSheet(
  panelRef: RefObject<HTMLElement | null>,
  openStepId: number | null,
  closeDetail: () => void,
): void {
  useEffect(() => {
    if (openStepId === null || !isPhoneWidth()) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const closeButton = panel.querySelector<HTMLElement>(".detail-close");
    closeButton?.focus();
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeDetail();
      } else if (event.key === "Tab") {
        trapTab(panel, event);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const row = document.querySelector<HTMLElement>(
        `[data-row-key="step-${openStepId}"]`,
      );
      row?.focus({ preventScroll: true });
    };
  }, [panelRef, openStepId, closeDetail]);
}

export function StepDetailPanel() {
  const detail = useSessionStore((s) => s.detail);
  const detailTab = useSessionStore((s) => s.detailTab);
  const setDetailTab = useSessionStore((s) => s.setDetailTab);
  const closeDetail = useSessionStore((s) => s.closeDetail);
  const { findings, anchors } = useFindingsState();
  const panelRef = useRef<HTMLElement>(null);
  const openStepId = detail?.stepId ?? null;
  const suggestions = useMemo(
    () =>
      openStepId === null ? [] : findingsOnStep(findings, anchors, openStepId),
    [findings, anchors, openStepId],
  );
  const focusTitle = useCallback(() => {
    panelRef.current?.querySelector<HTMLElement>(".detail-title")?.focus();
  }, []);

  usePhoneSheet(panelRef, openStepId, closeDetail);

  if (detail === null) {
    return (
      <aside className="detail detail-empty" aria-label="Step detail">
        <p className="empty">Pick a step to read what it did.</p>
      </aside>
    );
  }
  const details = (
    <>
      {detail.status === "loading" && (
        <p className="detail-status">Loading the step&rsquo;s details…</p>
      )}
      {detail.status === "error" && (
        <p className="detail-status">
          This step&rsquo;s details couldn&rsquo;t be loaded.
        </p>
      )}
      {detail.status === "ready" && <DetailBody data={detail.data} />}
    </>
  );
  return (
    <aside
      className="detail"
      aria-label="Step detail"
      ref={panelRef}
      data-detail-for={detail.stepId}
    >
      <DetailHead detail={detail} onClose={closeDetail} />
      {suggestions.length === 0 ? (
        details
      ) : (
        <DetailTabs
          suggestions={suggestions}
          tab={detailTab}
          onTab={setDetailTab}
          onDismissed={focusTitle}
        >
          {details}
        </DetailTabs>
      )}
    </aside>
  );
}

function DetailHead({
  detail,
  onClose,
}: {
  detail: DetailState;
  onClose: () => void;
}) {
  const step = useSessionStore((s) => s.steps.get(detail.stepId));
  const sentence =
    detail.status === "ready" ? detail.data.sentence : (step?.sentence ?? "");
  return (
    <div className="detail-head">
      <h2 className="detail-title" tabIndex={-1}>
        {sentence}
      </h2>
      <button
        type="button"
        className="detail-close"
        aria-label="Close step details"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
