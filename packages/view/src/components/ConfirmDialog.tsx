import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";

interface ConfirmAction {
  label: string;
  kind: "primary" | "secondary" | "danger";
  onClick: () => void;
}

interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  actions: ConfirmAction[];
  onDismiss: () => void;
  confirmText?: string;
}

function actionClass(kind: ConfirmAction["kind"]): string {
  if (kind === "primary") {
    return "btn btn-primary";
  }
  if (kind === "danger") {
    return "btn btn-danger";
  }
  return "btn";
}

// The one confirmation dialog for the whole view, on the
// native <dialog> element: it gives the dimmed backdrop and
// the inert page behind with no library, and Esc always
// means "stay" — it routes to onDismiss, never to an action.

export function ConfirmDialog({
  title,
  body,
  actions,
  onDismiss,
  confirmText,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const bodyId = useId();

  useDialogOpen(dialogRef, firstActionRef, inputRef, confirmText);

  // Esc fires cancel: keep the dialog from closing itself and
  // let the parent decide, so a dismissal is never mistaken
  // for the primary action.
  const handleCancel = (event: SyntheticEvent): void => {
    event.preventDefault();
    onDismiss();
  };

  // Chromium can close the dialog without a cancelable cancel
  // (a second Esc with nothing in between). If it closes
  // itself, the parent still hears about it here.
  const handleClose = (): void => {
    onDismiss();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || dialogRef.current === null) {
      return;
    }
    const target = wrapTarget(dialogRef.current, event.shiftKey);
    if (target !== null) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={handleCancel}
      onClose={handleClose}
      onKeyDown={handleKeyDown}
    >
      {dialogHead(title, titleId, onDismiss)}
      <div id={bodyId} className="confirm-dialog-body">
        {body}
      </div>
      {confirmText !== undefined &&
        typedField(confirmText, typed, setTyped, inputRef)}
      {dialogActions(actions, firstActionRef, confirmText, typed)}
    </dialog>
  );
}

// The guard on showModal() is the point: it throws on a
// dialog that is already open, so a re-showing skips the
// call and only moves focus.
function useDialogOpen(
  dialogRef: RefObject<HTMLDialogElement | null>,
  firstActionRef: RefObject<HTMLButtonElement | null>,
  inputRef: RefObject<HTMLInputElement | null>,
  confirmText: string | undefined,
): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const restoreTo = document.activeElement;
    if (!dialog.open) {
      dialog.showModal();
    }
    const target =
      confirmText !== undefined ? inputRef.current : firstActionRef.current;
    target?.focus();
    return () => {
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) {
        restoreTo.focus();
      }
    };
  }, [dialogRef, firstActionRef, inputRef, confirmText]);
}

function dialogHead(
  title: string,
  titleId: string,
  onDismiss: () => void,
): ReactNode {
  return (
    <div className="confirm-dialog-head">
      <h2 id={titleId}>{title}</h2>
      <button
        type="button"
        className="confirm-dialog-close"
        aria-label="Close"
        onClick={onDismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// Tab is cycled by hand: on the Chromium the browser tests
// run, sequential navigation leaves a modal dialog for the
// document body at the wrap instead of returning to its first
// control. Returns the control to focus when Tab would leave
// the dialog, or null when the browser's own move stays in.
function wrapTarget(
  dialog: HTMLDialogElement,
  backwards: boolean,
): HTMLElement | null {
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), a[href]",
    ),
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) {
    return dialog;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && focusable.includes(active);
  if (backwards && (active === first || !inside)) {
    return last;
  }
  if (!backwards && (active === last || !inside)) {
    return first;
  }
  return null;
}

function typedField(
  confirmText: string,
  typed: string,
  setTyped: (next: string) => void,
  inputRef: RefObject<HTMLInputElement | null>,
): ReactNode {
  return (
    <label className="confirm-dialog-field">
      {`Type ${confirmText} to confirm`}
      <input
        ref={inputRef}
        type="text"
        value={typed}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
      />
    </label>
  );
}

function dialogActions(
  actions: ConfirmAction[],
  firstActionRef: RefObject<HTMLButtonElement | null>,
  confirmText: string | undefined,
  typed: string,
): ReactNode {
  return (
    <div className="confirm-dialog-actions">
      {actions.map((action, index) => (
        <button
          key={action.label}
          ref={index === 0 ? firstActionRef : undefined}
          type="button"
          className={actionClass(action.kind)}
          disabled={
            action.kind !== "secondary" &&
            confirmText !== undefined &&
            typed !== confirmText
          }
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18"></path>
    </svg>
  );
}
