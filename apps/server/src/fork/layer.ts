/**
 * Everything this fork adds to the server, merged into one layer so `server.ts` carries a single
 * line for it. See "Inbox seams" in FORK.md.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as BotRuntime from "./bot/BotRuntime.ts";
import { followWorkThreads } from "./bot/events.ts";
import { reconcile } from "./bot/operations.ts";
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
            followWorkThreads(threads.streamDomainEvents),
            Effect.yieldNow.pipe(Effect.andThen(reconcile())),
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
  Layer.provide(Layer.merge(InboxRuntime.layer, BotRuntime.layer)),
);
