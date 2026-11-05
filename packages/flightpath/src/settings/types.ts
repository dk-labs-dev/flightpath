// The settings contract as types alone (ADR-0022): the settings,
// the table describing them, and the settings route's payload.
// This module imports nothing — no Node builtins — so the view
// type-checks against it without Node's types in its program,
// where view code could use `process` or `Buffer` unchecked.

export interface Settings {
  port: number;
  autostart: boolean;
  startupNotice: boolean;
  telemetry: boolean;
  excludedFolders: string[];
  storePromptText: boolean;
  retentionDays: number;
  idleShutdownMinutes: number;
}

type SettingType = "port" | "boolean" | "folders" | "minutes" | "days";

export interface SettingSpec {
  name: keyof Settings;
  type: SettingType;
  default: number | boolean | string[];
  description: string;
  /** The only values a "days" setting accepts. */
  values?: readonly number[];
  /** Shown on the page when a change does not apply at once. */
  note?: string;
  /**
   * Set when the setting exists but nothing applies it yet: the
   * page shows it read-only with this text instead of a control
   * that would do nothing.
   */
  pending?: string;
}

/**
 * The telemetry setup states the settings route reports: on
 * (with the endpoint it sends to), set somewhere the screen
 * cannot change, off, or unreadable.
 */
export type TelemetrySetupState =
  | { state: "on"; endpoint: string }
  | { state: "elsewhere"; where: string; detail: string }
  | { state: "off" }
  | { state: "error"; message: string };

/** The telemetry status payload: the state plus the ports it was read against. */
export type TelemetrySetupStatus = TelemetrySetupState & {
  boundPort: number;
  configuredPort: number;
};

/** The telemetry action's answer: what happened, in words, and the new status. */
export interface TelemetrySetupReply {
  ok: boolean;
  message: string;
  status: TelemetrySetupStatus;
}

export interface SettingsPayload {
  settings: Settings;
  boundPort: number;
  fields: SettingSpec[];
  /** The folder the data lives in, shown on the screen. */
  dataDir: string;
  /** The sessions recording now, oldest first, titled as the picker titles them. */
  liveSessions: { id: string; title: string }[];
  retention: {
    databaseBytes: number;
    sessionCount: number;
    purgeCounts: Record<string, number>;
  };
}
