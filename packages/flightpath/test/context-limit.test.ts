import { describe, expect, it } from "vitest";

import { NO_CATEGORIES } from "./support/context-report.js";
import {
  contextReportFor,
  contextWindowFor,
  samplesForModel,
} from "../src/api/context-limit.js";
import type {
  ContextReportRow,
  ContextSampleRow,
  RequestRow,
} from "../src/storage/index.js";

// The window rule in isolation: the model list first, a
// /context report above it, and measured samples only ever
// raising what the list or the report gave.

function sample(contextTokens: number): ContextSampleRow {
  return { id: 1, requestId: 1, sampledAt: 1, contextTokens };
}

function report(window: number): ContextReportRow {
  return {
    model: "claude-sonnet-4-6",
    window,
    autocompactBuffer: null,
    ...NO_CATEGORIES,
    reportedAt: 1,
  };
}

describe("contextWindowFor", () => {
  it("reads the 5.5 models' 1M window from the list", () => {
    expect(contextWindowFor("claude-sonnet-5-5", [], null)).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(contextWindowFor("claude-opus-5-5", [], null)).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
  });

  it("reads the 200K windows from the list, the dated Haiku id included", () => {
    expect(contextWindowFor("claude-sonnet-4-6", [], null)).toEqual({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(contextWindowFor("claude-haiku-4-5", [], null)).toEqual({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
    expect(contextWindowFor("claude-haiku-4-5-20251001", [], null)).toEqual({
      tokens: 200_000,
      source: "model-list",
      reportedAt: null,
    });
  });

  it("reads a [1m] suffix as the 1M window", () => {
    expect(contextWindowFor("claude-sonnet-4-6[1m]", [], null)).toEqual({
      tokens: 1_000_000,
      source: "model-list",
      reportedAt: null,
    });
  });

  it("guesses nothing for a model the list does not name", () => {
    expect(contextWindowFor("claude-sonnet-4-5", [], null)).toEqual({
      tokens: null,
      source: "unknown",
      reportedAt: null,
    });
    expect(contextWindowFor(null, [], null)).toEqual({
      tokens: null,
      source: "unknown",
      reportedAt: null,
    });
    // Samples do not rescue an unlisted model.
    expect(
      contextWindowFor("claude-sonnet-4-5", [sample(250_000)], null),
    ).toEqual({ tokens: null, source: "unknown", reportedAt: null });
  });

  it("raises a listed window past a measured sample, and never lowers it", () => {
    expect(
      contextWindowFor("claude-sonnet-4-6", [sample(250_000)], null),
    ).toEqual({ tokens: 1_000_000, source: "inferred", reportedAt: null });
    expect(
      contextWindowFor("claude-sonnet-5-5", [sample(100_000)], null),
    ).toEqual({ tokens: 1_000_000, source: "model-list", reportedAt: null });
  });

  it("lets a report set the window, with samples only raising from it", () => {
    expect(
      contextWindowFor("claude-sonnet-4-6", [sample(150_000)], report(200_000)),
    ).toEqual({
      tokens: 200_000,
      source: "context-command",
      reportedAt: 1,
    });
    expect(
      contextWindowFor("claude-sonnet-4-6", [sample(250_000)], report(200_000)),
    ).toEqual({ tokens: 1_000_000, source: "inferred", reportedAt: null });
  });

  it("carries the report's moment while the report is the source", () => {
    const row: ContextReportRow = {
      model: "claude-sonnet-4-6",
      window: 200_000,
      autocompactBuffer: null,
      ...NO_CATEGORIES,
      reportedAt: 1_700_000_000_000,
    };
    expect(contextWindowFor("claude-sonnet-4-6", [], row)).toEqual({
      tokens: 200_000,
      source: "context-command",
      reportedAt: 1_700_000_000_000,
    });
    // A sample past the report's window raises the size:
    // the measurement is the source then, and the report's
    // moment goes with the source it no longer is.
    expect(
      contextWindowFor("claude-sonnet-4-6", [sample(250_000)], row),
    ).toEqual({ tokens: 1_000_000, source: "inferred", reportedAt: null });
  });
});

describe("contextReportFor", () => {
  it("takes the latest report when two stored ids share a key", () => {
    // Reports come back oldest first: a dated id stored
    // earlier and its undated twin stored later share a key,
    // and the later report is the one that stands.
    const reports: ContextReportRow[] = [
      {
        model: "claude-haiku-4-5-20251001",
        window: 200_000,
        autocompactBuffer: null,
        ...NO_CATEGORIES,
        reportedAt: 1,
      },
      {
        model: "claude-haiku-4-5",
        window: 250_000,
        autocompactBuffer: null,
        ...NO_CATEGORIES,
        reportedAt: 2,
      },
    ];
    expect(contextReportFor(reports, "claude-haiku-4-5")?.window).toBe(250_000);
    expect(contextReportFor(reports, "claude-sonnet-5-5")).toBeNull();
    expect(contextReportFor(reports, null)).toBeNull();
  });
});

describe("samplesForModel", () => {
  function request(id: number, model: string | null): RequestRow {
    return {
      id,
      turnId: 1,
      branchId: null,
      model,
      querySource: "main",
      startedAt: id,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      tokenSource: null,
      effort: null,
      shapeHash: null,
      cacheLifetimes: null,
    };
  }

  it("keeps only the samples measured on requests to the model", () => {
    const requests = [
      request(1, "claude-sonnet-5-5"),
      request(2, "claude-haiku-4-5"),
      request(3, null),
    ];
    const samples: ContextSampleRow[] = [
      { id: 1, requestId: 1, sampledAt: 1, contextTokens: 300_000 },
      { id: 2, requestId: 2, sampledAt: 2, contextTokens: 50_000 },
      { id: 3, requestId: 3, sampledAt: 3, contextTokens: 400_000 },
      { id: 4, requestId: null, sampledAt: 4, contextTokens: 500_000 },
    ];
    expect(
      samplesForModel(samples, requests, "claude-haiku-4-5").map(
        (row) => row.id,
      ),
    ).toEqual([2]);
    expect(samplesForModel(samples, requests, null)).toEqual([]);
  });
});
