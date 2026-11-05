import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  chooseTheme,
  followThemeChoices,
  readThemeChoice,
  type ThemeChoice,
} from "../theme";
import { GroupBand } from "./SettingsGroup";

// The Appearance card: the theme radiogroup. It applies at
// once and is not part of the save bar — the choice is this
// browser's preference, stored by the theme module, never a
// daemon setting.

const OPTIONS: readonly { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function keyTarget(key: string, index: number): number | null {
  const last = OPTIONS.length - 1;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return index === last ? 0 : index + 1;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return index === 0 ? last : index - 1;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return last;
  }
  return null;
}

export function AppearanceGroup() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => followThemeChoices(setChoice), []);
  const pick = (next: ThemeChoice, focusIndex?: number): void => {
    setChoice(next);
    chooseTheme(next);
    if (focusIndex !== undefined) {
      radios.current[focusIndex]?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const target = keyTarget(event.key, index);
    if (target === null) {
      return;
    }
    event.preventDefault();
    const option = OPTIONS[target];
    if (option !== undefined) {
      pick(option.value, target);
    }
  };
  return (
    <section className="settings-group" aria-labelledby="group-appearance-h">
      <GroupBand
        headingId="group-appearance-h"
        title="Appearance"
        description="How this page looks, in this browser."
      />
      <div className="group-fields group-fields-appearance">
        <div role="radiogroup" aria-label="Theme" className="theme-options">
          {OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => {
                radios.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={choice === option.value}
              tabIndex={choice === option.value ? 0 : -1}
              className="theme-option"
              onClick={() => pick(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
