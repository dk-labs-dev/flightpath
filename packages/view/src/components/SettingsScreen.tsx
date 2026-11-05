import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import type {
  Settings,
  SettingsPayload,
} from "@flightpath/flightpath/settings/types";

import { registerLeaveGuard } from "../leave-guard";
import {
  fetchSettings,
  putSettings,
  SETTINGS_QUERY_KEY,
} from "../settings/api";
import {
  ALL_FIELD_DEFS,
  assignSetting,
  changedSettingNames,
  sameValue,
  type SettingsGroupId,
} from "../settings/fields";
import { waitForDaemonOnPort } from "../settings/port-move";
import { saveAllSettings, type RetentionConfirmInfo } from "../settings/save";
import { AppearanceGroup } from "./AppearanceGroup";
import { ConfirmDialog } from "./ConfirmDialog";
import { DangerZone } from "./DeleteZone";
import { PortWarningBody, type PortWarningInfo } from "./PortWarning";
import { SaveBar } from "./SaveBar";
import { SettingsGroup } from "./SettingsGroup";
import { TelemetryGroup } from "./TelemetryGroup";

// The settings screen: one draft of every editable setting,
// one save bar for the whole page, the confirmations a save
// can owe on the shared dialog, the unsaved-changes guard,
// and the move to a new port once the daemon answers there.

export function SettingsScreen({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => fetchSettings(token),
  });
  const [notice, setNotice] = useState("");
  const onSaved = useCallback(
    (payload: SettingsPayload) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, payload);
    },
    [queryClient],
  );
  const onPortMoved = useCallback(
    (newPort: number) => {
      setNotice("Saved. The daemon is restarting on the new port…");
      void moveToNewPort(newPort, token, setNotice);
    },
    [token],
  );
  if (query.isPending) {
    return <ScreenMessage text="Loading settings…" />;
  }
  const payload = query.data;
  if (payload === undefined) {
    return (
      <ScreenMessage text="Settings could not be loaded from the daemon." />
    );
  }
  return (
    <div className="settings-screen">
      <h1>Settings</h1>
      <p className="screen-sub">
        Changes take effect when you save them. Everything here stays on this
        computer.
      </p>
      {notice !== "" && (
        <p className="screen-notice" role="status">
          {notice}
        </p>
      )}
      {payload.boundPort !== payload.settings.port && (
        <p className="bound-note">
          {`The configured port ${payload.settings.port} was taken, so the daemon is on ${payload.boundPort} instead.`}
        </p>
      )}
      <SettingsForm
        payload={payload}
        token={token}
        queryClient={queryClient}
        onSaved={onSaved}
        onPortMoved={onPortMoved}
        onNotice={setNotice}
      />
    </div>
  );
}

function ScreenMessage({ text }: { text: string }) {
  return (
    <div className="settings-screen">
      <h1>Settings</h1>
      <p className="empty">{text}</p>
    </div>
  );
}

async function moveToNewPort(
  newPort: number,
  token: string,
  setNotice: (text: string) => void,
): Promise<void> {
  if (await waitForDaemonOnPort(newPort)) {
    window.location.assign(
      `http://127.0.0.1:${newPort}/#settings&token=${encodeURIComponent(token)}`,
    );
    return;
  }
  setNotice(
    "Saved — but the daemon did not answer on the new port. It may still be starting; reopen Settings from /flightpath:status.",
  );
}

type OpenDialog =
  | { kind: "retention"; info: RetentionConfirmInfo }
  | { kind: "port"; info: PortWarningInfo }
  | { kind: "leave" };

type SetErrors = Dispatch<SetStateAction<Record<string, string>>>;

interface FormProps {
  payload: SettingsPayload;
  token: string;
  queryClient: QueryClient;
  onSaved: (payload: SettingsPayload) => void;
  onPortMoved: (newPort: number) => void;
  onNotice: (text: string) => void;
}

function SettingsForm(props: FormProps): ReactNode {
  const { payload, token } = props;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const { draft, changeDraft, resetDraft } = useDraft(payload);
  const flow = useSaveFlow(props, draft, setErrors, setDialog);
  const changed = changedSettingNames(draft, payload.settings);
  const leave = useLeaveGuard(
    changed.length > 0,
    flow.runSave,
    () => {
      resetDraft();
      setErrors({});
    },
    setDialog,
  );
  const change = (
    name: keyof Settings,
    value: boolean | string[] | number,
  ): void => {
    flow.clearFlash();
    changeDraft(name, value);
    setErrors((current) => withoutError(current, name));
  };
  const group = (groupId: SettingsGroupId) => (
    <SettingsGroup
      key={groupId}
      groupId={groupId}
      payload={payload}
      draft={draft}
      errors={errors}
      onChange={change}
    />
  );
  return (
    <>
      {group("recording")}
      <AppearanceGroup />
      {group("data")}
      <TelemetryGroup token={token} />
      {group("advanced")}
      <DangerZone token={token} onNotice={props.onNotice} />
      <SaveBar
        changedCount={changed.length}
        fixCount={Object.keys(errors).length}
        savedFlash={flow.savedFlash}
        onCancel={() => {
          resetDraft();
          setErrors({});
        }}
        onSave={() => void flow.runSave()}
      />
      {openDialog(dialog, flow, leave)}
    </>
  );
}

function withoutError(
  errors: Record<string, string>,
  name: keyof Settings,
): Record<string, string> {
  if (errors[name] === undefined) {
    return errors;
  }
  const next = { ...errors };
  delete next[name];
  return next;
}

// The page's one draft: it starts from the saved payload, a
// payload arriving while the draft matches the old saved
// values is adopted wholesale, and while the draft differs it
// stands — only the saved baseline moves under it.
function useDraft(payload: SettingsPayload): {
  draft: Settings;
  changeDraft: (
    name: keyof Settings,
    value: boolean | string[] | number,
  ) => void;
  resetDraft: () => void;
} {
  const [draft, setDraft] = useState<Settings>(payload.settings);
  const prevSaved = useRef(payload.settings);
  useEffect(() => {
    const before = prevSaved.current;
    prevSaved.current = payload.settings;
    setDraft((current) =>
      ALL_FIELD_DEFS.every((def) =>
        sameValue(current[def.name], before[def.name]),
      )
        ? payload.settings
        : current,
    );
  }, [payload]);
  const changeDraft = useCallback(
    (name: keyof Settings, value: boolean | string[] | number): void => {
      setDraft((current) => {
        const next = { ...current };
        assignSetting(next, name, value);
        return next;
      });
    },
    [],
  );
  const resetDraft = useCallback((): void => {
    setDraft(payload.settings);
  }, [payload.settings]);
  return { draft, changeDraft, resetDraft };
}

interface SaveFlow {
  runSave: () => Promise<boolean>;
  savedFlash: boolean;
  clearFlash: () => void;
  answerConfirm: (agreed: boolean) => void;
}

// The save's moving parts: the confirmations are answered
// through the one open dialog, a second save asked for while
// one runs reuses it, and a success flashes the saved line
// unless the port move's own notice takes over.
function useSaveFlow(
  props: FormProps,
  draft: Settings,
  setErrors: SetErrors,
  setDialog: Dispatch<SetStateAction<OpenDialog | null>>,
): SaveFlow {
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const { ask, answerConfirm } = useConfirmAsk(setDialog);
  const clearFlash = useCallback((): void => {
    setSavedFlash(false);
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
    },
    [],
  );
  // No memo here: props is a new object on every render, so
  // a useCallback would be rebuilt every time anyway — the
  // in-flight reuse is the running ref's work, not the memo's.
  const runSave = (): Promise<boolean> => {
    if (running.current !== null) {
      return running.current;
    }
    const promise = executeSave(props, draft, ask, setErrors, () => {
      setSavedFlash(true);
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 4_000);
    });
    running.current = promise;
    const clear = (): void => {
      if (running.current === promise) {
        running.current = null;
      }
    };
    void promise.then(clear, clear);
    return promise;
  };
  return { runSave, savedFlash, clearFlash, answerConfirm };
}

// One run of the save path: ask what needs asking, PUT what
// changed, and apply the outcome — the payload, the port
// move, the field errors under their fields, or the notice.
async function executeSave(
  props: FormProps,
  draft: Settings,
  ask: (open: OpenDialog) => Promise<boolean>,
  setErrors: SetErrors,
  flashSaved: () => void,
): Promise<boolean> {
  setErrors({});
  const outcome = await saveAllSettings({
    token: props.token,
    draft,
    saved: props.payload.settings,
    payload: props.payload,
    queryClient: props.queryClient,
    answers: {
      confirmRetention: (info) => ask({ kind: "retention", info }),
      confirmPort: (info) => ask({ kind: "port", info }),
    },
    put: (next) => putSettings(props.token, next),
  });
  if (outcome.kind === "saved") {
    props.onSaved(outcome.payload);
    if (outcome.movedTo !== null) {
      props.onPortMoved(outcome.movedTo);
    } else {
      flashSaved();
    }
    return true;
  }
  if (outcome.kind === "errors") {
    setErrors(outcome.errors);
    focusFirstError(outcome.errors);
  }
  if (outcome.kind === "unreachable") {
    props.onNotice("Could not reach the daemon; nothing was saved.");
  }
  return false;
}

function focusFirstError(errors: Record<string, string>): void {
  const first = ALL_FIELD_DEFS.find((def) => errors[def.name] !== undefined);
  if (first !== undefined) {
    document.getElementById(`f-${first.name}`)?.focus();
  }
}

// The confirmations' plumbing: opening one stores who is
// waiting; answering settles them and closes the dialog. A
// dismissal answers no, so Esc never confirms.
function useConfirmAsk(
  setDialog: Dispatch<SetStateAction<OpenDialog | null>>,
): {
  ask: (open: OpenDialog) => Promise<boolean>;
  answerConfirm: (agreed: boolean) => void;
} {
  const answerRef = useRef<((agreed: boolean) => void) | null>(null);
  const ask = useCallback(
    (open: OpenDialog): Promise<boolean> =>
      new Promise((resolve) => {
        answerRef.current = resolve;
        setDialog(open);
      }),
    [setDialog],
  );
  const answerConfirm = useCallback(
    (agreed: boolean): void => {
      const resolve = answerRef.current;
      answerRef.current = null;
      setDialog(null);
      resolve?.(agreed);
    },
    [setDialog],
  );
  return { ask, answerConfirm };
}

interface LeaveGuard {
  keepEditing: () => void;
  discardAndContinue: () => void;
  saveAndContinue: () => void;
}

// The leave guard's screen half: the route hook asks while
// anything is changed, the browser's own unload prompt is
// armed, and the ask opens the leave dialog — one ask, its
// pending promise reused while it waits for an answer.
function useLeaveGuard(
  anyChanged: boolean,
  runSave: () => Promise<boolean>,
  resetDraft: () => void,
  setDialog: Dispatch<SetStateAction<OpenDialog | null>>,
): LeaveGuard {
  const pending = useRef<{
    promise: Promise<boolean>;
    resolve: (leave: boolean) => void;
  } | null>(null);
  const changedRef = useRef(anyChanged);
  useEffect(() => {
    changedRef.current = anyChanged;
  }, [anyChanged]);
  const ask = useCallback((): Promise<boolean> => {
    if (!changedRef.current) {
      return Promise.resolve(true);
    }
    if (pending.current !== null) {
      return pending.current.promise;
    }
    let resolveFn: (leave: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });
    pending.current = { promise, resolve: resolveFn };
    setDialog({ kind: "leave" });
    return promise;
  }, [setDialog]);
  useEffect(() => {
    registerLeaveGuard(ask);
    return () => {
      registerLeaveGuard(null);
      pending.current?.resolve(true);
      pending.current = null;
    };
  }, [ask]);
  useUnloadGuard(anyChanged);
  const settle = (leave: boolean): void => {
    pending.current?.resolve(leave);
    pending.current = null;
  };
  return {
    keepEditing: () => {
      setDialog(null);
      settle(false);
    },
    discardAndContinue: () => {
      resetDraft();
      setDialog(null);
      settle(true);
    },
    saveAndContinue: () => {
      setDialog(null);
      void runSave().then((savedOk) => settle(savedOk));
    },
  };
}

// The browser's own unload prompt, armed only while changed.
function useUnloadGuard(anyChanged: boolean): void {
  useEffect(() => {
    if (!anyChanged) {
      return;
    }
    const onBeforeUnload = (event: Event): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyChanged]);
}

function openDialog(
  dialog: OpenDialog | null,
  flow: SaveFlow,
  leave: LeaveGuard,
): ReactNode {
  if (dialog === null) {
    return null;
  }
  if (dialog.kind === "retention") {
    return retentionDialog(dialog.info, flow);
  }
  if (dialog.kind === "port") {
    return portDialog(dialog.info, flow);
  }
  return leaveDialog(leave);
}

function retentionDialog(
  info: RetentionConfirmInfo,
  flow: SaveFlow,
): ReactNode {
  return (
    <ConfirmDialog
      title={`Keep recordings for ${info.days} days?`}
      body={
        <p>
          {`Sessions older than ${info.days} days are deleted now: about ${info.sessions} session${info.sessions === 1 ? "" : "s"}. This can't be undone.`}
        </p>
      }
      actions={[
        {
          label: "Delete older and save",
          kind: "danger",
          onClick: () => flow.answerConfirm(true),
        },
        {
          label: "Cancel",
          kind: "secondary",
          onClick: () => flow.answerConfirm(false),
        },
      ]}
      onDismiss={() => flow.answerConfirm(false)}
    />
  );
}

function portDialog(info: PortWarningInfo, flow: SaveFlow): ReactNode {
  return (
    <ConfirmDialog
      title={`Move Flightpath to port ${info.newPort}?`}
      body={<PortWarningBody info={info} />}
      actions={[
        {
          label: `Move to ${info.newPort}`,
          kind: "primary",
          onClick: () => flow.answerConfirm(true),
        },
        {
          label: `Keep ${info.currentPort}`,
          kind: "secondary",
          onClick: () => flow.answerConfirm(false),
        },
      ]}
      onDismiss={() => flow.answerConfirm(false)}
    />
  );
}

function leaveDialog(leave: LeaveGuard): ReactNode {
  return (
    <ConfirmDialog
      title="You have unsaved changes"
      body={<p>Save them before you go, or leave them behind.</p>}
      actions={[
        {
          label: "Save and continue",
          kind: "primary",
          onClick: leave.saveAndContinue,
        },
        {
          label: "Discard and continue",
          kind: "secondary",
          onClick: leave.discardAndContinue,
        },
        {
          label: "Keep editing",
          kind: "secondary",
          onClick: leave.keepEditing,
        },
      ]}
      onDismiss={leave.keepEditing}
    />
  );
}
