/**
 * A linked thread's state shows in the inbox (Investigating, the thread card), but the inbox
 * reads it only on fetch. Its run and lifecycle events tell clients to fetch again.
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { InboxRuntime } from "./InboxRuntime.ts";

/** Events that change what the inbox shows about a thread; message streaming is left out. */
const LINKED_THREAD_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
] satisfies ReadonlyArray<OrchestrationV2DomainEvent["type"]>);

export const followLinkedThreads = Effect.fn("ForkInbox.followLinkedThreads")(function* <E, R>(
  events: Stream.Stream<OrchestrationV2DomainEvent, E, R>,
) {
  const { hub, store } = yield* InboxRuntime;
  // A run is updated many times (usage, checkpoints); the inbox only shows its status.
  const runStatus = new Map<string, string>();
  yield* events.pipe(
    Stream.filter((event) => LINKED_THREAD_EVENT_TYPES.has(event.type)),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const channelId = store.channelOfThread(event.threadId);
        if (channelId === null) return;
        if (event.type === "run.updated") {
          const status = `${event.payload.id}:${event.payload.status}`;
          if (runStatus.get(event.threadId) === status) return;
          runStatus.set(event.threadId, status);
        }
        yield* hub.publish({ type: "inbox", channelId });
      }),
    ),
  );
});
