/**
 * Turns domain events into bot events: the end of a run in a work thread ends that bot's turn,
 * and what happens in a thread a bot started is queued for it. Every other event costs one
 * map lookup.
 */
import { ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { BotRuntime } from "./BotRuntime.ts";
import { finishRun, isTerminalRunStatus, notify, nowIso, postError } from "./operations.ts";
import type { OwnedThread } from "./store.ts";
import { takenOverByUser } from "./tools.ts";

/** What a bot's thread did: a run moved, or it asks for an answer or approval. */
export type ThreadChange =
  | { readonly type: "run"; readonly runId: string; readonly status: string }
  | { readonly type: "request"; readonly requestId: string; readonly kind: string };

const describe = (thread: OwnedThread) =>
  `Thread ${thread.threadId}${thread.itemId === null ? "" : ` (item #${thread.itemId})`}`;

/**
 * Records what a bot's thread did and tells the bot when its follow-up says to. The store keeps
 * what was reported, so a run updated many times after it ends, or seen again by reconcile after
 * a restart, is reported once.
 */
const observeThread = Effect.fn("ForkBot.observeThread")(function* (
  owned: OwnedThread,
  change: ThreadChange,
) {
  const runtime = yield* BotRuntime;
  const store = runtime.store();
  const botId = owned.botId;
  const touch = () => {
    if (owned.itemId !== null) store.updateItem(botId, owned.itemId, {}, nowIso());
  };

  if (change.type === "request") {
    if (owned.takenOver || owned.lastRequestId === change.requestId) return;
    store.updateThread(owned.threadId, { lastRequestId: change.requestId });
    touch();
    const what = change.kind === "user_input" ? "a question answered" : "an approval";
    // Blocked until someone answers, so it always wakes the bot.
    yield* notify(
      botId,
      `${describe(owned)} waits for ${what}. Only the user can answer it in the thread: tell them.`,
      true,
    );
    return;
  }

  if (!isTerminalRunStatus(change.status)) {
    if (owned.status === change.status && owned.lastRunKey?.startsWith(`${change.runId}:`)) return;
    store.updateThread(owned.threadId, { status: change.status });
    // A new run the bot did not send is the user typing in its thread: it is theirs now.
    if (!owned.takenOver && owned.lastRunKey?.startsWith(`${change.runId}:`) !== true) {
      const taken = yield* takenOverByUser(owned.projectId, owned.threadId, owned.handedBackAt);
      if (taken) {
        store.updateThread(owned.threadId, { takenOver: true });
        yield* notify(
          botId,
          `The user took over ${describe(owned).toLowerCase()}. Leave it to them until they hand it back.`,
          false,
        );
      }
    }
    store.updateThread(owned.threadId, { lastRunKey: `${change.runId}:${change.status}` });
    runtime.publish(botId);
    return;
  }

  const key = `${change.runId}:${change.status}`;
  if (owned.lastRunKey === key) return;
  store.updateThread(owned.threadId, { status: change.status, lastRunKey: key });
  if (owned.takenOver) {
    runtime.publish(botId);
    return;
  }
  touch();
  const failed = change.status !== "completed";
  const wakes = owned.follow === "now" || (owned.follow === "attention" && failed);
  yield* notify(
    botId,
    `${describe(owned)} ${change.status.replace("_", " ")}. Read it with \`thread read\`.`,
    wakes,
  );
});

export const followThreads = Effect.fn("ForkBot.followThreads")(function* <E, R>(
  events: Stream.Stream<OrchestrationV2DomainEvent, E, R>,
) {
  const runtime = yield* BotRuntime;
  // Work-thread requests already posted; a request is updated more than once while pending.
  const posted = new Set<string>();
  // Untraced: it runs for every domain event in the environment.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const workBot = runtime.workThreads.get(event.threadId);
    if (workBot !== undefined) {
      if (event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) {
        yield* finishRun(workBot, event.payload.id, event.payload.status);
      }
      // The turn cannot go on until someone answers in the work thread, and only the user can.
      if (
        event.type === "runtime-request.updated" &&
        event.payload.status === "pending" &&
        !posted.has(event.payload.id)
      ) {
        posted.add(event.payload.id);
        yield* postError(
          workBot,
          `The bot's turn waits for ${event.payload.kind === "user_input" ? "an answer" : "an approval"} in its work thread. Open the work thread to answer it.`,
        );
      }
      return;
    }
    if (!runtime.ownedThreads.has(event.threadId)) return;
    const owned = runtime.store().getThread(event.threadId);
    if (owned === null) return;
    if (event.type === "run.updated") {
      yield* observeThread(owned, {
        type: "run",
        runId: event.payload.id,
        status: event.payload.status,
      });
    }
    if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
      yield* observeThread(owned, {
        type: "request",
        requestId: event.payload.id,
        kind: event.payload.kind,
      });
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

/**
 * On startup: events do not replay, so read each of the bots' threads and report what changed
 * while the server was down, as the event would have.
 */
export const reconcileThreads = Effect.fn("ForkBot.reconcileThreads")(function* () {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = runtime.existingStore();
  if (store === null) return;
  for (const listed of store.listThreads()) {
    if (listed.takenOver) continue;
    const shell = yield* threads
      .getThreadShell(ThreadId.make(listed.threadId))
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) continue;
    if (shell.latestRunId !== null && shell.status !== "idle") {
      yield* observeThread(store.getThread(listed.threadId) ?? listed, {
        type: "run",
        runId: shell.latestRunId,
        status: shell.status,
      });
    }
    if (shell.pendingRuntimeRequest !== null) {
      yield* observeThread(store.getThread(listed.threadId) ?? listed, {
        type: "request",
        requestId: shell.pendingRuntimeRequest.id,
        kind: shell.pendingRuntimeRequest.kind,
      });
    }
  }
});
