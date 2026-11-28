/**
 * Everything this fork adds to the server, merged into one layer so `server.ts` carries a single
 * line for it. See "Inbox seams" in FORK.md.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as BotFiles from "./bot/BotFiles.ts";
import * as BotRuntime from "./bot/BotRuntime.ts";
import { startConnectors } from "./bot/connectors/registry.ts";
import { followThreads, reconcileThreads } from "./bot/events.ts";
import { fireDueRoutines, reconcile } from "./bot/operations.ts";
import { routesLayer } from "./http.ts";
import * as InboxRuntime from "./inbox/InboxRuntime.ts";
import { followLinkedThreads } from "./inbox/linkedThreads.ts";

const linkedThreadsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    // From the latest event on: the inbox reads current state on every fetch.
    yield* followLinkedThreads(threads.streamDomainEvents).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The inbox stopped following linked threads.", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);

const botsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const runtime = yield* BotRuntime.BotRuntime;
    // Nothing runs until a bot exists.
    yield* runtime.active.await.pipe(
      Effect.andThen(
        // Follow first, then catch up, so a run that ends in between is not missed.
        Effect.all(
          [
            followThreads(threads.streamDomainEvents),
            Effect.yieldNow.pipe(
              Effect.andThen(reconcile()),
              Effect.andThen(reconcileThreads()),
              // Catching up is best effort; it must not stop the following beside it.
              Effect.catchCause((cause) =>
                Effect.logWarning("Bots could not catch up after a restart.", { cause }),
              ),
            ),
            // Routines are checked twice a minute against their stored due times.
            Effect.suspend(() => fireDueRoutines()).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Bot routines failed to fire.", { cause }),
              ),
              Effect.andThen(Effect.sleep("30 seconds")),
              Effect.forever,
            ),
            Effect.scoped(startConnectors),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Bots stopped following their threads.", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layer = Layer.mergeAll(routesLayer, linkedThreadsLayer, botsLayer).pipe(
  Layer.provide(
    Layer.merge(InboxRuntime.layer, BotRuntime.layer.pipe(Layer.provide(BotFiles.layer))),
  ),
);
