// The share preview: the card for the open session, drawn
// on a canvas in the one dialog the view already has, with
// Save image and Copy. Nothing is uploaded, posted or sent
// anywhere — the image leaves the machine only if the
// person posts the file or the clipboard copy themselves.

import { useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { useContextAt, useTokenHistory } from "./api.js";
import { useClockStore } from "./clock.js";
import { CARD_HEIGHT, CARD_WIDTH, drawShareCard } from "./share-card-render.js";
import { shareCardNumbers, type CardNumbers } from "./share-card-numbers.js";
import { useSessionStore } from "./store.js";

const COPY_UNAVAILABLE =
  "Copy isn't available in this browser. Use Save image.";

/** The open session's card numbers, from the store and the
 * session's own queries: the context at the latest step —
 * the snapshot lens's read, under the same query key — and
 * the token history. While a read is still arriving the
 * card shows what it has; the stream keeps the store's
 * summary current, so a step that lands while the preview
 * is open rebuilds the card with the new context number. */
export function useShareCardNumbers(): CardNumbers {
  const sessionId = useSessionStore((s) => s.sessionId);
  const token = useSessionStore((s) => s.token);
  const summary = useSessionStore((s) => s.sessionSummary);
  const latestStepId = useSessionStore((s) => s.latestStepId);
  const steps = useSessionStore((s) => s.steps);
  const nowMs = useClockStore((s) => s.nowMs);
  const history = useTokenHistory(sessionId, token).data ?? null;
  const context =
    useContextAt(
      sessionId,
      token,
      latestStepId === null ? null : { step: latestStepId },
    ).data ?? null;
  return useMemo(
    () => shareCardNumbers({ summary, context, history, steps, nowMs }),
    [summary, context, history, steps, nowMs],
  );
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const numbers = useShareCardNumbers();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas !== null) {
      drawShareCard(canvas, numbers);
    }
  }, [numbers]);

  const saveImage = (): void => {
    canvasRef.current?.toBlob((blob) => {
      if (blob === null) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "flightpath-session.png";
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  const copyImage = (): void => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ClipboardItem === "undefined") {
      setCopyNote(COPY_UNAVAILABLE);
      return;
    }
    canvas.toBlob((blob) => {
      if (blob === null) {
        setCopyNote(COPY_UNAVAILABLE);
        return;
      }
      void navigator.clipboard
        .write([new ClipboardItem({ "image/png": blob })])
        .then(
          () => setCopyNote(null),
          () => setCopyNote(COPY_UNAVAILABLE),
        );
    });
  };

  return (
    <ConfirmDialog
      title="Share this session's numbers"
      body={
        <div className="share-preview">
          <canvas ref={canvasRef} width={CARD_WIDTH} height={CARD_HEIGHT} />
          {copyNote !== null && <p role="status">{copyNote}</p>}
        </div>
      }
      actions={[
        { label: "Save image", kind: "primary", onClick: saveImage },
        { label: "Copy", kind: "secondary", onClick: copyImage },
        { label: "Close", kind: "secondary", onClick: onClose },
      ]}
      onDismiss={onClose}
    />
  );
}
