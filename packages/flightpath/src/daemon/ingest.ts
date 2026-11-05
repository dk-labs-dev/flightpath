import { statSync } from "node:fs";

import { REDACTION_VERSION, redactHookEvent } from "../redact/index.js";
import type { Storage } from "../storage/index.js";

// One envelope in: re-redact, dedupe, store. The hook already
// redacted before delivery, but the daemon is the boundary that
// persists data, so it applies redaction again rather than
// trusting what arrived (ADR-0017).

export interface Envelope {
  /** Stable per event, made by the hook: the daemon dedupes on it. */
  id: string;
  received_at: number;
  redaction_version: number;
  plugin_version: string;
  event: Record<string, unknown>;
}

export type IngestResult = "stored" | "duplicate" | "forgotten";

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.received_at === "number" &&
    typeof e.event === "object" &&
    e.event !== null &&
    !Array.isArray(e.event)
  );
}

/**
 * An InstructionsLoaded event gains its file's size here, in
 * the daemon: the hook only reports the path, and the size is
 * a fact about the file at the moment it loaded. The size
 * rides on the stored event, so the stored event is the
 * size's record. A file already gone gains nothing.
 */
function withInstructionSize(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (event.hook_event_name !== "InstructionsLoaded") return event;
  const filePath = event.file_path;
  if (typeof filePath !== "string") return event;
  try {
    return { ...event, file_size_bytes: statSync(filePath).size };
  } catch {
    return event;
  }
}

export function ingestEnvelope(
  storage: Storage,
  envelope: Envelope,
): IngestResult {
  const event = withInstructionSize(envelope.event);
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : undefined;
  if (sessionId !== undefined && storage.isForgotten(sessionId)) {
    return "forgotten";
  }
  const stored: Envelope = { ...envelope, event: redactHookEvent(event) };
  // The stored row is stamped with this pass's redaction version:
  // the body it holds was produced by the daemon's re-redaction,
  // not by whatever version the envelope arrived with.
  const inserted = storage.insertEnvelopeJourney(
    {
      source: "hook",
      ...(sessionId !== undefined ? { sessionId } : {}),
      receivedAt: envelope.received_at,
      redactionVersion: REDACTION_VERSION,
      envelopeId: envelope.id,
      body: JSON.stringify(stored),
    },
    stored.event,
  );
  return inserted ? "stored" : "duplicate";
}
