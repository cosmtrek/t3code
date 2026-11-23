/**
 * Turns domain events into bot events: the end of a run in a work thread ends that bot's turn,
 * and what happens in a thread a bot started is queued for it. Every other event costs one
 * map lookup.
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BotRuntime } from "./BotRuntime.ts";
import { finishRun, isTerminalRunStatus, notify, nowIso } from "./operations.ts";

export const followThreads = Effect.fn("ForkBot.followThreads")(function* <E, R>(
  events: Stream.Stream<OrchestrationV2DomainEvent, E, R>,
) {
  const runtime = yield* BotRuntime;
  // A run is updated many times after it ends (usage, checkpoints); report its end once.
  const reported = new Set<string>();
  // Untraced: it runs for every domain event in the environment.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const workBot = runtime.workThreads.get(event.threadId);
    if (workBot !== undefined) {
      if (event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) {
        yield* finishRun(workBot, event.payload.id, event.payload.status);
      }
      return;
    }
    const botId = runtime.ownedThreads.get(event.threadId);
    if (botId === undefined) return;
    const owned = runtime
      .store()
      .listThreads(botId)
      .find((thread) => thread.threadId === event.threadId);
    if (owned === undefined) return;
    const touch = () => {
      if (owned.itemId !== null) runtime.store().updateItem(botId, owned.itemId, {}, nowIso());
    };
    if (event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) {
      const key = `${event.payload.id}:${event.payload.status}`;
      if (reported.has(key)) return;
      reported.add(key);
      touch();
      const failed = event.payload.status !== "completed";
      const wakes = owned.follow === "now" || (owned.follow === "attention" && failed);
      yield* notify(
        botId,
        `Thread ${owned.threadId}${owned.itemId === null ? "" : ` (item #${owned.itemId})`} ${event.payload.status.replace("_", " ")}. Read it with \`thread read\`.`,
        wakes,
      );
    }
    if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
      const key = `request:${event.payload.id}`;
      if (reported.has(key)) return;
      reported.add(key);
      touch();
      const what = event.payload.kind === "user_input" ? "a question answered" : "an approval";
      // Blocked until someone answers, so it always wakes the bot.
      yield* notify(
        botId,
        `Thread ${owned.threadId} waits for ${what}. Only the user can answer it in the thread: tell them with \`say\`.`,
        true,
      );
    }
  });
  yield* events.pipe(
    Stream.runForEach((event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A bot could not take a thread event.", { cause }),
        ),
      ),
    ),
  );
});
