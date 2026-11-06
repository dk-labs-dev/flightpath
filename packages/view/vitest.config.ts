import process from "node:process";

import { defineConfig } from "vitest/config";

// The tests choose the jsdom environment with a per-file comment;
// this file carries only the CI retry (option A): a failed
// test is retried once on CI and named in the job summary when the
// retry is what saved it. Local runs never retry.
export default defineConfig({
  test: {
    retry: process.env.CI ? 1 : 0,
  },
});
