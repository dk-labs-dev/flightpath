// The pages, served without the token: a page itself holds
// nothing secret, and its data requests carry the token in a
// header (ADR-0022).

import type { IncomingMessage, ServerResponse } from "node:http";

import { readViewFile, viewDir } from "../view.js";
import type { RouteContext } from "./context.js";

// The view's page itself, served only at / and /view, never
// through the asset route.
export function serveViewPage(
  _ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  const dir = viewDir();
  const page = dir ? readViewFile(dir, "index.html") : null;
  if (!page) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { "content-type": page.contentType })
    .end(page.content);
}

// The view's asset names carry a build hash, so they can be
// cached hard.
export function serveViewAsset(
  _ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
  path: string,
): void {
  const name = path.slice("/view/".length);
  const dir = viewDir();
  const file = dir && name !== "index.html" ? readViewFile(dir, name) : null;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, {
      "content-type": file.contentType,
      "cache-control": "public, max-age=31536000, immutable",
    })
    .end(file.content);
}

// The /settings address sends the browser to the view's
// Settings screen. The token rides in the address's fragment,
// which never reaches the server — and a redirect whose
// Location has its own fragment (/#settings) would replace
// the token's fragment and drop it. So the daemon answers
// with a page that carries the fragment over itself.
export function serveSettingsRedirect(
  _ctx: RouteContext,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html>
<title>Settings — flightpath</title>
<script>
  const token = /token=([^&]+)/.exec(location.hash);
  location.replace("/#settings" + (token ? "&token=" + token[1] : ""));
</script>
`);
}
