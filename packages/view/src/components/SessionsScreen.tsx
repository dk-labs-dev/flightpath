// The session picker: what is recording now, then every
// earlier session in day folders by start time, newest first,
// one click from its view. The list arrives from the shell,
// which keeps it fresh; this screen only shapes it.

import { useState } from "react";

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatTokens,
} from "@flightpath/flightpath/format";

import { countLine } from "../counts";
import { sessionHref } from "../route";
import { useClockStore, useClockTick } from "../session/clock";
import {
  filterSessions,
  groupByDay,
  projectName,
  projectNames,
  quietSince,
  sessionStateLabel,
  type DayFolder,
} from "../sessions/model";
import { ChevronIcon } from "./icons";

const PAGE = 200;

interface Filter {
  query: string;
  project: string | null;
}

function filterFromHash(): Filter {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return {
    query: query.get("q") ?? "",
    project: query.get("project"),
  };
}

function writeFilterToHash(filter: Filter): void {
  const params = new URLSearchParams();
  if (filter.query !== "") {
    params.set("q", filter.query);
  }
  if (filter.project !== null) {
    params.set("project", filter.project);
  }
  const suffix = params.toString();
  history.replaceState(
    null,
    "",
    window.location.pathname + "#sessions" + (suffix ? `?${suffix}` : ""),
  );
}

function LiveCard({ session }: { session: SessionListItem }) {
  const nowMs = useClockStore((s) => s.nowMs);
  const quiet = quietSince(session, nowMs);
  let turn = "no turns yet";
  if (session.turns > 0) {
    // A quiet session's latest turn is not running: nothing
    // has been heard from it for minutes.
    turn =
      quiet !== null
        ? `turn ${session.turns}`
        : `turn ${session.turns} running`;
  }
  const where = session.project === null ? "" : `${session.project} · `;
  const state = sessionStateLabel(session, nowMs).text;
  return (
    <a className="live-card" href={sessionHref(session.id)}>
      <span className="live-main">
        <span className="live-title">
          <span className="live-dot" aria-hidden="true"></span>
          {session.title}
        </span>
        <span className="live-meta">
          {where}
          {state} · {turn}
        </span>
      </span>
      <span className="live-stats">
        <span>
          <b>{formatCount(session.steps)}</b> steps
        </span>
        {session.contextNow !== null ? (
          <span>
            context <b>{formatTokens(session.contextNow)}</b>
          </span>
        ) : null}
        <span className="live-open">Open →</span>
      </span>
    </a>
  );
}

function SessionRow({ session }: { session: SessionListItem }) {
  const end = session.endedAt ?? session.lastActivityAt;
  const started = new Date(session.startedAt).toLocaleString("en-GB");
  return (
    <tr>
      <td className="cell-title">
        <a
          href={sessionHref(session.id)}
          title={`Started ${started} · ${session.id}`}
        >
          {session.title}
        </a>
      </td>
      <td className="cell-project">{projectName(session.project) ?? "—"}</td>
      <td className="cell-when">
        {formatClock(session.startedAt)} ·{" "}
        {formatDuration(Math.max(0, end - session.startedAt))}
      </td>
      <td className="cell-num">{formatCount(session.turns)}</td>
      <td className="cell-num">{formatTokens(session.tokensProcessed)}</td>
      <td className="cell-note">{session.note}</td>
    </tr>
  );
}

function DayHeadingRow({
  folder,
  open,
  onToggle,
}: {
  folder: DayFolder;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="day-row">
      <th colSpan={6} scope="colgroup">
        <button
          type="button"
          className="day-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronIcon open={open} size={16} />
          {folder.heading} ·{" "}
          {countLine(folder.sessions.length, "session", "sessions")}
        </button>
      </th>
    </tr>
  );
}

function PickerControls({
  earlier,
  filter,
  onFilter,
}: {
  earlier: SessionListItem[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  return (
    <div className="picker-controls">
      <h2 id="recent-h" className="picker-heading">
        Earlier sessions
      </h2>
      <label className="visually-hidden" htmlFor="picker-search">
        Search sessions
      </label>
      <input
        id="picker-search"
        type="search"
        placeholder="Search titles and projects"
        value={filter.query}
        onChange={(event) => onFilter({ ...filter, query: event.target.value })}
      />
      <label htmlFor="picker-project">Project</label>
      <select
        id="picker-project"
        value={filter.project ?? ""}
        onChange={(event) =>
          onFilter({
            ...filter,
            project: event.target.value === "" ? null : event.target.value,
          })
        }
      >
        <option value="">All projects</option>
        {projectNames(earlier).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

function SessionTable({
  folders,
  isOpen,
  onToggle,
}: {
  folders: DayFolder[];
  isOpen: (folder: DayFolder) => boolean;
  onToggle: (folder: DayFolder) => void;
}) {
  return (
    <div className="picker-table-scroll">
      <table className="picker-table">
        <caption className="visually-hidden">Earlier sessions</caption>
        <thead>
          <tr>
            <th>Session</th>
            <th>Project</th>
            <th>When</th>
            <th className="cell-head-num">Turns</th>
            <th className="cell-head-num">Tokens processed</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {folders.map((folder) => [
            <DayHeadingRow
              key={folder.key}
              folder={folder}
              open={isOpen(folder)}
              onToggle={() => onToggle(folder)}
            />,
            ...(isOpen(folder)
              ? folder.sessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))
              : []),
          ])}
        </tbody>
      </table>
    </div>
  );
}

function EarlierSection({
  earlier,
  emptyHidden,
  retentionDays,
}: {
  earlier: SessionListItem[];
  emptyHidden: number;
  retentionDays: number | null;
}) {
  const [filter, setFilter] = useState<Filter>(() => filterFromHash());
  const [shown, setShown] = useState(PAGE);
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const filtering = filter.query.trim() !== "" || filter.project !== null;
  const matched = filterSessions(earlier, filter.query, filter.project);
  const folders = groupByDay(matched.slice(0, shown), Date.now());
  const applyFilter = (next: Filter) => {
    setFilter(next);
    setShown(PAGE);
    writeFilterToHash(next);
  };
  const isOpen = (folder: DayFolder): boolean =>
    openOverrides[folder.key] ?? (filtering || folder.heading === "Today");
  const toggle = (folder: DayFolder) =>
    setOpenOverrides((current) => ({
      ...current,
      [folder.key]: !isOpen(folder),
    }));

  return (
    <section aria-labelledby="recent-h" className="picker-section">
      <PickerControls
        earlier={earlier}
        filter={filter}
        onFilter={applyFilter}
      />
      {matched.length === 0 ? (
        <p className="picker-none">No sessions match that search.</p>
      ) : (
        <SessionTable folders={folders} isOpen={isOpen} onToggle={toggle} />
      )}
      {matched.length > shown ? (
        <button
          type="button"
          className="picker-more"
          onClick={() => setShown((count) => count + PAGE)}
        >
          Show more sessions
        </button>
      ) : null}
      <ListFootnotes emptyHidden={emptyHidden} retentionDays={retentionDays} />
    </section>
  );
}

/** The lines under the list: what the list is not showing. */
function ListFootnotes({
  emptyHidden,
  retentionDays,
}: {
  emptyHidden: number;
  retentionDays: number | null;
}) {
  return (
    <>
      {emptyHidden > 0 ? (
        <p className="empty-hidden-line">
          {countLine(emptyHidden, "empty session", "empty sessions")} not shown.
        </p>
      ) : null}
      {retentionDays !== null ? (
        <p className="retention-line">
          Sessions older than {retentionDays} days are deleted automatically.
          Change that in <a href="#settings">Settings</a>.
        </p>
      ) : null}
    </>
  );
}

/** The live cards, kept on the shared clock: a card turns
 * quiet when the clock passes the quiet limit, not only when
 * new data lands — a quiet session is exactly the one no new
 * data arrives for. */
function LiveSection({ sessions }: { sessions: SessionListItem[] }) {
  useClockTick();
  return (
    <section aria-labelledby="live-h" className="picker-section">
      <h2 id="live-h" className="picker-heading">
        Recording now
      </h2>
      {sessions.map((session) => (
        <LiveCard key={session.id} session={session} />
      ))}
    </section>
  );
}

export function SessionsScreen({
  sessions,
  emptyHidden,
  failed,
  retentionDays,
}: {
  sessions: SessionListItem[] | null;
  emptyHidden: number;
  failed: boolean;
  retentionDays: number | null;
}) {
  // A failed load says so in one line; the last list, when
  // there is one, stays on screen under it.
  const failureLine = failed ? (
    <p className="load-failed">Couldn't load sessions. Retrying…</p>
  ) : null;
  if (sessions === null) {
    return failureLine;
  }
  if (sessions.length === 0) {
    return (
      <>
        {failureLine}
        <p className="empty">
          No sessions yet. Start Claude Code in a project where Flightpath is
          installed.
        </p>
      </>
    );
  }
  const live = sessions.filter((session) => session.status === "live");
  const earlier = sessions.filter((session) => session.status !== "live");
  return (
    <div className="picker">
      {failureLine}
      {live.length > 0 ? <LiveSection sessions={live} /> : null}
      <EarlierSection
        earlier={earlier}
        emptyHidden={emptyHidden}
        retentionDays={retentionDays}
      />
    </div>
  );
}
