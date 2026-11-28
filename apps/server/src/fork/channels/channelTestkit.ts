import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Config from "./config.ts";
import * as Hub from "./hub.ts";
import * as Transport from "./transport.ts";
import type { ChannelEvent } from "./protocol.ts";

// Promise test boundaries retain the pre-migration assertions while exercising the Effect service.
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | import("effect/FileSystem").FileSystem
    | import("effect/Path").Path
    | import("effect/http/HttpClient").HttpClient
    | Scope.Scope
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
  );
export interface LegacyTransport {
  readonly request: (input: Transport.AdapterRequest) => Promise<Transport.AdapterResponse>;
  readonly events: (
    token: string | null,
    emit: (event: ChannelEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}
const adapt = (transport: LegacyTransport): Transport.ChannelTransport => ({
  request: (input) =>
    Effect.tryPromise({
      try: () => transport.request(input),
      catch: (error) =>
        Transport.isAdapterUnreachableError(error)
          ? error
          : new Transport.AdapterTransportError({
              message: error instanceof Error ? error.message : String(error),
            }),
    }),
  events: (token) =>
    Stream.callback<
      ChannelEvent,
      Transport.AdapterUnreachableError | Transport.AdapterTransportError
    >((queue) =>
      Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        yield* Effect.tryPromise({
          try: () =>
            transport.events(
              token,
              (event) => {
                Queue.offerUnsafe(queue, event);
              },
              controller.signal,
            ),
          catch: (error) =>
            Transport.isAdapterUnreachableError(error)
              ? error
              : new Transport.AdapterTransportError({
                  message: error instanceof Error ? error.message : String(error),
                }),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => Queue.end(queue),
            onFailure: (error) => Queue.fail(queue, error),
          }),
        );
      }),
    ),
});
export async function createTestHub(
  options: Omit<Hub.ChannelHubOptions, "transportFor"> & {
    readonly transportFor?: (entry: Config.ChannelConfigEntry) => LegacyTransport;
  },
  execute: typeof run = run,
) {
  const scope = Scope.makeUnsafe();
  const { transportFor, ...settings } = options;
  const service = await execute(
    Hub.make({
      ...settings,
      ...(transportFor
        ? {
            transportFor: (entry: Config.ChannelConfigEntry) =>
              Effect.succeed(adapt(transportFor(entry))),
          }
        : {}),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    service,
    start: () => execute(service.start()),
    stop: () => execute(Scope.close(scope, Exit.void)),
    list: service.list,
    get: service.get,
    revision: service.revision,
    save: (...args: Parameters<typeof service.save>) => execute(service.save(...args)),
    remove: (...args: Parameters<typeof service.remove>) => execute(service.remove(...args)),
    test: (...args: Parameters<typeof service.test>) => execute(service.test(...args)),
    probe: (...args: Parameters<typeof service.probe>) => execute(service.probe(...args)),
    simulate: (...args: Parameters<typeof service.simulate>) => execute(service.simulate(...args)),
    getJson: <A>(
      channelId: string,
      path: string,
      schema: import("effect/Schema").Decoder<A>,
      options?: { readonly cacheMs?: number },
    ) => execute(service.getJson(channelId, path, schema, options)),
    getAllPages: <A>(
      channelId: string,
      path: string,
      schema: import("effect/Schema").Decoder<A>,
      options: { readonly cacheMs?: number; readonly maxPages: number },
    ) => execute(service.getAllPages(channelId, path, schema, options)),
    getMedia: (...args: Parameters<typeof service.getMedia>) => execute(service.getMedia(...args)),
    postJson: (...args: Parameters<typeof service.postJson>) => execute(service.postJson(...args)),
    upload: (...args: Parameters<typeof service.upload>) => execute(service.upload(...args)),
    invalidate: (...args: Parameters<typeof service.invalidate>) =>
      Effect.runSync(service.invalidate(...args)),
    publish: (...args: Parameters<typeof service.publish>) =>
      Effect.runSync(service.publish(...args)),
    subscribe: (...args: Parameters<typeof service.subscribe>) => {
      const stop = Effect.runSync(service.subscribe(...args));
      return () => Effect.runSync(stop);
    },
  };
}
export function httpTransport(base: string, execute: typeof run = run): LegacyTransport {
  Config.resolveLoopbackBase(base);
  return {
    request: (input) =>
      execute(
        Transport.httpTransport(base).pipe(Effect.flatMap((transport) => transport.request(input))),
      ),
    events: (token, emit, signal) =>
      execute(
        Transport.httpTransport(base).pipe(
          Effect.flatMap((transport) =>
            transport
              .events(token)
              .pipe(Stream.runForEach((event) => Effect.sync(() => emit(event)))),
          ),
          Effect.scoped,
          Effect.raceFirst(
            Effect.callback<void>((resume) => {
              if (signal.aborted) resume(Effect.void);
              else signal.addEventListener("abort", () => resume(Effect.void), { once: true });
            }),
          ),
        ),
      ).catch((error) => {
        if (!signal.aborted)
          throw new Error(error instanceof Error ? error.message : String(error));
      }),
  };
}
export const readChannelsFile = (path: string) => run(Config.readChannelsFile(path));
export const createTokenReader = () => {
  const reader = run(Config.createTokenReader);
  return async (path: string) => run((await reader)(path));
};

export const withTestClock = Effect.fn("ChannelTest.withClock")(function* <A>(
  program: (execute: typeof run, advance: (milliseconds: number) => Promise<void>) => Promise<A>,
) {
  const context = yield* Effect.context();
  const testRun: typeof run = (effect) =>
    Effect.runPromiseWith(context)(
      effect.pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      ),
    );
  return yield* Effect.promise(() =>
    program(testRun, (milliseconds) =>
      Effect.runPromiseWith(context)(TestClock.adjust(milliseconds)),
    ),
  );
});
