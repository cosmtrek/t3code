/**
 * The inbox and channel settings, as plain HTTP routes under `/api/fork/` so contracts stay
 * untouched. Clients authenticate like the device hub proxy: a session cookie, or a `wsTicket`
 * query parameter minted for media.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import type { HubEvent } from "./channels/hub.ts";
import { InboxRuntime, type InboxRuntimeShape } from "./inbox/InboxRuntime.ts";
import * as Inbox from "./inbox/operations.ts";

const FORK_ROUTE_PREFIX = "/api/fork";
const CHANNELS = `${FORK_ROUTE_PREFIX}/channels`;
const INBOX = `${FORK_ROUTE_PREFIX}/inbox`;

const NO_STORE = { "cache-control": "no-store" };
const JSON_MAX_BODY_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL = Duration.seconds(20);

const errorResponse = (error: Inbox.ForkHttpError) =>
  HttpServerResponse.jsonUnsafe(
    { code: error.code, message: error.detail, ...(error.field ? { field: error.field } : {}) },
    { status: error.status, headers: NO_STORE },
  );

const ok = (value: unknown) => HttpServerResponse.jsonUnsafe(value, { headers: NO_STORE });

const query = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  Option.match(requestUrl(request), {
    onNone: () => new URLSearchParams(),
    onSome: (url) => url.searchParams,
  }),
);

const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.mapError(
      () => new Inbox.ForkHttpError({ status: 400, code: "bad_request", detail: "Send JSON." }),
    ),
  );
});

const makeRoute =
  (runtime: InboxRuntimeShape) =>
  <A, R>(
    method: "GET" | "POST",
    path: HttpRouter.PathInput,
    scope: AuthEnvironmentScope,
    handle: Effect.Effect<A, Inbox.ForkHttpError, R>,
  ) =>
    HttpRouter.add(
      method,
      path,
      Effect.gen(function* () {
        yield* authenticateMediaRequest(scope);
        return yield* handle.pipe(
          Effect.provideService(InboxRuntime, runtime),
          Effect.map((value) =>
            HttpServerResponse.isHttpServerResponse(value) ? value : ok(value),
          ),
          Effect.catchTags({ ForkHttpError: (error) => Effect.succeed(errorResponse(error)) }),
        );
      }),
    );

const channelIdOf = (input: unknown) =>
  typeof input === "object" && input !== null && typeof Reflect.get(input, "channelId") === "string"
    ? Effect.succeed(Reflect.get(input, "channelId") as string)
    : Effect.fail(
        new Inbox.ForkHttpError({ status: 400, code: "bad_request", detail: "Name a channel." }),
      );

const eventsRoute = (runtime: InboxRuntimeShape) =>
  HttpRouter.add(
    "GET",
    `${INBOX}/events`,
    Effect.gen(function* () {
      yield* authenticateMediaRequest(AuthOrchestrationReadScope);
      const events = Stream.callback<HubEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => runtime.subscribe((event) => Queue.offerUnsafe(queue, event))),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ).pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
      return HttpServerResponse.stream(
        Stream.make(": open\n\n").pipe(
          Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
          Stream.encodeText,
        ),
        {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
        },
      );
    }),
  );

const mediaRoute = (route: ReturnType<typeof makeRoute>) =>
  route(
    "GET",
    `${INBOX}/media`,
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const response = yield* Inbox.media(yield* query);
      return HttpServerResponse.uint8Array(response.body, {
        contentType: response.contentType ?? "application/octet-stream",
        headers: {
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
          // An adapter's file never runs as a page on this origin.
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    }),
  );

const routes = (runtime: InboxRuntimeShape) => {
  const route = makeRoute(runtime);
  return Layer.mergeAll(
    route("GET", CHANNELS, AuthOrchestrationReadScope, Inbox.listChannels()),
    route(
      "POST",
      `${CHANNELS}/save`,
      AuthSettingsWriteScope,
      Effect.gen(function* () {
        const input = yield* body;
        const create =
          typeof input === "object" && input !== null && Reflect.get(input, "create") === true;
        return yield* Inbox.saveChannel(Reflect.get(input as object, "channel"), { create });
      }),
    ),
    route(
      "POST",
      `${CHANNELS}/remove`,
      AuthSettingsWriteScope,
      body.pipe(Effect.flatMap(channelIdOf), Effect.flatMap(Inbox.removeChannel)),
    ),
    route(
      "POST",
      `${CHANNELS}/test`,
      AuthOrchestrationReadScope,
      body.pipe(Effect.flatMap(channelIdOf), Effect.flatMap(Inbox.testChannel)),
    ),
    route("GET", `${INBOX}/overview`, AuthOrchestrationReadScope, Inbox.overview()),
    route(
      "GET",
      `${INBOX}/items`,
      AuthOrchestrationReadScope,
      query.pipe(
        Effect.flatMap((params) => channelIdOf({ channelId: params.get("channelId") })),
        Effect.flatMap(Inbox.listItems),
      ),
    ),
    route(
      "GET",
      `${INBOX}/topic`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Inbox.readTopic)),
    ),
    route(
      "GET",
      `${INBOX}/delegate-options`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Inbox.delegateOptions)),
    ),
    route(
      "POST",
      `${INBOX}/mark`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.mark)),
    ),
    route(
      "POST",
      `${INBOX}/delegate`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.delegate)),
    ),
    route(
      "POST",
      `${INBOX}/send`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.send)),
    ),
    mediaRoute(route),
    eventsRoute(runtime),
  );
};

export const routesLayer = Layer.unwrap(
  Effect.gen(function* () {
    return routes(yield* InboxRuntime);
  }),
);
