// The findings the steps screen shows, read once and shared by the
// list, the tree's markers and the detail panel, so the three show
// the same findings pinned to the same rows. The read runs only
// while the steps lens is mounted; until it answers, and if it
// fails, the screen shows nothing about findings.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { Finding } from "@flightpath/flightpath/api/payloads";

import { dismissFinding, findingsQueryKey, useFindings } from "./api.js";
import { anchorFindings, NO_ANCHORS, type Anchors } from "./findings.js";
import { useSessionStore } from "./store.js";

export interface FindingsState {
  findings: readonly Finding[];
  anchors: Anchors;
  /** The finding whose latest dismissal failed, if any. */
  failedId: string | null;
  /** Dismiss a finding; true once it is gone from the list. A
   * finding already being dismissed shares the pending answer. */
  dismiss: (findingId: string) => Promise<boolean>;
}

const NO_FINDINGS: readonly Finding[] = [];

const NOTHING: FindingsState = {
  findings: NO_FINDINGS,
  anchors: NO_ANCHORS,
  failedId: null,
  dismiss: () => Promise.resolve(false),
};

const FindingsContext = createContext<FindingsState>(NOTHING);

export function useFindingsState(): FindingsState {
  return useContext(FindingsContext);
}

async function dismissInCache(
  client: QueryClient,
  token: string,
  sessionId: string,
  findingId: string,
): Promise<void> {
  await dismissFinding(token, sessionId, findingId);
  const key = findingsQueryKey(sessionId);
  // A read that began before the dismissal landed would bring
  // the finding back when it resolved.
  await client.cancelQueries({ queryKey: key });
  client.setQueryData<Finding[] | null>(key, (list) =>
    list?.filter((finding) => finding.id !== findingId),
  );
}

function useDismissal(sessionId: string, token: string | null) {
  const client = useQueryClient();
  const [failedId, setFailedId] = useState<string | null>(null);
  const pending = useRef(new Map<string, Promise<boolean>>());
  const dismiss = useCallback(
    (findingId: string): Promise<boolean> => {
      const running = pending.current.get(findingId);
      if (running !== undefined) return running;
      if (token === null) return Promise.resolve(false);
      setFailedId(null);
      const request = dismissInCache(client, token, sessionId, findingId)
        .then(
          () => {
            useSessionStore.getState().announce("Suggestion dismissed.");
            return true;
          },
          () => {
            setFailedId(findingId);
            return false;
          },
        )
        .finally(() => pending.current.delete(findingId));
      pending.current.set(findingId, request);
      return request;
    },
    [client, token, sessionId],
  );
  return { dismiss, failedId };
}

export function FindingsProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const token = useSessionStore((s) => s.token);
  const turns = useSessionStore((s) => s.turns);
  const stepsByTurn = useSessionStore((s) => s.stepsByTurn);
  const findings = useFindings(sessionId, token).data ?? NO_FINDINGS;
  const anchors = useMemo(
    () => anchorFindings(findings, { turns, stepsByTurn }),
    [findings, turns, stepsByTurn],
  );
  const { dismiss, failedId } = useDismissal(sessionId, token);
  const state = useMemo(
    () => ({ findings, anchors, failedId, dismiss }),
    [findings, anchors, failedId, dismiss],
  );
  return <FindingsContext value={state}>{children}</FindingsContext>;
}
