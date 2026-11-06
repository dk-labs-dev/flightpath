// The shape of what the describer returns — a sentence plus
// the panel facts behind it. Stored rows live with their SQL.

export interface Fact {
  label: string;
  value: string;
}

export interface Described {
  sentence: string;
  facts: Fact[];
}

/** What the describer may be told about a step's surroundings. */
export interface StepContext {
  turnSequence?: number;
  branchName?: string;
  // "you", set only when an accepted decision's source names the user.
  approvedBy?: string;
  contextBefore?: number | null;
  contextAfter?: number | null;
  branchTotals?: {
    steps: number;
    requests: number;
    durationMs: number | null;
    /** The branch's first request's cache write, its cold start. */
    coldStartTokens?: number | null;
  };
  /** Whether the session's recorded sources include telemetry. */
  telemetrySeen?: boolean;
  sessionId?: string;
  savedOutputOf?: string;
  /** When set, a file path inside it is worded relative to it. */
  projectPath?: string;
}
