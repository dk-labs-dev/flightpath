import type { Settings } from "@flightpath/flightpath/settings/types";

// The screen's one field table: which fields each group holds,
// in order, with the label and help the screen shows for each.
// Groups, fields, rendering and the changed-field comparison
// all read this table alone.

export type SettingsGroupId = "recording" | "data" | "advanced";

type FieldKind = "switch" | "folders" | "days" | "number" | "idle";

export interface FieldDef {
  name: keyof Settings;
  kind: FieldKind;
  label: string;
  help?: string;
  /** A numeric field's width class. */
  inputClass?: string;
}

export const GROUP_TITLES: Record<SettingsGroupId, string> = {
  recording: "Recording",
  data: "Your data",
  advanced: "Advanced settings",
};

export const GROUP_DESCRIPTIONS: Record<
  Exclude<SettingsGroupId, "advanced">,
  string
> = {
  recording: "What Flightpath records, and when.",
  data: "Where recordings live, and how long they're kept.",
};

export const GROUP_FIELDS: Record<SettingsGroupId, FieldDef[]> = {
  recording: [
    {
      name: "autostart",
      kind: "switch",
      label: "Record new sessions automatically",
      help: "When off, a session records only after you run /flightpath:start in it.",
    },
    {
      name: "startupNotice",
      kind: "switch",
      label: "Show the startup notice",
      help: "One line at session start that says whether Flightpath is recording. Problems are always shown.",
    },
    {
      name: "storePromptText",
      kind: "switch",
      label: "Keep the text of my prompts",
      help: "The first 2,000 characters of each prompt. When off, only its length is kept.",
    },
    {
      name: "excludedFolders",
      kind: "folders",
      label: "Folders never recorded",
      help: "One full folder path per line. Sessions working in these folders are skipped, as if paused.",
    },
  ],
  data: [{ name: "retentionDays", kind: "days", label: "Keep recordings for" }],
  advanced: [
    { name: "port", kind: "number", label: "Port", inputClass: "port-input" },
    {
      name: "idleShutdownMinutes",
      kind: "idle",
      label: "Stop the recorder after",
    },
  ],
};

/** Every editable field on the page, in the order groups show them. */
export const ALL_FIELD_DEFS: FieldDef[] = [
  ...GROUP_FIELDS.recording,
  ...GROUP_FIELDS.data,
  ...GROUP_FIELDS.advanced,
];

/** Write one setting on a partial by name, keeping its value's type. */
export function assignSetting<K extends keyof Settings>(
  target: Partial<Settings>,
  name: K,
  value: Settings[K],
): void {
  target[name] = value;
}

/** The one comparison behind "changed": a draft value against its saved one. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields whose draft differs from the saved value, in page order. */
export function changedSettingNames(
  draft: Settings,
  saved: Settings,
): (keyof Settings)[] {
  return ALL_FIELD_DEFS.filter(
    (def) => !sameValue(draft[def.name], saved[def.name]),
  ).map((def) => def.name);
}

/** True when the draft keeps recordings for fewer days than saved. */
export function isRetentionLowered(draft: Settings, saved: Settings): boolean {
  return draft.retentionDays < saved.retentionDays;
}

/** The folders field's value: one trimmed, non-empty path per line. */
export function parseFolderLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
