import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// The collapsed rail's tooltips: an icon's name, shown to a
// sighted mouse or keyboard user floating beside the rail.
// The link itself already carries the name for assistive
// technology (the visually hidden .nav-text), so the tooltip
// is a visual copy only — aria-hidden, and never a `title`
// attribute, which would announce the name a second time and
// can be neither styled nor timed.

const HOVER_DELAY_MS = 300;

interface TooltipVisibility {
  open: boolean;
  showAfterDelay: () => void;
  showNow: () => void;
  hide: () => void;
}

/** When the tooltip is open: after a hover's delay, at once
 * on keyboard focus, and closed by Escape, blur, mouse leave
 * or the rail expanding. Escape also cancels a show still in
 * its hover delay, before the tooltip ever opens. */
function useTooltipVisibility(enabled: boolean): TooltipVisibility {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const hide = useCallback(() => {
    clearTimer();
    setPending(false);
    setOpen(false);
  }, [clearTimer]);
  const showAfterDelay = () => {
    clearTimer();
    setPending(true);
    timer.current = setTimeout(() => {
      setPending(false);
      setOpen(true);
    }, HOVER_DELAY_MS);
  };
  const showNow = () => {
    clearTimer();
    setPending(false);
    setOpen(true);
  };
  useEffect(() => clearTimer, [clearTimer]);
  // Expanding the rail takes any open tooltip with it.
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      setPending(false);
      setOpen(false);
    }
  }, [enabled, clearTimer]);
  // Escape closes the tooltip even when the pointer, not the
  // keyboard, opened it and focus sits elsewhere.
  useEffect(() => {
    if (!open && !pending) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, hide]);
  return { open, showAfterDelay, showNow, hide };
}

export function NavTooltip({
  text,
  enabled,
  children,
}: {
  text: string;
  /** Tooltips exist only while the rail is collapsed. */
  enabled: boolean;
  children: ReactNode;
}) {
  const tip = useTooltipVisibility(enabled);
  if (!enabled) {
    return <>{children}</>;
  }
  return (
    <div
      className="nav-tip"
      onMouseEnter={tip.showAfterDelay}
      onMouseLeave={tip.hide}
      onFocus={tip.showNow}
      onBlur={tip.hide}
    >
      {children}
      {tip.open ? (
        <span className="nav-tooltip" aria-hidden="true">
          {text}
        </span>
      ) : null}
    </div>
  );
}
