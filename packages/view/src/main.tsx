import { createRoot } from "react-dom/client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./components/App";
import { applyThemeChoice, followThemeChoices } from "./theme";
import { readToken } from "./token";

import "./tokens.css";
import "./view.css";

// The entry point: the token is read once, here, and handed to
// the app as a prop — no module holds it as shared state. The
// query client is created once with it; a failed request is
// shown as it is, never retried into a different answer.

followThemeChoices(applyThemeChoice);

const app = document.getElementById("app") as HTMLElement;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

createRoot(app).render(
  <QueryClientProvider client={queryClient}>
    <App token={readToken()} />
  </QueryClientProvider>,
);
