import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { registerCleanup } from "./cleanup.js";

// Loopback servers that stand in for the daemon when a test needs a
// failure shape no real daemon produces, or needs to see exactly what a
// hook sent. Each stops itself at cleanup.

export interface StubServer {
  port: number;
  close: () => void;
}

export interface Received {
  method: string | undefined;
  body: string;
  token: string | undefined;
  url: string | undefined;
}

/** Listen on a loopback port; resolve with it and a closer. */
function listen(server: Server): Promise<StubServer> {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const close = () => {
        server.closeAllConnections();
        server.close();
      };
      registerCleanup(close);
      resolvePromise({ port, close });
    });
  });
}

/** Answers every request with `status` and `body`, and keeps what it was sent. */
export async function startRecordingServer(
  status = 200,
  body = "",
): Promise<StubServer & { received: Received[] }> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let sent = "";
    request.on("data", (chunk: Buffer) => {
      sent += chunk.toString();
    });
    request.on("end", () => {
      received.push({
        method: request.method,
        body: sent,
        token: request.headers["x-flightpath-token"] as string | undefined,
        url: request.url,
      });
      response.writeHead(status).end(body);
    });
  });
  return { ...(await listen(server)), received };
}

export function startClosingServer(): Promise<StubServer> {
  const server: Server = createServer((request) => {
    request.socket.destroy();
  });
  return listen(server);
}

/** Answers with `status` and `body` only after `delayMs`. */
export function startSlowServer(
  status: number,
  body: string,
  delayMs: number,
): Promise<StubServer> {
  const server: Server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      setTimeout(() => response.writeHead(status).end(body), delayMs);
    });
  });
  return listen(server);
}

/** Point a data folder's port and token files at a stub. */
export function writeDaemonFiles(dataDir: string, port: number): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "port"), String(port));
  writeFileSync(join(dataDir, "token"), "test-token");
}
