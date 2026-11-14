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
  events: Stream.Stream<Pick<OrchestrationV2DomainEvent, "type" | "threadId">, E, R>,
) {
  const { hub, store } = yield* InboxRuntime;
  yield* events.pipe(
    Stream.filter((event) => LINKED_THREAD_EVENT_TYPES.has(event.type)),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        const channelId = store.channelOfThread(event.threadId);
        if (channelId !== null) hub.publish({ type: "inbox", channelId });
      }),
    ),
  );
});
