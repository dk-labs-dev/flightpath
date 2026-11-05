import { useState } from "react";

import { formatSize } from "@flightpath/flightpath/format";
import type { SettingsPayload } from "@flightpath/flightpath/settings/types";

import type { SessionListItem } from "@flightpath/flightpath/api/payloads";

import { useRoute, type Route } from "../route";
import { useSessions } from "../sessions/api";
import { useShellStream } from "../shell-stream";
import { projectName } from "../sessions/model";
import { SessionScreen } from "../session/screen";
import { useSessionStore } from "../session/store";
import { AppBar } from "./AppBar";
import { ConnectionBanner } from "./ConnectionBanner";
import { FirstRunHint } from "./FirstRunHint";
import { HealthBanner } from "./HealthBanner";
import { SettingsScreen } from "./SettingsScreen";
import { SessionsScreen } from "./SessionsScreen";
import { SideNav } from "./SideNav";

const NAV_KEY = "flightpath-nav-collapsed";
const HINT_KEY = "flightpath-hint-dismissed";

// Under 760 px the nav starts collapsed every time, and the
// choice is not written to storage, so a wider window's
// remembered layout is left alone.
function startsCollapsed(): boolean {
  if (window.innerWidth < 760) {
    return true;
  }
  return localStorage.getItem(NAV_KEY) === "1";
}

function footerLine(payload: SettingsPayload | null): string {
  const days = payload?.settings.retentionDays ?? null;
  const bytes = payload?.retention.databaseBytes ?? null;
  if (days === null) {
    return "Stored on this computer only";
  }
  return (
    `Stored on this computer only · Kept ${days} days` +
    (bytes !== null ? ` · ${formatSize(bytes)}` : "")
  );
}

/** The nav's "now" entry: the live session, named by its folder. */
function nowEntry(
  sessions: SessionListItem[] | null,
): { id: string; label: string } | null {
  const liveNow = sessions?.find((session) => session.status === "live");
  if (liveNow === undefined) {
    return null;
  }
  return {
    id: liveNow.id,
    label: projectName(liveNow.project) ?? "Session recording",
  };
}

function ScreenContent({
  current,
  sessions,
  emptyHidden,
  failed,
  payload,
  token,
}: {
  current: Route;
  sessions: SessionListItem[] | null;
  emptyHidden: number;
  failed: boolean;
  payload: SettingsPayload | null;
  token: string;
}) {
  if (current.screen === "settings") {
    return <SettingsScreen token={token} />;
  }
  if (current.screen === "sessions") {
    return (
      <SessionsScreen
        sessions={sessions}
        emptyHidden={emptyHidden}
        failed={failed}
        retentionDays={payload === null ? null : payload.settings.retentionDays}
      />
    );
  }
  return (
    <SessionScreen
      sessionId={current.id}
      token={token}
      lens={current.lens}
      focus={current.focus}
    />
  );
}

// The shell is built once; a route change swaps the screen's
// content and moves aria-current, so focus and the nav's state
// survive navigation. The settings and session screens are
// real; a screen whose own change has not landed yet is a
// plain empty state.
// The crumb names the open session: its title rides in the
// session store's summary, which the shell's stream keeps.
function useSessionTitle(current: Route): string | null {
  return useSessionStore((s) =>
    current.screen === "session" ? (s.sessionSummary?.title ?? "") : null,
  );
}

type ShellProps = { payload: SettingsPayload | null; token: string };

export function Shell({ payload, token }: ShellProps) {
  const { current, screenRef } = useRoute();
  const { sessions, emptyHidden, failed } = useSessions(token);
  useShellStream(token, current.screen === "session" ? current.id : null);
  const sessionTitle = useSessionTitle(current);
  const [collapsed, setCollapsed] = useState<boolean>(() => startsCollapsed());
  const [hintDismissed, setHintDismissed] = useState<boolean>(
    () => localStorage.getItem(HINT_KEY) === "1",
  );

  const toggleNav = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (window.innerWidth >= 760) {
      localStorage.setItem(NAV_KEY, next ? "1" : "0");
    }
  };

  const dismissHint = () => {
    setHintDismissed(true);
    localStorage.setItem(HINT_KEY, "1");
  };

  return (
    <div className="shell">
      <AppBar
        collapsed={collapsed}
        onToggleNav={toggleNav}
        sessionTitle={sessionTitle}
      />
      <FirstRunHint
        visible={current.screen === "session" && !hintDismissed}
        onDismiss={dismissHint}
      />
      <div className="body">
        <SideNav
          screen={current.screen}
          collapsed={collapsed}
          bottomLine={footerLine(payload)}
          now={nowEntry(sessions)}
        />
        <div className="screen-column">
          <HealthBanner />
          <ConnectionBanner />
          <main className="screen" id="screen" tabIndex={-1} ref={screenRef}>
            <ScreenContent
              current={current}
              sessions={sessions}
              emptyHidden={emptyHidden}
              failed={failed}
              payload={payload}
              token={token}
            />
          </main>
        </div>
      </div>
    </div>
  );
}
