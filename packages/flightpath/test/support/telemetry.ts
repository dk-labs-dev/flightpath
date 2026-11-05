import { startDaemon, type RunningDaemon } from "../../src/daemon/server.js";
import { readToken } from "./daemon.js";

export type TelemetryAttributeValue = string | number | boolean;

function attributeValue(
  value: TelemetryAttributeValue,
): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function attribute(
  key: string,
  value: TelemetryAttributeValue,
): Record<string, unknown> {
  return { key, value: attributeValue(value) };
}

export function telemetryRecord(
  eventName: string,
  attrs: Record<string, TelemetryAttributeValue>,
  atMs: number,
  sequence: number,
): Record<string, unknown> {
  return {
    timeUnixNano: String(atMs * 1_000_000),
    attributes: [
      attribute("event.name", eventName),
      ...Object.entries(attrs).map(([key, value]) => attribute(key, value)),
      attribute("event.sequence", sequence),
    ],
  };
}

export function telemetryExport(
  records: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "user.email", value: { stringValue: "PLANTED-EMAIL" } },
            { key: "account.id", value: { stringValue: "PLANTED-ACCOUNT" } },
          ],
        },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

/** Start a daemon over a data folder and read its token. */
export async function startTelemetryDaemon(
  dataDir: string,
): Promise<{ daemon: RunningDaemon; token: string }> {
  const daemon = await startDaemon({ dataDir, version: "test" });
  if (daemon === null) throw new Error("daemon did not start");
  const token = readToken(dataDir);
  return { daemon, token };
}
