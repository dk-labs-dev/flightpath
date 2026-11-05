// An on/off setting as a switch: a native button, so Space
// and Enter toggle it, labelled by the setting's name. It
// changes the draft only; nothing takes effect until Save.

export function Switch({
  id,
  labelId,
  checked,
  onToggle,
}: {
  id: string;
  labelId: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      onClick={() => onToggle(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}
