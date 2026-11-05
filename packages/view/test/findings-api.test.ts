import { QueryClient, skipToken } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissFinding,
  findingsOptions,
  findingsQueryKey,
  loadFindings,
} from "../src/session/api.js";
import { jsonResponse } from "./fixtures.js";
import { finding } from "./support/findings.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown = []) {
  const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse(status, body)));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("the findings read", () => {
  it("asks the session's findings route with the token header", async () => {
    const fetchSpy = stubFetch(200, [finding()]);
    await expect(loadFindings("tok", "s 1")).resolves.toEqual([finding()]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/sessions/s%201/findings", {
      headers: { "x-flightpath-token": "tok" },
    });
  });

  it("resolves null for a session the daemon does not know", async () => {
    stubFetch(404);
    await expect(loadFindings("tok", "gone")).resolves.toBeNull();
  });

  it("throws on any other failure so the next stream news retries it", async () => {
    stubFetch(500);
    await expect(loadFindings("tok", "s1")).rejects.toThrow("500");
  });

  it("stands down until the session and token are known", () => {
    expect(findingsOptions(null, "tok").queryFn).toBe(skipToken);
    expect(findingsOptions("s1", null).queryFn).toBe(skipToken);
    expect(findingsOptions("s1", "tok").queryKey).toEqual(
      findingsQueryKey("s1"),
    );
  });

  it("reads through the query client", async () => {
    stubFetch(200, [finding()]);
    const client = new QueryClient();
    await expect(
      client.fetchQuery(findingsOptions("s1", "tok")),
    ).resolves.toEqual([finding()]);
  });
});

describe("dismissing a finding", () => {
  it("posts the dismiss route with the token header", async () => {
    const fetchSpy = stubFetch(200, null);
    await dismissFinding("tok", "s1", "rebuild-7");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/s1/findings/rebuild-7/dismiss",
      { method: "POST", headers: { "x-flightpath-token": "tok" } },
    );
  });

  it("fails when the daemon does not answer 200", async () => {
    stubFetch(404, null);
    await expect(dismissFinding("tok", "s1", "x")).rejects.toThrow("404");
  });
});
