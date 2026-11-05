import { useQuery } from "@tanstack/react-query";

import {
  fetchSettings,
  SETTINGS_QUERY_KEY,
  UnauthorizedError,
} from "../settings/api";
import { AccessKeyPage } from "./AccessKeyPage";
import { Shell } from "./Shell";

// One settings request at start-up, through the query cache
// the settings screen shares: it checks the token and fills
// the nav footer. A daemon that cannot be reached leaves the
// shell to say so through its own requests; the shell itself
// still renders.
export function App({ token }: { token: string | null }) {
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => fetchSettings(token as string),
    enabled: token !== null,
  });

  if (token === null || query.error instanceof UnauthorizedError) {
    return <AccessKeyPage />;
  }
  if (query.isPending) {
    return null;
  }
  return <Shell token={token} payload={query.data ?? null} />;
}
