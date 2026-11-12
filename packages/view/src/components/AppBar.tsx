import { ConnectionStatus } from "./ConnectionStatus";
import { Mark, MenuIcon, ShareIcon } from "./icons";

export function AppBar({
  collapsed,
  onToggleNav,
  sessionTitle,
  onShare,
}: {
  collapsed: boolean;
  onToggleNav: () => void;
  /** The open session's title on a session route; null elsewhere. */
  sessionTitle: string | null;
  /** Opens the share preview; passed only on a session route. */
  onShare?: (() => void) | undefined;
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
      {onShare !== undefined && (
        <button
          type="button"
          className="share-button"
          aria-label="Share this session's numbers"
          onClick={onShare}
        >
          <ShareIcon />
          <span className="share-button-label">Share</span>
        </button>
      )}
      <span className="appbar-spacer"></span>
      <ConnectionStatus />
    </header>
  );
}
