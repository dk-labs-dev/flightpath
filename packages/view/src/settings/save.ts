import type { QueryClient } from "@tanstack/react-query";

import type {
  Settings,
  SettingsPayload,
  TelemetrySetupStatus,
} from "@flightpath/flightpath/settings/types";

import {
  fetchSettings,
  fetchTelemetry,
  SETTINGS_QUERY_KEY,
  TELEMETRY_QUERY_KEY,
  type PutSettingsResult,
} from "./api";
import {
  assignSetting,
  changedSettingNames,
  isRetentionLowered,
} from "./fields";
import type { PortWarningInfo } from "../components/PortWarning";

// The page's one save path: the confirmations run first, in
// order, and only then does one PUT carry every changed
// field. The screen answers the confirmations through the
// shared dialog; this module asks and never renders.

/** What the retention confirmation states before it is agreed to. */
export interface RetentionConfirmInfo {
  days: number;
  sessions: number;
}

/** The screen's side of the two confirmations: true means go ahead. */
interface SaveAnswers {
  confirmRetention: (info: RetentionConfirmInfo) => Promise<boolean>;
  confirmPort: (info: PortWarningInfo) => Promise<boolean>;
}

export interface SaveDeps {
  token: string;
  draft: Settings;
  saved: Settings;
  payload: SettingsPayload;
  queryClient: QueryClient;
  answers: SaveAnswers;
  put: (next: Partial<Settings>) => Promise<PutSettingsResult>;
}

export type SaveOutcome =
  | { kind: "saved"; payload: SettingsPayload; movedTo: number | null }
  | { kind: "declined" }
  | { kind: "errors"; errors: Record<string, string> }
  | { kind: "unreachable" };

export async function saveAllSettings(deps: SaveDeps): Promise<SaveOutcome> {
  const changed = changedSettingNames(deps.draft, deps.saved);
  if (changed.length === 0) {
    return { kind: "saved", payload: deps.payload, movedTo: null };
  }
  if (isRetentionLowered(deps.draft, deps.saved)) {
    const info = retentionConfirmInfo(deps);
    if (info.sessions > 0) {
      const agreed = await deps.answers.confirmRetention(info);
      if (!agreed) {
        return { kind: "declined" };
      }
    }
  }
  if (changed.includes("port")) {
    const agreed = await deps.answers.confirmPort(
      await fetchPortWarningInfo(deps),
    );
    if (!agreed) {
      return { kind: "declined" };
    }
  }
  const next: Partial<Settings> = {};
  for (const name of changed) {
    assignSetting(next, name, deps.draft[name]);
  }
  let result: PutSettingsResult;
  try {
    result = await deps.put(next);
  } catch {
    return { kind: "unreachable" };
  }
  if (!result.ok) {
    return { kind: "errors", errors: result.errors };
  }
  const movedTo =
    result.payload.settings.port !== deps.saved.port
      ? result.payload.settings.port
      : null;
  return { kind: "saved", payload: result.payload, movedTo };
}

function retentionConfirmInfo(deps: SaveDeps): RetentionConfirmInfo {
  const days = deps.draft.retentionDays;
  return {
    days,
    sessions: deps.payload.retention.purgeCounts[String(days)] ?? 0,
  };
}

// The warning's facts are read fresh: who is recording now,
// and whether their telemetry is on — the last known answers
// stand when the daemon cannot be reached for fresher ones.
async function fetchPortWarningInfo(deps: SaveDeps): Promise<PortWarningInfo> {
  let sessions = deps.payload.liveSessions;
  try {
    const fresh = await deps.queryClient.fetchQuery({
      queryKey: SETTINGS_QUERY_KEY,
      queryFn: () => fetchSettings(deps.token),
    });
    sessions = fresh.liveSessions;
  } catch {
    // The last known list stands.
  }
  let telemetryOn =
    deps.queryClient.getQueryData<TelemetrySetupStatus>(TELEMETRY_QUERY_KEY)
      ?.state === "on";
  try {
    const status = await deps.queryClient.fetchQuery({
      queryKey: TELEMETRY_QUERY_KEY,
      queryFn: () => fetchTelemetry(deps.token),
    });
    telemetryOn = status.state === "on";
  } catch {
    // The last read state stands.
  }
  return {
    sessions,
    telemetryOn,
    newPort: deps.draft.port,
    currentPort: deps.saved.port,
  };
}
