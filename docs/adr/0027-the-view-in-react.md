# ADR-0027: The view is built in React, as its own package

**Status:** Accepted · 2026-10-26

## Context

The view started as plain TypeScript with no framework and no runtime dependencies. That was a choice made for the view shell, not an earlier decision. Only the shell, about 250 lines, is built so far, along with a first settings screen that is being reworked.

A first look at that settings screen found that about half of its problems were hand-written UI plumbing:

- keeping the screen's data valid across redraws;
- carrying unsaved edits through a redraw;
- a flag to ignore the page's own address change;
- a prompt that could open twice;
- guards against data that couldn't be missing.

The screens still to come are harder. The steps lens updates live while the user scrolls, collapses turns, selects a step and filters. The lenses and the coach's findings panel follow later. Writing the view by hand would keep producing this kind of bug and the rework that goes with it.

Switching costs about a day now, and three to seven days once the rest of the view is built.

## Decision

- **The view is written in React** (`react`, `react-dom`), pinned to exact versions and bundled into the build. Nothing is loaded from a CDN.
- **It lives in its own package, `packages/view`,** in this repository. It is not a separate repository: features that span the daemon and the screen stay in one pull request with shared types, and the repository keeps one set of gates and one release.
- **esbuild builds it into the plugin's `dist/view`** in the same build as the daemon, so the daemon serves it as before and install and release don't change.
- **Dependency direction:** the view may import types and pure modules (the formatter) from the daemon package. The daemon never imports the view.
- **What we don't add:**
  - no component kit, because the mockups are our design and we build our own components;
  - no CSS-in-JS: the existing plain CSS and class names stay;
  - no router, because the hash routing stays in our shell;
  - no state library: React state and context, until a change shows a need.
- **Every new runtime dependency** is named and justified in the description of the change that adds it, pinned exactly, and approved by the maintainers. A chart library or a list virtualizer comes in only with the change that needs it.
- **Gates:**
  - `rules-of-hooks` and `exhaustive-deps` are lint errors;
  - knip knows the view's entry points;
  - jscpd covers `.tsx`;
  - the whole view bundle stays within **150 KB gzipped**, checked by `pnpm quality`, and the budget is raised only by a decision.
- **Tests:**
  - the browser and accessibility tests stay the contract, unchanged;
  - waits target loaded states;
  - React Testing Library only where a component needs a unit test.
- **Libraries, each added with its first real user:**
  - TanStack Query, for server data: loading, saving, errors, caching. Comes in with the settings screen.
  - Zustand, for the live session's store, fed by the stream client. Comes in with the live stream and steps lens.
  - TanStack Virtual, for long step lists. Comes in with the steps lens.
  - Radix primitives, only when a hand-built accessible widget proves costly.

  No component kit, no date, icon or utility library (we use `Intl`, our own inline SVG icons, and our own helpers), and no state framework beyond Zustand.
- **Bundle discipline:**
  - screens load on demand (`React.lazy` with esbuild code splitting);
  - imports name exactly what they use;
  - a single copy of React across the workspace;
  - the build reports the largest modules on every run;
  - the daemon serves pre-compressed assets.
- **Live updates:** the stream client is a module with no framework in it. Screens subscribe to it, and rows are memoized so an update re-renders only the rows that changed.

## Consequences

- The view gains its first runtime dependency (two packages, about 45 KB compressed) and the hooks discipline that comes with React. Lint rules and a test on the stream hook enforce it.
- The shell is ported and the settings screen is rebuilt in React. The steps lens, session picker and recorder-health screens are built in React from the start. The schedule moves by about a day.
- Contributors after launch work with a framework most of them already know.

_Erratum, 2026-11-06: wording only, no change to the decision._
