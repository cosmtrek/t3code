import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Transport from "./transport.ts";
import type { ChannelEvent } from "./protocol.ts";

export interface LegacyTransport {
  readonly request: (input: Transport.AdapterRequest) => Promise<Transport.AdapterResponse>;
  readonly events: (
    token: string | null,
    emit: (event: ChannelEvent) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}
export const adapt = (transport: LegacyTransport): Transport.ChannelTransport => ({
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
