// The theme choice: one value in this browser's storage,
// read before the first paint and applied as the document's
// data-theme. An explicit choice sets the attribute; System
// removes it, so the stylesheet's colour-scheme query decides.
// Storage can be blocked: reads fall back to System, and a
// write is skipped quietly while the pick still applies here.

export type ThemeChoice = "system" | "light" | "dark";

// Kept in step with the page's inline script by the reload test.
const THEME_KEY = "flightpath-theme";

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = choice;
  }
}

export function chooseTheme(choice: ThemeChoice): void {
  applyThemeChoice(choice);
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Blocked storage: the pick applies to this tab only.
  }
}

// Another tab's pick arrives as a storage event; the listener
// is handed the choice that tab stored.
export function followThemeChoices(
  onChoice: (choice: ThemeChoice) => void,
): () => void {
  const listener = (event: StorageEvent): void => {
    if (event.key === THEME_KEY) {
      onChoice(readThemeChoice());
    }
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
