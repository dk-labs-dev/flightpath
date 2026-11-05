// After a port move the daemon restarts on the new port; the
// screen polls it — no fixed pause — before navigating, so a
// slow restart is not mistaken for a dead one.

const POLL_INTERVAL_MS = 100;
const POLL_DEADLINE_MS = 15_000;

export async function waitForDaemonOnPort(port: number): Promise<boolean> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  for (;;) {
    try {
      // No CORS: only that something serves on the new port matters.
      await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors" });
      return true;
    } catch {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
