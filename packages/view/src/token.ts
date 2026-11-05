const TOKEN_KEY = "flightpath-token";

// The token arrives in the fragment ("#session/<id>&token=…" or
// "#token=…") and leaves the address bar at once — a token in a
// URL gets copied and screenshotted — into session storage,
// where a tab opened without a fragment finds it again.
export function readToken(): string | null {
  const hash = window.location.hash;
  const match = /token=([^&]+)/.exec(hash);
  if (match?.[1]) {
    const token = decodeURIComponent(match[1]);
    sessionStorage.setItem(TOKEN_KEY, token);
    const cleaned = hash.replace(/&?token=[^&]+/, "");
    history.replaceState(
      null,
      "",
      window.location.pathname + (cleaned === "#" ? "" : cleaned),
    );
    return token;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}
