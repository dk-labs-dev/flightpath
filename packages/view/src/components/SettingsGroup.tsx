import { useEffect, useRef, useState, type ReactNode } from "react";

import { formatSize } from "@flightpath/flightpath/format";
import type {
  Settings,
  SettingsPayload,
} from "@flightpath/flightpath/settings/types";

import { portFocusAsked } from "../route";
import {
  ALL_FIELD_DEFS,
  GROUP_DESCRIPTIONS,
  GROUP_FIELDS,
  GROUP_TITLES,
  type SettingsGroupId,
} from "../settings/fields";
import { ChevronIcon } from "./icons";
import { SettingsField } from "./SettingsFields";

// One settings group as a card: a header band with the
// group's name and one line about it, then its fields,
// rendered from the page's one draft. The group holds no
// values and saves nothing — edits report up, and the page's
// save bar saves for all. Advanced differs in shape only:
// its band is the button that opens it, and the line under
// its name is the saved port and idle values.

export interface GroupProps {
  groupId: SettingsGroupId;
  payload: SettingsPayload;
  draft: Settings;
  errors: Record<string, string>;
  onChange: (name: keyof Settings, value: boolean | string[] | number) => void;
}

export function GroupBand(props: {
  headingId: string;
  title: string;
  description: string;
  bandClass?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        props.bandClass === undefined
          ? "group-band"
          : `group-band ${props.bandClass}`
      }
    >
      <div className="group-band-text">
        <h2 id={props.headingId}>{props.title}</h2>
        <p className="group-desc">{props.description}</p>
      </div>
      {props.children}
    </div>
  );
}

export function SettingsGroup(props: GroupProps) {
  if (props.groupId === "advanced") {
    return <AdvancedGroup {...props} />;
  }
  const groupId = props.groupId;
  return (
    <section className="settings-group" aria-labelledby={`group-${groupId}-h`}>
      <GroupBand
        headingId={`group-${groupId}-h`}
        title={GROUP_TITLES[groupId]}
        description={GROUP_DESCRIPTIONS[groupId]}
      />
      <div className={`group-fields group-fields-${groupId}`}>
        {groupFields(props)}
      </div>
    </section>
  );
}

function AdvancedGroup(props: GroupProps) {
  const [open, setOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  usePortFocus(setOpen, setPendingFocus);
  useErrorOpening(props.errors, setOpen, setPendingFocus);
  // A hook that opened the group names the field to focus;
  // the focus lands once the panel is open, since a hidden
  // panel's fields cannot take it.
  useEffect(() => {
    if (pendingFocus === null || !open) {
      return;
    }
    const id = pendingFocus;
    setPendingFocus(null);
    document.getElementById(id)?.focus();
  }, [pendingFocus, open]);
  const saved = props.payload.settings;
  return (
    <section
      className="settings-group settings-advanced"
      aria-labelledby="group-advanced-h"
    >
      <h2 className="advanced-heading">
        <button
          type="button"
          className="group-band advanced-toggle"
          aria-expanded={open}
          aria-controls="advanced-panel"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="group-band-text">
            <span className="group-title" id="group-advanced-h">
              {GROUP_TITLES.advanced}
            </span>
            <span className="group-desc">
              {`Port ${saved.port} · Stops after ${saved.idleShutdownMinutes} min with no activity`}
            </span>
          </span>
          <span className="advanced-toggle-word">{open ? "Hide" : "Show"}</span>
          <span className="advanced-chevron">
            <ChevronIcon open={open} size={22} />
          </span>
        </button>
      </h2>
      <div
        className="group-fields advanced-panel"
        id="advanced-panel"
        hidden={!open}
      >
        {groupFields(props)}
      </div>
    </section>
  );
}

function groupFields(props: GroupProps): ReactNode {
  const { payload, groupId, draft } = props;
  return GROUP_FIELDS[groupId].map((def) => (
    <SettingsField
      key={def.name}
      def={def}
      value={draft[def.name]}
      savedValue={payload.settings[def.name]}
      error={props.errors[def.name] ?? ""}
      onChange={(value) => props.onChange(def.name, value)}
      help={def.name === "port" ? portHelp(payload) : undefined}
      dayOptions={
        payload.fields.find((field) => field.name === "retentionDays")?.values
      }
      stakes={
        def.name === "retentionDays" ? retentionStakes(payload) : undefined
      }
    />
  ));
}

function portHelp(payload: SettingsPayload): string {
  return (
    `Where this page and the recorder live on this machine (now ` +
    `${payload.boundPort}). If the port is taken, Flightpath picks the ` +
    `next free one on its own, so most people never change this.`
  );
}

function retentionStakes(payload: SettingsPayload): string {
  const count = payload.retention.sessionCount;
  return (
    `Keeping ${count} session${count === 1 ? "" : "s"} · ` +
    `${formatSize(payload.retention.databaseBytes)}, in ${payload.dataDir}. ` +
    `Older recordings are deleted and the space given back.`
  );
}

// Opening settings from the health banner's "Change the port"
// lands here with the hash asking for the port field: open
// the group and name that field for the group's focus effect.
function usePortFocus(
  setOpen: (open: boolean) => void,
  focusField: (id: string) => void,
): void {
  useEffect(() => {
    const check = () => {
      if (portFocusAsked()) {
        setOpen(true);
        focusField("f-port");
      }
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [setOpen, focusField]);
}

// A save that answers a fresh error on an Advanced field
// opens the group and names the first errored field: the
// page's own focus move runs before the panel exists, so
// the group repeats it for its fields.
function useErrorOpening(
  errors: Record<string, string>,
  setOpen: (open: boolean) => void,
  focusField: (id: string) => void,
): void {
  const before = useRef(errors);
  useEffect(() => {
    const previous = before.current;
    before.current = errors;
    const fresh = GROUP_FIELDS.advanced.some(
      (def) =>
        errors[def.name] !== undefined && previous[def.name] === undefined,
    );
    if (!fresh) {
      return;
    }
    setOpen(true);
    const first = ALL_FIELD_DEFS.find((def) => errors[def.name] !== undefined);
    if (
      first !== undefined &&
      GROUP_FIELDS.advanced.some((def) => def.name === first.name)
    ) {
      focusField(`f-${first.name}`);
    }
  }, [errors, setOpen, focusField]);
}
