import { navStatus } from "../health-state";
import { useLiveStore } from "../live-store";
import { sessionHref, type Route } from "../route";
import { SessionsIcon, SettingsIcon } from "./icons";
import { NavTooltip } from "./NavTooltip";

function NowEntry({
  now,
  collapsed,
}: {
  now: { id: string; label: string } | null;
  collapsed: boolean;
}) {
  if (now === null) {
    return (
      <NavTooltip text="Nothing recording" enabled={collapsed}>
        <span className="nav-now">
          <span className="nav-icon"></span>
          <span className="nav-text">Nothing recording</span>
        </span>
      </NavTooltip>
    );
  }
  return (
    <NavTooltip text={`${now.label} · recording`} enabled={collapsed}>
      <a className="nav-now" href={sessionHref(now.id)}>
        <span className="nav-icon">
          <span className="nav-live-dot" aria-hidden="true"></span>
        </span>
        <span className="nav-text">{now.label} · recording</span>
      </a>
    </NavTooltip>
  );
}

function RecorderStatus({ collapsed }: { collapsed: boolean }) {
  const health = useLiveStore((state) => state.health);
  const status = useLiveStore((state) => state.status);
  const recorder = navStatus(health, status, window.location.port);
  return (
    <NavTooltip text={recorder.text} enabled={collapsed}>
      <p
        className={`nav-status nav-status-${recorder.tone}`}
        role="img"
        aria-label={recorder.text}
      >
        <span className="status-dot" aria-hidden="true"></span>
        <span className="status-text" aria-hidden="true">
          {recorder.text}
        </span>
      </p>
    </NavTooltip>
  );
}

export function SideNav({
  screen,
  collapsed,
  bottomLine,
  now,
}: {
  screen: Route["screen"];
  collapsed: boolean;
  bottomLine: string;
  /** The most recent live session, or null when nothing is recording. */
  now: { id: string; label: string } | null;
}) {
  return (
    <nav
      className={collapsed ? "sidenav collapsed" : "sidenav"}
      id="sidenav"
      aria-label="Flightpath"
    >
      <div className="nav-list" id="nav-list">
        <p className="nav-label">Now</p>
        <NowEntry now={now} collapsed={collapsed} />
        <p className="nav-label nav-label-browse">Browse</p>
        <NavTooltip text="Sessions" enabled={collapsed}>
          <a
            href="#sessions"
            data-route="sessions"
            aria-current={screen === "sessions" ? "page" : undefined}
          >
            <span className="nav-icon">
              <SessionsIcon />
            </span>
            <span className="nav-text">Sessions</span>
          </a>
        </NavTooltip>
        <NavTooltip text="Settings" enabled={collapsed}>
          <a
            href="#settings"
            data-route="settings"
            aria-current={screen === "settings" ? "page" : undefined}
          >
            <span className="nav-icon">
              <SettingsIcon />
            </span>
            <span className="nav-text">Settings</span>
          </a>
        </NavTooltip>
      </div>
      <div className="nav-footer">
        <RecorderStatus collapsed={collapsed} />
        <p className="nav-bottom">{bottomLine}</p>
      </div>
    </nav>
  );
}
