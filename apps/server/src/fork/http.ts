/**
 * The inbox and channel settings, as plain HTTP routes under `/api/fork/` so contracts stay
 * untouched. Clients authenticate like the device hub proxy: a session cookie, or a `wsTicket`
 * query parameter minted for media.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash for ETags.
import * as NodeCrypto from "node:crypto";
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
import type * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import { BotRuntime, type BotEvent, type BotRuntimeError } from "./bot/BotRuntime.ts";
import * as Bots from "./bot/operations.ts";
import { answerQuestion, authenticateTool, runTool } from "./bot/tools.ts";
import type { HubEvent } from "./channels/hub.ts";
import { InboxRuntime, type InboxRuntimeShape } from "./inbox/InboxRuntime.ts";
import * as Artifacts from "./inbox/artifacts.ts";
import * as Inbox from "./inbox/operations.ts";
import type * as InboxStore from "./inbox/store.ts";

const FORK_ROUTE_PREFIX = "/api/fork";
const CHANNELS = `${FORK_ROUTE_PREFIX}/channels`;
const INBOX = `${FORK_ROUTE_PREFIX}/inbox`;
const BOTS = `${FORK_ROUTE_PREFIX}/bots`;

const NO_STORE = { "cache-control": "no-store" };
const JSON_MAX_BODY_BYTES = 256 * 1024;
const TOO_LARGE = new Inbox.ForkHttpError({
  status: 413,
  code: "too_large",
  detail: "The file is larger than 100 MB.",
});
const HEARTBEAT_INTERVAL = Duration.seconds(20);

const errorResponse = (error: Inbox.ForkHttpError) =>
  HttpServerResponse.jsonUnsafe(
    { code: error.code, message: error.detail, ...(error.field ? { field: error.field } : {}) },
    { status: error.status, headers: NO_STORE },
  );

const ok = (value: unknown) => HttpServerResponse.jsonUnsafe(value, { headers: NO_STORE });

/**
 * Reads revalidate through the browser's own cache: it sends If-None-Match by itself, which a
 * custom header would not do without a CORS preflight, and an unchanged answer costs a 304.
 */
const REVALIDATE = { "cache-control": "private, no-cache" };

export const okRevalidated = (value: unknown, ifNoneMatch: string | undefined) => {
  const text = JSON.stringify(value);
  const tag = NodeCrypto.createHash("sha1").update(text).digest("base64url");
  // Weak: compression may re-encode the body; the JSON is what the tag stands for.
  const etag = `W/"${tag}"`;
  const unchanged = ifNoneMatch
    ?.split(",")
    .some((candidate) => candidate.trim().replace(/^W\//i, "") === `"${tag}"`);
  return unchanged
    ? HttpServerResponse.empty({ status: 304, headers: { ...REVALIDATE, etag } })
    : HttpServerResponse.text(text, {
        contentType: "application/json",
        headers: { ...REVALIDATE, etag },
      });
};

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

const fileBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > Inbox.UPLOAD_MAX_BYTES) {
    return yield* TOO_LARGE;
  }
  return new Uint8Array(
    yield* request.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(Inbox.UPLOAD_MAX_BYTES),
      ),
      Effect.mapError(() => TOO_LARGE),
    ),
  );
});

export const makeRoute =
  (
    runtime: InboxRuntimeShape,
    bots: BotRuntime["Service"],
    contextFiles: Artifacts.Artifacts["Service"],
  ) =>
  <A, R>(
    method: "GET" | "POST",
    path: HttpRouter.PathInput,
    scope: AuthEnvironmentScope,
    handle: Effect.Effect<
      A,
      | Inbox.ForkHttpError
      | BotRuntimeError
      | PlatformError.PlatformError
      | InboxStore.InboxStoreError,
      R
    >,
  ) =>
    HttpRouter.add(
      method,
      path,
      Effect.gen(function* () {
        yield* authenticateMediaRequest(scope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* handle.pipe(
          Effect.provideService(InboxRuntime, runtime),
          Effect.provideService(BotRuntime, bots),
          Effect.provideService(Artifacts.Artifacts, contextFiles),
          Effect.map((value) =>
            HttpServerResponse.isHttpServerResponse(value)
              ? value
              : method === "GET"
                ? okRevalidated(value, request.headers["if-none-match"])
                : ok(value),
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

/** One stream for every fork view: inbox and channel changes, and which bot changed. */
const eventsRoute = (runtime: InboxRuntimeShape, bots: BotRuntime["Service"]) =>
  HttpRouter.add(
    "GET",
    `${INBOX}/events`,
    Effect.gen(function* () {
      yield* authenticateMediaRequest(AuthOrchestrationReadScope);
      const events = Stream.callback<HubEvent | BotEvent>((queue) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const offer = (event: HubEvent | BotEvent) => Queue.offerUnsafe(queue, event);
            const stopInbox = yield* runtime.subscribe(offer);
            const stopBots = bots.subscribe(offer);
            return stopInbox.pipe(Effect.andThen(Effect.sync(stopBots)));
          }),
          (unsubscribe) => unsubscribe,
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

/** The `t3bot` CLI in a bot's work thread: no session, the bot's own token instead. */
const toolRoute = (
  runtime: InboxRuntimeShape,
  bots: BotRuntime["Service"],
  contextFiles: Artifacts.Artifacts["Service"],
) =>
  HttpRouter.add(
    "POST",
    `${BOTS}/tool`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* body;
      const tool = yield* authenticateTool(request.headers["authorization"], input);
      return ok({ output: yield* runTool(tool) });
    }).pipe(
      Effect.provideService(BotRuntime, bots),
      Effect.provideService(Artifacts.Artifacts, contextFiles),
      Effect.provideService(InboxRuntime, runtime),
      Effect.catchTags({ ForkHttpError: (error) => Effect.succeed(errorResponse(error)) }),
    ),
  );

/** The ASCII fallback keeps old clients working; `filename*` carries the real name. */
export const attachmentDisposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

const mediaRoute = (route: ReturnType<typeof makeRoute>) =>
  route(
    "GET",
    `${INBOX}/media`,
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const params = yield* query;
      const response = yield* Inbox.media(params);
      const name = params.get("name");
      return HttpServerResponse.uint8Array(response.body, {
        contentType: response.contentType ?? "application/octet-stream",
        headers: {
          ...(name ? { "content-disposition": attachmentDisposition(name) } : {}),
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
          // An adapter's file never runs as a page on this origin.
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    }),
  );

const routes = (
  runtime: InboxRuntimeShape,
  bots: BotRuntime["Service"],
  contextFiles: Artifacts.Artifacts["Service"],
) => {
  const route = makeRoute(runtime, bots, contextFiles);
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
      `${CHANNELS}/probe`,
      AuthSettingsWriteScope,
      body.pipe(Effect.flatMap(Inbox.probeChannel)),
    ),
    route(
      "POST",
      `${CHANNELS}/simulate`,
      AuthSettingsWriteScope,
      body.pipe(Effect.flatMap(Inbox.simulateChannel)),
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
      `${INBOX}/conversations`,
      AuthOrchestrationReadScope,
      query.pipe(
        Effect.flatMap((params) => channelIdOf({ channelId: params.get("channelId") })),
        Effect.flatMap(Inbox.listInbox),
      ),
    ),
    route(
      "GET",
      `${INBOX}/delegation`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Inbox.readDelegation)),
    ),
    route(
      "GET",
      `${INBOX}/conversation`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Inbox.readConversation)),
    ),
    route(
      "GET",
      `${INBOX}/delegate-options`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Inbox.delegateOptions)),
    ),
    route(
      "POST",
      `${INBOX}/read`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.setRead)),
    ),
    route(
      "POST",
      `${INBOX}/seen`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.markSeen)),
    ),
    route(
      "POST",
      `${INBOX}/settle`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.settle)),
    ),
    route(
      "POST",
      `${INBOX}/read-all`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.markAllRead)),
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
    route(
      "POST",
      `${INBOX}/discard-draft`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Inbox.discardDraft)),
    ),
    route(
      "POST",
      `${INBOX}/upload`,
      AuthOrchestrationOperateScope,
      Effect.all([query, fileBody]).pipe(
        Effect.flatMap(([params, bytes]) => Inbox.upload(params, bytes)),
      ),
    ),
    mediaRoute(route),
    route("GET", BOTS, AuthOrchestrationReadScope, Bots.listBots()),
    route(
      "GET",
      `${BOTS}/bot`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Bots.readBot)),
    ),
    route(
      "POST",
      `${BOTS}/create`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.createBot)),
    ),
    route(
      "POST",
      `${BOTS}/role`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.saveRole)),
    ),
    route(
      "POST",
      `${BOTS}/delete`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.deleteBot)),
    ),
    route(
      "POST",
      `${BOTS}/send`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.sendMessage)),
    ),
    route(
      "POST",
      `${BOTS}/routine/run`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.runRoutineNow)),
    ),
    route(
      "POST",
      `${BOTS}/item/reopen`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.reopenItem)),
    ),
    route(
      "POST",
      `${BOTS}/memory/forget`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.forgetMemory)),
    ),
    route(
      "POST",
      `${BOTS}/memory/to-role`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.moveMemoryToRole)),
    ),
    route(
      "GET",
      `${BOTS}/note`,
      AuthOrchestrationReadScope,
      query.pipe(Effect.flatMap(Bots.readNote)),
    ),
    route(
      "POST",
      `${BOTS}/seen`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.markSeen)),
    ),
    route(
      "POST",
      `${BOTS}/pause`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.setPaused)),
    ),
    route(
      "POST",
      `${BOTS}/settings`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.saveSettings)),
    ),
    route(
      "POST",
      `${BOTS}/thread/handback`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(Bots.handBack)),
    ),
    route(
      "POST",
      `${BOTS}/question/answer`,
      AuthOrchestrationOperateScope,
      body.pipe(Effect.flatMap(answerQuestion)),
    ),
    toolRoute(runtime, bots, contextFiles),
    eventsRoute(runtime, bots),
  );
};

export const routesLayer = Layer.unwrap(
  Effect.gen(function* () {
    return routes(yield* InboxRuntime, yield* BotRuntime, yield* Artifacts.Artifacts);
  }),
);
