import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCleanups } from "./support/cleanup.js";
import {
  DAEMON_SUITE,
  callDaemon,
  distDir,
  makeRoot,
  startTestDaemon,
} from "./support/daemon.js";
import { requiredValue } from "./support/rows.js";

// The view shell: the daemon serves the page and its assets
// without the token, the page is never cached, and the asset
// names carry the build hash.
const distView = join(distDir, "view");

afterEach(async () => {
  await runCleanups();
});

describe("the view shell", DAEMON_SUITE, () => {
  it("serves the page and its assets without the token", async () => {
    const { root } = makeRoot("flightpath-view-test-");
    const { port } = await startTestDaemon(root);

    const page = await callDaemon(port, { method: "GET", path: "/" });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    const html = page.body;

    const script = requiredValue(
      /\/view\/(view-[^"]+\.js)/.exec(html)?.[1],
      "the view script file name",
    );
    const style = requiredValue(
      /\/view\/(view-[^"]+\.css)/.exec(html)?.[1],
      "the view stylesheet file name",
    );

    const js = await callDaemon(port, {
      method: "GET",
      path: `/view/${script}`,
    });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.headers["cache-control"]).toContain("immutable");

    const css = await callDaemon(port, {
      method: "GET",
      path: `/view/${style}`,
    });
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");

    const font = requiredValue(
      readdirSync(join(distView, "fonts")).find((name) =>
        name.endsWith(".woff2"),
      ),
      "a woff2 font file",
    );
    const servedFont = await callDaemon(port, {
      method: "GET",
      path: `/view/fonts/${font}`,
    });
    expect(servedFont.status).toBe(200);
    expect(servedFont.headers["content-type"]).toBe("font/woff2");

    const favicon = await callDaemon(port, {
      method: "GET",
      path: "/view/favicon.svg",
    });
    expect(favicon.status).toBe(200);
    expect(favicon.headers["content-type"]).toBe("image/svg+xml");
    expect(favicon.body).toBe(
      readFileSync(
        join(distDir, "..", "..", "view", "src", "favicon.svg"),
        "utf8",
      ),
    );

    const atView = await callDaemon(port, { method: "GET", path: "/view" });
    expect(atView.status).toBe(200);
    expect(atView.body).toBe(html);
  });

  it("does not serve files outside the view", async () => {
    const { root } = makeRoot("flightpath-view-test-");
    const { port } = await startTestDaemon(root);

    for (const path of [
      "/view/../daemon.js",
      "/view/%2e%2e/daemon.js",
      "/view/fonts/../../daemon.js",
      "/view/daemon.js",
    ]) {
      const response = await callDaemon(port, { method: "GET", path });
      expect(response.status, path).toBe(404);
    }
  });
});
