import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { createSseParser } from "@t3tools/fork-client/sse";
import { resolveLoopbackBase, ChannelConfigError } from "./config.ts";
import { parseChannelEvent, type ChannelEvent } from "./protocol.ts";

export interface AdapterRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly bytes?: Uint8Array;
  readonly token: string | null;
  readonly media?: boolean;
}
export interface AdapterResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}
export class AdapterUnreachableError extends Schema.TaggedError<AdapterUnreachableError>()(
  "AdapterUnreachableError",
  { message: Schema.String },
) {}
export const isAdapterUnreachableError = Schema.is(AdapterUnreachableError);
export class AdapterTransportError extends Schema.TaggedError<AdapterTransportError>()(
  "AdapterTransportError",
  { message: Schema.String },
) {}
export interface ChannelTransport {
  readonly request: (
    input: AdapterRequest,
  ) => Effect.Effect<AdapterResponse, AdapterUnreachableError | AdapterTransportError, Scope.Scope>;
  readonly events: (
    token: string | null,
  ) => Stream.Stream<ChannelEvent, AdapterUnreachableError | AdapterTransportError>;
}
const encodeJson = (body: unknown) => JSON.stringify(body);
const LIMITS = { timeoutMs: 10_000, maxBytes: 25 * 1024 * 1024 };
const MEDIA_LIMITS = { timeoutMs: 120_000, maxBytes: 200 * 1024 * 1024 };
const scrub = (text: string, token: string | null) =>
  token ? text.split(token).join("***") : text;
const underlying = (error: unknown) =>
  HttpClientError.isHttpClientError(error) ? error.reason.cause : error;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const unreachable = (error: unknown, token: string | null) => {
  const cause = underlying(error);
  const text =
    cause instanceof Error && cause.cause instanceof Error ? cause.cause.message : String(cause);
  return new AdapterUnreachableError({ message: scrub(text, token) });
};

export const httpTransport = Effect.fn("ChannelTransport.make")(function* (rawBaseUrl: string) {
  const baseUrl = yield* Effect.try({
    try: () => resolveLoopbackBase(rawBaseUrl),
    catch: (error) => error as ChannelConfigError,
  });
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));
  const request = Effect.fn("ChannelTransport.request")((input: AdapterRequest) =>
    Effect.suspend(() => {
      const limits = input.media ? MEDIA_LIMITS : LIMITS;
      let received = false;
      return Effect.gen(function* () {
        let outgoing = HttpClientRequest.make(input.method)(`${baseUrl}${input.path}`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        );
        if (input.token !== null) outgoing = HttpClientRequest.bearerToken(outgoing, input.token);
        if (input.bytes !== undefined)
          outgoing = HttpClientRequest.bodyUint8Array(
            outgoing,
            input.bytes,
            "application/octet-stream",
          );
        else if (input.body !== undefined)
          outgoing = HttpClientRequest.bodyText(
            outgoing,
            yield* Effect.try({
              try: () => encodeJson(input.body),
              catch: (error) => unreachable(error, input.token),
            }),
            "application/json",
          );
        const response = yield* execute(outgoing).pipe(
          Effect.mapError((error) => unreachable(error, input.token)),
        );
        received = true;
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > limits.maxBytes) {
          const web = HttpClientResponse.toWeb(response);
          if (Option.isSome(web))
            yield* Effect.tryPromise({
              try: () => web.value.body?.cancel() ?? Promise.resolve(),
              catch: (error) =>
                new AdapterTransportError({ message: scrub(message(error), input.token) }),
            });
          return yield* new AdapterTransportError({
            message: `The adapter answered with ${declared} bytes, more than allowed.`,
          });
        }
        const body = new Uint8Array(
          yield* response.arrayBuffer.pipe(
            Effect.mapError(
              (error) =>
                new AdapterTransportError({
                  message: scrub(message(underlying(error)), input.token),
                }),
            ),
          ),
        );
        if (body.byteLength > limits.maxBytes)
          return yield* new AdapterTransportError({
            message: "The adapter's answer is larger than allowed.",
          });
        return {
          status: response.status,
          contentType: response.headers["content-type"] ?? null,
          body,
        };
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: limits.timeoutMs,
          orElse: () =>
            Effect.fail(
              received
                ? new AdapterTransportError({ message: "The operation was aborted due to timeout" })
                : new AdapterUnreachableError({
                    message: "TimeoutError: The operation was aborted due to timeout",
                  }),
            ),
        }),
      );
    }),
  );
  const events = (token: string | null) =>
    Stream.unwrap(
      Effect.gen(function* () {
        let outgoing = HttpClientRequest.get(`${baseUrl}/events`).pipe(
          HttpClientRequest.setHeader("accept", "text/event-stream"),
        );
        if (token !== null) outgoing = HttpClientRequest.bearerToken(outgoing, token);
        const response = yield* execute(outgoing).pipe(
          Effect.mapError(
            (error) =>
              new AdapterUnreachableError({ message: scrub(String(underlying(error)), token) }),
          ),
        );
        const web = HttpClientResponse.toWeb(response);
        if (
          response.status < 200 ||
          response.status >= 300 ||
          (Option.isSome(web) && web.value.body === null)
        ) {
          if (Option.isSome(web))
            yield* Effect.tryPromise({
              try: () => web.value.body?.cancel() ?? Promise.resolve(),
              catch: (error) =>
                new AdapterTransportError({ message: scrub(message(error), token) }),
            });
          return yield* new AdapterTransportError({
            message: `The adapter's event stream answered ${response.status}.`,
          });
        }
        const decoder = new TextDecoder();
        let pending: ChannelEvent[] = [];
        const parse = createSseParser((event, data) => {
          const parsed = parseChannelEvent(event, data);
          if (parsed !== null) pending.push(parsed);
        });
        return Stream.concat(
          Stream.succeed<ChannelEvent>({ type: "connected" }),
          response.stream.pipe(
            Stream.mapError(
              (error) =>
                new AdapterTransportError({ message: scrub(message(underlying(error)), token) }),
            ),
            Stream.flatMap((chunk) => {
              pending = [];
              parse(decoder.decode(chunk, { stream: true }));
              return Stream.fromIterable(pending);
            }),
          ),
        );
      }),
    );
  return { request, events } satisfies ChannelTransport;
});
