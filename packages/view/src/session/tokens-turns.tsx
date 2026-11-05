// The tokens lens's turns table: one row per turn, the
// figures the daemon summed for it, sortable by every
// column in both directions. The prompt cell is the
// payload's own word: the kept first line, the prompt's
// length when only that was kept, or the plain fact that
// nothing was.

import { useMemo, useState } from "react";

import type {
  TokenHistory,
  TurnTokens,
} from "@flightpath/flightpath/api/payloads";
import { formatCount } from "@flightpath/flightpath/format";

/** The prompt cell's words, from the turn's own fields:
 * its first line when the wording was kept, its length
 * when only that was, and "not kept" when neither was. */
function promptCellText(turn: TurnTokens): string {
  if (turn.promptLine !== null) return turn.promptLine;
  if (turn.promptChars !== null) {
    return `length ${formatCount(turn.promptChars)}`;
  }
  return "not kept";
}

/** A turn's context change, signed, in the same plain
 * count every other token column reads; a turn with no
 * points on the main line has none to show. */
function changeText(change: number | null): string {
  if (change === null) return "—";
  if (change === 0) return "0";
  return change < 0 ? `−${formatCount(-change)}` : `+${formatCount(change)}`;
}

type ColumnKey =
  | "turn"
  | "prompt"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "change";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "turn", label: "Turn" },
  { key: "prompt", label: "Prompt" },
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "change", label: "Context change" },
];

interface TurnRow {
  turn: TurnTokens;
  prompt: string;
}

function sortValue(
  row: TurnRow,
  key: Exclude<ColumnKey, "prompt">,
): number | null {
  switch (key) {
    case "turn":
      return row.turn.sequence;
    case "input":
      return row.turn.input;
    case "output":
      return row.turn.output;
    case "cacheRead":
      return row.turn.cacheRead;
    case "cacheWrite":
      return row.turn.cacheWrite;
    case "change":
      return row.turn.contextChange;
  }
}

/** The value behind a prompt cell: the kept line itself,
 * or the length as a number when only that was kept, or
 * nothing when neither was. The column sorts by this,
 * never by the cell's formatted words — "length 74,210"
 * reads after "length 9,000", not before it. */
type PromptValue =
  | { kind: "line"; line: string }
  | { kind: "length"; chars: number }
  | { kind: "none" };

function promptValue(turn: TurnTokens): PromptValue {
  if (turn.promptLine !== null) return { kind: "line", line: turn.promptLine };
  if (turn.promptChars !== null) {
    return { kind: "length", chars: turn.promptChars };
  }
  return { kind: "none" };
}

function comparePrompt(
  a: TurnTokens,
  b: TurnTokens,
  direction: 1 | -1,
): number {
  const va = promptValue(a);
  const vb = promptValue(b);
  if (va.kind === "none" || vb.kind === "none") {
    // A prompt that was not kept stands last in both
    // directions, as an empty context change does.
    if (va.kind === vb.kind) return 0;
    return va.kind === "none" ? 1 : -1;
  }
  if (va.kind === "line") {
    return vb.kind === "line"
      ? va.line.localeCompare(vb.line) * direction
      : -direction;
  }
  if (vb.kind === "line") return direction;
  return (va.chars - vb.chars) * direction;
}

function compareRows(
  a: TurnRow,
  b: TurnRow,
  key: ColumnKey,
  direction: 1 | -1,
): number {
  if (key === "prompt") return comparePrompt(a.turn, b.turn, direction);
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return (va - vb) * direction;
}

/** A column's aria-sort: only the sorted column carries
 * one, naming the direction it is sorted in. */
function ariaSortFor(
  key: ColumnKey,
  sortKey: ColumnKey,
  direction: 1 | -1,
): "ascending" | "descending" | undefined {
  if (key !== sortKey) return undefined;
  return direction === 1 ? "ascending" : "descending";
}

function sortArrow(
  key: ColumnKey,
  sortKey: ColumnKey,
  direction: 1 | -1,
): string {
  if (key !== sortKey) return "";
  return direction === 1 ? " ↑" : " ↓";
}

interface TurnsHeadProps {
  sortKey: ColumnKey;
  direction: 1 | -1;
  onChoose: (key: ColumnKey) => void;
}

function TurnsHead({ sortKey, direction, onChoose }: TurnsHeadProps) {
  return (
    <thead>
      <tr>
        {COLUMNS.map((column) => (
          <th
            key={column.key}
            scope="col"
            aria-sort={ariaSortFor(column.key, sortKey, direction)}
          >
            <button type="button" onClick={() => onChoose(column.key)}>
              {column.label}
              {sortArrow(column.key, sortKey, direction)}
            </button>
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function TurnsTable({ history }: { history: TokenHistory }) {
  const [sortKey, setSortKey] = useState<ColumnKey>("turn");
  const [direction, setDirection] = useState<1 | -1>(1);
  const rows = useMemo<TurnRow[]>(
    () =>
      history.turns.map((turn) => ({
        turn,
        prompt: promptCellText(turn),
      })),
    [history],
  );
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          compareRows(a, b, sortKey, direction) ||
          a.turn.sequence - b.turn.sequence,
      ),
    [rows, sortKey, direction],
  );
  const choose = (key: ColumnKey): void => {
    if (key === sortKey) {
      setDirection((was) => (was === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setDirection(1);
    }
  };
  return (
    <section className="tokens-card" aria-label="Turns">
      <div className="tokens-table-scroll">
        <table className="tokens-turns-table">
          <caption>Turns, in tokens</caption>
          <TurnsHead
            sortKey={sortKey}
            direction={direction}
            onChoose={choose}
          />
          <tbody>
            {sorted.map((row) => (
              <tr key={row.turn.turnId}>
                <td>{formatCount(row.turn.sequence)}</td>
                <td className="tokens-turns-prompt">{row.prompt}</td>
                <td>{formatCount(row.turn.input)}</td>
                <td>{formatCount(row.turn.output)}</td>
                <td>{formatCount(row.turn.cacheRead)}</td>
                <td>{formatCount(row.turn.cacheWrite)}</td>
                <td>{changeText(row.turn.contextChange)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
