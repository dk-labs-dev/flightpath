import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Flightpath's own data folder (ADR-0014): the platform's standard
 * per-user data location, never the plugin data directory — that
 * one is deleted on uninstall, and recordings must survive it.
 * Shared by the hook, the daemon and the commands.
 *
 * Windows: %LOCALAPPDATA%\Flightpath
 * macOS:   ~/Library/Application Support/Flightpath
 * Linux:   $XDG_DATA_HOME/flightpath, or ~/.local/share/flightpath
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "Flightpath",
    );
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Flightpath");
  }
  // The XDG spec says a relative XDG_DATA_HOME is invalid and
  // must be ignored, so only an absolute one is used.
  const xdg =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");
  return join(xdg, "flightpath");
}

/** The pause file's name for a session, under pause/: the id made filename-safe. */
export function pauseFileName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Whether this event's session is not recorded: /flightpath:off
 * writes `off`, and /flightpath:stop writes pause/<session_id>.
 */
export function isRecordingOff(
  dataDir: string,
  event: Record<string, unknown>,
): boolean {
  if (existsSync(join(dataDir, "off"))) {
    return true;
  }
  const sessionId = event.session_id;
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    existsSync(join(dataDir, "pause", pauseFileName(sessionId)))
  );
}
