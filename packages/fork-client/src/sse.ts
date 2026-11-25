/** Splits an SSE byte stream into (event, data) frames. Keeps a partial frame between chunks. */
export function createSseParser(onFrame: (event: string, data: string) => void) {
  let buffer = "";
  // A CRLF split across chunks must not read as two line ends.
  let endedWithCr = false;
  return (input: string) => {
    const chunk = endedWithCr && input.startsWith("\n") ? input.slice(1) : input;
    endedWithCr = chunk.endsWith("\r");
    buffer += chunk.replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0 || event !== "message") onFrame(event, data.join("\n"));
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/** A frame of `/api/fork/inbox/events`; `reconnect` is the client's own, after a drop. */
export interface ForkEvent {
  readonly type: string;
  readonly channelId?: string;
  readonly botId?: string;
  /** A `bot-activity` event's line, its tool call if it is one, and the thread it came from. */
  readonly text?: string;
  readonly step?: unknown;
  readonly threadId?: string;
}
