/**
 * Turns the end of a run in a bot's work thread into the end of that bot's turn. Every other
 * event costs one map lookup.
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BotRuntime } from "./BotRuntime.ts";
import { finishRun, isTerminalRunStatus } from "./operations.ts";

export const followWorkThreads = Effect.fn("ForkBot.followWorkThreads")(function* <E, R>(
  events: Stream.Stream<OrchestrationV2DomainEvent, E, R>,
) {
  const runtime = yield* BotRuntime;
  yield* events.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "run.updated" || !isTerminalRunStatus(event.payload.status)) {
        return Effect.void;
      }
      const botId = runtime.workThreads.get(event.threadId);
      return botId === undefined
        ? Effect.void
        : finishRun(botId, event.payload.id, event.payload.status).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("A bot could not finish its turn.", { botId, cause }),
            ),
          );
    }),
  );
});
