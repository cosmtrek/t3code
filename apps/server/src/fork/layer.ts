/**
 * Everything this fork adds to the server, merged into one layer so `server.ts` carries a single
 * line for it. See "Inbox seams" in FORK.md.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as BotRuntime from "./bot/BotRuntime.ts";
import { fireDueMentions, scanMentions } from "./bot/chat.ts";
import { followThreads, reconcileThreads } from "./bot/events.ts";
import { configuredChannels, fireDueRoutines, reconcile } from "./bot/operations.ts";
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

/**
 * Mentions of the user: each channel change reads its (cached) conversation list for new ones,
 * changes arriving together read it once, and a sweep catches what an event missed.
 */
const watchMentions = Effect.gen(function* () {
  const inbox = yield* InboxRuntime.InboxRuntime;
  const changed = yield* Queue.unbounded<string>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      inbox.subscribe((event) => {
        if (event.type === "inbox") Queue.offerUnsafe(changed, event.channelId);
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  const scan = (channelId: string) =>
    scanMentions(channelId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check a channel for mentions.", { cause }),
      ),
    );
  yield* Effect.all(
    [
      Queue.takeAll(changed).pipe(
        Effect.flatMap((ids) => Effect.forEach(new Set(ids), scan, { discard: true })),
        Effect.forever,
      ),
      configuredChannels().pipe(
        Effect.flatMap((channels) =>
          Effect.forEach(channels, (channel) => scan(channel.id), { discard: true }),
        ),
        Effect.andThen(Effect.sleep("1 minute")),
        Effect.forever,
      ),
      // Due mentions are a store read; checked often so the delay stays close to its length.
      Effect.suspend(() => fireDueMentions()).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Mention wakes failed.", { cause })),
        Effect.andThen(Effect.sleep("5 seconds")),
        Effect.forever,
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

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
            Effect.scoped(watchMentions),
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
