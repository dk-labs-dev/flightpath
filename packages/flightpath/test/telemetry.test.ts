import { describe, expect, it } from "vitest";

import { redactTelemetryRecord } from "../src/redact/index.js";

// Hand-written OTLP/HTTP JSON shapes, as the exporter sends them.
function logBody(
  attributes: [string, string][],
  resourceAttributes: [string, string][],
) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: resourceAttributes.map(([key, v]) => ({
            key,
            value: { stringValue: v },
          })),
        },
        scopeLogs: [
          {
            logRecords: [
              {
                eventName: "tool_decision",
                body: { stringValue: "the assistant's full response text" },
                attributes: attributes.map(([key, v]) => ({
                  key,
                  value: { stringValue: v },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("redactTelemetryRecord", () => {
  it("drops identity attributes at any depth", () => {
    const out = redactTelemetryRecord(
      logBody(
        [
          ["user.email", "person@example.com"],
          ["user.account_id", "acc-123"],
          ["organization.id", "org-9"],
          ["tool_name", "Bash"],
        ],
        [
          ["user.email", "person@example.com"],
          ["service.name", "claude-code"],
        ],
      ) as Record<string, unknown>,
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("acc-123");
    expect(text).not.toContain("org-9");
    expect(text).not.toContain("user.email");
    expect(out.redaction_version).toBe(1);
  });

  it("keeps safe attribute text and reduces the rest to sizes", () => {
    const out = redactTelemetryRecord(
      logBody(
        [
          ["tool_name", "Bash"],
          ["decision", "accept"],
          ["prompt", "the user's prompt text"],
        ],
        [],
      ) as Record<string, unknown>,
    );
    const logs = out.resourceLogs as {
      scopeLogs: {
        logRecords: {
          attributes: unknown;
          body: unknown;
          eventName: unknown;
        }[];
      }[];
    }[];
    const record = logs[0]?.scopeLogs[0]?.logRecords[0];
    expect(record?.eventName).toBe("tool_decision");
    expect(record?.attributes).toEqual([
      { key: "tool_name", value: { stringValue: "Bash" } },
      { key: "decision", value: { stringValue: "accept" } },
      { key: "prompt", value: { chars: 22 } },
    ]);
    expect(record?.body).toEqual({ stringValue: { chars: 34 } });
  });

  it("drops identity keys in plain objects too", () => {
    const out = redactTelemetryRecord({
      eventName: "api_request",
      user_id: "u-1",
      accountUuid: "a-2",
      nested: { email: "p@example.com", model: "claude-sonnet" },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("u-1");
    expect(text).not.toContain("a-2");
    expect(text).not.toContain("p@example.com");
  });

  it("keeps a boolean sent as a string, and reduces any other string under that key", () => {
    const record = (success: string) =>
      redactTelemetryRecord({
        attributes: [{ key: "success", value: { stringValue: success } }],
      }) as {
        attributes: { key: string; value: unknown }[];
      };
    expect(record("false").attributes[0]?.value).toEqual({
      stringValue: "false",
    });
    expect(record("true").attributes[0]?.value).toEqual({
      stringValue: "true",
    });
    expect(record("perhaps").attributes[0]?.value).toEqual({ chars: 7 });
  });

  it("keeps numeric attribute values", () => {
    const out = redactTelemetryRecord({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "api_request",
                  attributes: [
                    { key: "duration_ms", value: { intValue: "812" } },
                    { key: "input_tokens", value: { intValue: 1200 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const text = JSON.stringify(out);
    expect(text).toContain("812");
    expect(text).toContain("1200");
  });
});
