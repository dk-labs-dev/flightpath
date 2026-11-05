import type {
  Settings,
  SettingsPayload,
  TelemetrySetupReply,
  TelemetrySetupStatus,
} from "@flightpath/flightpath/settings/types";

// The settings screen's calls to the daemon, typed by the
// settings contract alone. TanStack Query keys live here so
// the app's startup load and the screen share one cache entry.

export const SETTINGS_QUERY_KEY = ["settings"] as const;
export const TELEMETRY_QUERY_KEY = ["telemetry-setup"] as const;

/** The daemon answered 401: the access key is missing or wrong. */
export class UnauthorizedError extends Error {
  constructor() {
    super("the daemon rejected the access key");
  }
}

function headers(token: string): Record<string, string> {
  return { "x-flightpath-token": token, "content-type": "application/json" };
}

export async function fetchSettings(token: string): Promise<SettingsPayload> {
  const response = await fetch("/api/settings", { headers: headers(token) });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`the daemon answered ${response.status}`);
  }
  return (await response.json()) as SettingsPayload;
}

export async function fetchTelemetry(
  token: string,
): Promise<TelemetrySetupStatus> {
  const response = await fetch("/api/telemetry-setup", {
    headers: headers(token),
  });
  if (!response.ok) {
    throw new Error(`the daemon answered ${response.status}`);
  }
  return (await response.json()) as TelemetrySetupStatus;
}

export type PutSettingsResult =
  | { ok: true; payload: SettingsPayload }
  | { ok: false; errors: Record<string, string> };

/** Save one group's fields; a 400 answers the per-field errors. */
export async function putSettings(
  token: string,
  values: Partial<Settings>,
): Promise<PutSettingsResult> {
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(values),
  });
  const data = (await response.json()) as SettingsPayload & {
    errors?: Record<string, string>;
  };
  if (!response.ok) {
    return { ok: false, errors: data.errors ?? {} };
  }
  return { ok: true, payload: data };
}

/** Delete every stored session; resolves to how many there were. */
export async function deleteAllData(token: string): Promise<number> {
  const response = await fetch("/api/delete-all-data", {
    method: "POST",
    headers: headers(token),
  });
  if (!response.ok) {
    throw new Error(`the daemon answered ${response.status}`);
  }
  return ((await response.json()) as { deletedSessions: number })
    .deletedSessions;
}

export type TelemetryActionResult =
  | { kind: "answered"; reply: TelemetrySetupReply }
  | { kind: "server-error" }
  | { kind: "unreachable" };

/**
 * Run a telemetry action. A 500's body is empty (the router's
 * guard answers it), so it is reported as its own kind instead
 * of being parsed; a network failure is another.
 */
export async function postTelemetryAction(
  token: string,
  action: "on" | "off",
): Promise<TelemetryActionResult> {
  let response: Response;
  try {
    response = await fetch("/api/telemetry-setup", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ action }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 500) {
    return { kind: "server-error" };
  }
  return {
    kind: "answered",
    reply: (await response.json()) as TelemetrySetupReply,
  };
}
