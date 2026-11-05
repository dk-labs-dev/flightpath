import { useEffect, useRef, useState, type ReactNode } from "react";

import { parseFolderLines, type FieldDef } from "../settings/fields";
import { Switch } from "./Switch";

// One field's markup, rendered from the screen's field table.
// The ids and classes are the screen's contract: tests select
// them, and every control carries a label or an aria label.

export interface FieldProps {
  def: FieldDef;
  value: boolean | string[] | number;
  /** The saved value, for a field that shows where it started (the idle choice). */
  savedValue?: boolean | string[] | number;
  error: string;
  onChange: (value: boolean | string[] | number) => void;
  /** The retention row's stakes line, for the days field. */
  stakes?: ReactNode | undefined;
  /** The days field's offered values, from the payload's spec. */
  dayOptions?: readonly number[] | undefined;
  /** Help text computed by the group (the port's names the bound port). */
  help?: string | undefined;
}

function errorLine(def: FieldDef, error: string): ReactNode {
  return (
    <p className="field-error" id={`e-${def.name}`}>
      {error}
    </p>
  );
}

// A text control's local copy of a value held above it: text
// the control just sent up does not rewrite it; a value that
// arrives from elsewhere (a reset, a save) does.
function useSentText(
  valueKey: string,
): [string, (text: string, sentKey: string) => void] {
  const [text, setText] = useState(valueKey);
  const lastSent = useRef(valueKey);
  useEffect(() => {
    if (valueKey !== lastSent.current) {
      lastSent.current = valueKey;
      setText(valueKey);
    }
  }, [valueKey]);
  const send = (nextText: string, sentKey: string): void => {
    setText(nextText);
    lastSent.current = sentKey;
  };
  return [text, send];
}

function SwitchField({ def, value, error, onChange }: FieldProps) {
  const labelId = `l-${def.name}`;
  return (
    <div className="field">
      <div className="switch-row">
        <span className="switch-text">
          <span className="field-label" id={labelId}>
            {def.label}
          </span>
          <span className="field-help">{def.help ?? ""}</span>
        </span>
        <Switch
          id={`f-${def.name}`}
          labelId={labelId}
          checked={value === true}
          onToggle={(next) => onChange(next)}
        />
      </div>
      {errorLine(def, error)}
    </div>
  );
}

// The example folder is written the way the machine's own
// paths are written.
function foldersPlaceholder(): string {
  return navigator.userAgent.includes("Windows")
    ? "C:\\work\\client-project"
    : "~/work/client-project";
}

function FoldersField({ def, value, error, onChange }: FieldProps) {
  const lines = Array.isArray(value) ? value : [];
  const [text, sendText] = useSentText(lines.join("\n"));
  return (
    <div className="field">
      <label className="field-label" htmlFor={`f-${def.name}`}>
        {def.label}
      </label>
      <textarea
        id={`f-${def.name}`}
        rows={3}
        placeholder={foldersPlaceholder()}
        value={text}
        onChange={(event) => {
          const parsed = parseFolderLines(event.target.value);
          sendText(event.target.value, parsed.join("\n"));
          onChange(parsed);
        }}
      />
      <p className="field-help">{def.help ?? ""}</p>
      {errorLine(def, error)}
    </div>
  );
}

interface SelectOption {
  value: number;
  label: string;
}

// A labelled select in a row, with what follows it on the
// line (the idle choice's sentence) or under it (the days
// field's stakes line).
function SelectRow({
  def,
  value,
  error,
  onChange,
  options,
  trailing,
  below,
}: FieldProps & {
  options: SelectOption[];
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="field">
      <div className="retention-row">
        <label className="field-label" htmlFor={`f-${def.name}`}>
          {def.label}
        </label>
        <select
          id={`f-${def.name}`}
          value={String(value)}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {trailing}
      </div>
      {below}
      {errorLine(def, error)}
    </div>
  );
}

function DaysField(props: FieldProps) {
  return (
    <SelectRow
      {...props}
      options={(props.dayOptions ?? []).map((days) => ({
        value: days,
        label: `${days} days`,
      }))}
      below={
        <span className="field-help retention-stakes">{props.stakes}</span>
      }
    />
  );
}

const IDLE_MINUTES = [5, 15, 30, 60];

function IdleField(props: FieldProps) {
  const saved =
    typeof props.savedValue === "number"
      ? props.savedValue
      : Number(props.value);
  // A saved value outside the four stays offered, marked as
  // the current one, so opening the page never changes it.
  const options = [...IDLE_MINUTES, saved]
    .filter((minutes, index, all) => all.indexOf(minutes) === index)
    .sort((a, b) => a - b)
    .map((minutes) => ({
      value: minutes,
      label: IDLE_MINUTES.includes(minutes)
        ? `${minutes} minutes`
        : `${minutes} minutes (current)`,
    }));
  return (
    <SelectRow
      {...props}
      options={options}
      trailing={
        <span className="field-help">
          with no activity. The next session starts it again.
        </span>
      }
    />
  );
}

function NumberField({ def, value, error, onChange, help }: FieldProps) {
  const [text, sendText] = useSentText(String(value));
  return (
    <div className="field">
      <label className="field-label" htmlFor={`f-${def.name}`}>
        {def.label}
      </label>
      <input
        id={`f-${def.name}`}
        className={`mono ${def.inputClass ?? ""}`}
        inputMode="numeric"
        value={text}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          sendText(event.target.value, String(parsed));
          onChange(parsed);
        }}
      />
      <p className="field-help">{help ?? def.help ?? ""}</p>
      {errorLine(def, error)}
    </div>
  );
}

export function SettingsField(props: FieldProps) {
  switch (props.def.kind) {
    case "switch":
      return <SwitchField {...props} />;
    case "folders":
      return <FoldersField {...props} />;
    case "days":
      return <DaysField {...props} />;
    case "number":
      return <NumberField {...props} />;
    case "idle":
      return <IdleField {...props} />;
  }
}
