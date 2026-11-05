export function FirstRunHint({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  return (
    <div className="hint" id="hint" hidden={!visible}>
      <p>Each row is one thing Claude did. Click a row for its details.</p>
      <button type="button" id="hint-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
