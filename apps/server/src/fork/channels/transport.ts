// @effect-diagnostics globalFetch:off extendsNativeError:off - Runs outside the Effect runtime: adapter sockets, timers, and plain callbacks.
import { resolveLoopbackBase } from "./config.ts";
import { createSseParser } from "@t3tools/fork-client/sse";

import { parseChannelEvent, type ChannelEvent } from "./protocol.ts";

export interface AdapterRequest {
  readonly method: "GET" | "POST";
  /** Path and query, such as `/conversations?relevant=1`. */
  readonly path: string;
  readonly body?: unknown;
  /** A file to upload, sent as the request's raw body instead of JSON. */
  readonly bytes?: Uint8Array;
  readonly token: string | null;
  /** A file the adapter may first fetch from its service; it gets more time and room. */
  readonly media?: boolean;
}

export interface AdapterResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

/** The adapter could not be reached at all, as opposed to answering with an error. */
export class AdapterUnreachableError extends Error {}

/** How the server talks to one adapter: over loopback HTTP, or in process for the example. */
export interface ChannelTransport {
  readonly request: (input: AdapterRequest) => Promise<AdapterResponse>;
  /**
   * Delivers events until the stream ends or `signal` aborts, starting with `connected` once the
   * stream is open; rejects when it cannot connect.
   */
  readonly events: (
    token: string | null,
    onEvent: (event: ChannelEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

const LIMITS = { timeoutMs: 10_000, maxBytes: 25 * 1024 * 1024 };
// Chat videos and documents run to tens of megabytes; the adapter may download them first.
const MEDIA_LIMITS = { timeoutMs: 120_000, maxBytes: 200 * 1024 * 1024 };

const authHeaders = (token: string | null): Record<string, string> =>
  token === null ? {} : { authorization: `Bearer ${token}` };

/** Throws for an address off this machine, so HTTP and SSE share one check. */
export function httpTransport(rawBaseUrl: string): ChannelTransport {
  const baseUrl = resolveLoopbackBase(rawBaseUrl);
  return {
    request: async ({ method, path, body, bytes: upload, token, media }) => {
      const limits = media ? MEDIA_LIMITS : LIMITS;
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            accept: "application/json",
            ...authHeaders(token),
            ...(upload !== undefined
              ? { "content-type": "application/octet-stream" }
              : body === undefined
                ? {}
                : { "content-type": "application/json" }),
          },
          ...(upload !== undefined
            ? { body: upload }
            : body === undefined
              ? {}
              : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(limits.timeoutMs),
        });
      } catch (error) {
        throw new AdapterUnreachableError(
          error instanceof Error && error.cause instanceof Error
            ? error.cause.message
            : String(error),
        );
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > limits.maxBytes) {
        await response.body?.cancel();
        throw new Error(`The adapter answered with ${declared} bytes, more than allowed.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limits.maxBytes) {
        throw new Error("The adapter's answer is larger than allowed.");
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: bytes,
      };
    },
    events: async (token, onEvent, signal) => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/events`, {
          headers: { accept: "text/event-stream", ...authHeaders(token) },
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        throw new AdapterUnreachableError(String(error));
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(`The adapter's event stream answered ${response.status}.`);
      }
      onEvent({ type: "connected" });
      const parse = createSseParser((event, data) => {
        const parsed = parseChannelEvent(event, data);
        if (parsed !== null) onEvent(parsed);
      });
      const decoder = new TextDecoder();
      try {
        for await (const chunk of response.body) parse(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
  };
}
