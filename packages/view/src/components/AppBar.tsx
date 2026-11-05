import { ConnectionStatus } from "./ConnectionStatus";
import { Mark, MenuIcon } from "./icons";

export function AppBar({
  collapsed,
  onToggleNav,
  sessionTitle,
}: {
  collapsed: boolean;
  onToggleNav: () => void;
  /** The open session's title on a session route; null elsewhere. */
  sessionTitle: string | null;
}) {
  return (
    <header className="appbar">
      <button
        type="button"
        className="menu-button"
        id="nav-toggle"
        aria-expanded={!collapsed}
        aria-controls="nav-list"
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        onClick={onToggleNav}
      >
        <MenuIcon />
      </button>
      <a className="brand" href="#sessions">
        <Mark />
        <span>flightpath</span>
      </a>
      {sessionTitle !== null && (
        <>
          <span className="appbar-divider" aria-hidden="true"></span>
          <nav className="crumb" aria-label="Breadcrumb">
            <a href="#sessions">Sessions</a>
            <span aria-hidden="true">/</span>
            <span className="crumb-current">{sessionTitle}</span>
          </nav>
        </>
      )}
      <span className="appbar-spacer"></span>
      <ConnectionStatus />
    </header>
  );
}
