export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parsing: feed text, get messages. */
export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private event = "message";
  private dataLines: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const message = this.line(line);
      if (message !== null) messages.push(message);
      newline = this.buffer.indexOf("\n");
    }
    return messages;
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (
        this.id === null &&
        this.event === "message" &&
        this.dataLines.length === 0
      ) {
        return null;
      }
      const message: SseMessage = {
        id: this.id,
        event: this.event,
        data: this.dataLines.join("\n"),
      };
      this.id = null;
      this.event = "message";
      this.dataLines = [];
      return message;
    }
    if (line.startsWith(":")) return null;
    const split = line.indexOf(":");
    const field = split === -1 ? line : line.slice(0, split);
    const value = split === -1 ? "" : line.slice(split + 1).replace(/^ /, "");
    if (field === "id") this.id = value;
    if (field === "event") this.event = value;
    if (field === "data") this.dataLines.push(value);
    return null;
  }
}
