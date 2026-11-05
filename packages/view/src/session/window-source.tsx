import { KNOWN_WINDOWS } from "@flightpath/flightpath/api/context-limit";
import type { ContextWindow } from "@flightpath/flightpath/api/payloads";
import { formatClock, formatTokens } from "@flightpath/flightpath/format";

import { Explain, WINDOW_HINT } from "./explain.js";

function windowBelow(tokens: number): number | null {
  let below: number | null = null;
  for (const size of KNOWN_WINDOWS) {
    if (size >= tokens) break;
    below = size;
  }
  return below;
}

function windowSize(tokens: number): string {
  return formatTokens(tokens, { axis: true });
}

function ReportSource({ reportedAt }: { reportedAt: number | null }) {
  return (
    <>
      from your <code>/context</code>
      {reportedAt !== null && <> at {formatClock(reportedAt)}</>}
    </>
  );
}

/** The hint stands beside every window but a report's:
 * the list can be stale and a measurement is only a
 * floor, so only a report confirms the size. */
function WindowHint({ window }: { window: ContextWindow }) {
  if (window.source === "context-command") return null;
  return (
    <>
      {" "}
      <Explain term="the window size" text={WINDOW_HINT} />
    </>
  );
}

/** The room panel's words for one source: the window and
 * where it came from; an unknown window names the model
 * it isn't known for instead. */
function RoomSourceText({
  window,
  model,
}: {
  window: ContextWindow;
  model: string | null;
}) {
  if (window.source === "unknown" || window.tokens === null) {
    return (
      <>
        Window not known
        {model !== null && (
          <>
            {" "}
            for <code>{model}</code>
          </>
        )}
      </>
    );
  }
  if (window.source === "model-list") {
    return (
      <>{windowSize(window.tokens)} window · from Claude&rsquo;s model list</>
    );
  }
  if (window.source === "context-command") {
    return (
      <>
        {windowSize(window.tokens)} window ·{" "}
        <ReportSource reportedAt={window.reportedAt} />
      </>
    );
  }
  const past = windowBelow(window.tokens);
  return (
    <>
      At least {windowSize(window.tokens)} window
      {past !== null && <> · this session went past {windowSize(past)}</>}
    </>
  );
}

export function WindowSourceLine({
  window,
  model,
}: {
  window: ContextWindow;
  model: string | null;
}) {
  return (
    <p className="tokens-room-source">
      <RoomSourceText window={window} model={model} />
      <WindowHint window={window} />
    </p>
  );
}

function SummarySourceText({ window }: { window: ContextWindow }) {
  if (window.source === "model-list") {
    return <>from Claude&rsquo;s model list</>;
  }
  if (window.source === "context-command") {
    return <ReportSource reportedAt={window.reportedAt} />;
  }
  if (window.source === "inferred" && window.tokens !== null) {
    return <>at least {windowSize(window.tokens)}, inferred</>;
  }
  return <>window not known</>;
}

export function SummaryWindowSource({ window }: { window: ContextWindow }) {
  return (
    <>
      {" · "}
      <SummarySourceText window={window} />
      <WindowHint window={window} />
    </>
  );
}
