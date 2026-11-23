// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Compares tool tokens in constant time; times are ISO text.
/**
 * What `t3bot` does. The CLI sends its arguments as they are; parsing, checks, and effects all
 * happen here, so every action a bot takes passes the same place.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { CommandId, MessageId, ProjectId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../../project/ProjectService.ts";
import { ForkHttpError } from "../inbox/operations.ts";
import { BotRuntime } from "./BotRuntime.ts";
import {
  decode,
  newId,
  nowIso,
  readNotebook,
  readRole,
  runtimeModeFor,
  tokenPath,
} from "./operations.ts";
import { renderNotebook } from "./packet.ts";
import { describeSchedule, nextDueAt, parseSchedule } from "./routines.ts";
import type { FollowUp, ItemStatus } from "./store.ts";

export const MEMORY_BYTES = 4_096;
const SAY_CHARS = 20_000;
const READ_LIMIT = 20;
const READ_CHARS = 1_500;
const BOOLEAN_FLAGS = new Set(["all", "worktree"]);

const HELP = `t3bot <command> - everything you do goes through these.

  say <text> | say -             post to your chat with the user (- reads stdin)
  notebook                       print your goals, items, threads, routines, memory
  role                           print your role (only the user edits it)

  goal add <title> | goal edit <id> <title> | goal done <id>
  item add [--goal <id>] [--note <next step>] <title>
  item edit <id> [--title t] [--status open|waiting|done] [--note t] [--goal <id>]
  item done <id> [--note t]
  item list [--all]              --all includes done and set-aside items

  routine add --title <t> (--daily HH:MM [--weekdays 1-5] | --every <minutes>) <prompt>
  routine edit <id> [--title t] [--daily HH:MM [--weekdays ..] | --every <min>] [prompt]
  routine remove <id> | routine list

  memory add <text> | memory edit <id> <text> | memory remove <id>
                                 one fact per note, ${MEMORY_BYTES} bytes in all

  thread start --project <path|name|id> [--item <id>] [--follow now|attention|routine]
               [--worktree] [--provider <instance>] [--model <model>] [--title t] <prompt>
               starts a thread that works for you; it wakes you as --follow says:
               now = when it stops, attention (default) = when it fails or needs someone,
               routine = never, read it on your next routine
  thread send <thread> <text>    message a thread you own, unless the user took it over
  thread read <thread> [--limit n]
  thread list`;

interface Parsed {
  readonly positional: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string>;
}

function parseArgs(argv: ReadonlyArray<string>): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--") && arg.length > 2) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags.set(name, "true");
      else {
        flags.set(name, argv[index + 1] ?? "");
        index += 1;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

const fail = (message: string) =>
  new ForkHttpError({ status: 400, code: "tool_error", detail: message });

const idOf = (value: string | undefined, what: string) => {
  const id = Number(value?.replace(/^#/, ""));
  return Number.isInteger(id) && id > 0
    ? Effect.succeed(id)
    : Effect.fail(fail(`Give the ${what} id.`));
};

/** The words after the subcommand, or stdin for `-`. */
const textOf = (words: ReadonlyArray<string>, stdin: string) =>
  (words.length === 1 && words[0] === "-" ? stdin : words.join(" ")).trim();

const ToolRequest = Schema.Struct({
  bot: Schema.String,
  argv: Schema.Array(Schema.String),
  stdin: Schema.String,
});

/** Checks the caller's token against the bot it names. */
export const authenticateTool = Effect.fn("ForkBot.authenticateTool")(function* (
  authorization: string | undefined,
  input: unknown,
) {
  const runtime = yield* BotRuntime;
  const request = yield* decode(ToolRequest, input);
  const given = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const expected = yield* Effect.promise(() =>
    NodeFSP.readFile(tokenPath(runtime.botsDir, request.bot), "utf8").then(
      (value) => value.trim(),
      () => null,
    ),
  );
  const ok =
    expected !== null &&
    given.length === expected.length &&
    NodeCrypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok || runtime.existingStore()?.getBot(request.bot) == null) {
    return yield* new ForkHttpError({
      status: 401,
      code: "unauthorized",
      detail: "This bot's token was not accepted.",
    });
  }
  return request;
});

export const runTool = Effect.fn("ForkBot.runTool")(function* (input: {
  readonly bot: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin: string;
}) {
  const { positional, flags } = parseArgs(input.argv);
  const [command, sub, ...rest] = positional;
  const botId = input.bot;
  const runtime = yield* BotRuntime;
  const store = runtime.store();
  const at = nowIso();
  const touched = (output: string) => {
    runtime.publish(botId);
    return output;
  };

  switch (command) {
    case undefined:
    case "help":
      return HELP;
    case "say": {
      const text = textOf([sub ?? "", ...rest].filter(Boolean), input.stdin);
      if (text === "" || text.length > SAY_CHARS)
        return yield* fail(`Say 1 to ${SAY_CHARS} characters.`);
      store.addChat({ id: newId("msg"), botId, role: "bot", text, createdAt: at });
      store.markSaid(botId);
      return touched("Posted.");
    }
    case "notebook":
      return renderNotebook(yield* readNotebook(botId));
    case "role":
      return (yield* readRole(runtime.botsDir, botId)) || "(no role yet)";
    case "goal": {
      if (sub === "add") {
        const title = textOf(rest, input.stdin);
        if (title === "") return yield* fail("Give the goal a title.");
        return touched(`Goal ${store.addGoal(botId, title)} added.`);
      }
      const id = yield* idOf(rest[0], "goal");
      const changed =
        sub === "edit"
          ? store.updateGoal(botId, id, { title: textOf(rest.slice(1), input.stdin) })
          : sub === "done"
            ? store.updateGoal(botId, id, { done: true })
            : yield* fail("goal add | edit | done");
      return changed ? touched(`Goal ${id} updated.`) : yield* fail(`You have no goal ${id}.`);
    }
    case "item": {
      const goal = flags.get("goal");
      const goalId = goal === undefined ? undefined : yield* idOf(goal, "goal");
      if (
        goalId !== undefined &&
        !store.listGoals(botId).some((candidate) => candidate.id === goalId)
      ) {
        return yield* fail(`You have no goal ${goalId}.`);
      }
      if (sub === "add") {
        const title = textOf(rest, input.stdin);
        if (title === "") return yield* fail("Give the item a title.");
        const id = store.addItem(
          botId,
          { goalId: goalId ?? null, title, note: flags.get("note") ?? "" },
          at,
        );
        return touched(`Item #${id} added.`);
      }
      if (sub === "list") {
        const items = store
          .listItems(botId)
          .filter((item) => flags.has("all") || (item.status !== "done" && !item.setAside));
        return items.length === 0
          ? "(no items)"
          : items
              .map(
                (item) =>
                  `#${item.id} [${item.status}${item.setAside ? ", set aside" : ""}] ${item.title}${item.note ? ` - ${item.note}` : ""}`,
              )
              .join("\n");
      }
      const id = yield* idOf(rest[0], "item");
      const status = sub === "done" ? "done" : flags.get("status");
      if (status !== undefined && !["open", "waiting", "done"].includes(status)) {
        return yield* fail("--status is open, waiting or done.");
      }
      if (sub !== "edit" && sub !== "done") return yield* fail("item add | edit | done | list");
      const changed = store.updateItem(
        botId,
        id,
        {
          ...(flags.has("title") ? { title: flags.get("title")! } : {}),
          ...(status !== undefined ? { status: status as ItemStatus } : {}),
          ...(flags.has("note") ? { note: flags.get("note")! } : {}),
          ...(goalId !== undefined ? { goalId } : {}),
        },
        at,
      );
      return changed ? touched(`Item #${id} updated.`) : yield* fail(`You have no item #${id}.`);
    }
    case "routine":
      return yield* routineCommand(botId, sub, rest, flags, input.stdin);
    case "memory": {
      const total = (excludeId?: number) =>
        store
          .listMemory(botId)
          .filter((note) => note.id !== excludeId)
          .reduce((sum, note) => sum + Buffer.byteLength(note.text), 0);
      const check = (text: string, excludeId?: number) =>
        text === ""
          ? Effect.fail(fail("Write the note."))
          : total(excludeId) + Buffer.byteLength(text) > MEMORY_BYTES
            ? Effect.fail(
                fail(
                  `Memory would pass ${MEMORY_BYTES} bytes (now ${total()}). Merge or remove notes first.`,
                ),
              )
            : Effect.void;
      if (sub === "add") {
        const text = textOf(rest, input.stdin);
        yield* check(text);
        return touched(`Note ${store.addMemory(botId, text)} saved.`);
      }
      const id = yield* idOf(rest[0], "note");
      if (sub === "edit") {
        const text = textOf(rest.slice(1), input.stdin);
        yield* check(text, id);
        return store.editMemory(botId, id, text)
          ? touched(`Note ${id} rewritten.`)
          : yield* fail(`You have no note ${id}.`);
      }
      if (sub === "remove") {
        return store.removeMemory(botId, id)
          ? touched(`Note ${id} removed.`)
          : yield* fail(`You have no note ${id}.`);
      }
      return yield* fail("memory add | edit | remove");
    }
    case "thread":
      return yield* threadCommand(botId, sub, rest, flags, input.stdin);
    default:
      return yield* fail(`Unknown command "${command}". Run help.`);
  }
});

const routineCommand = Effect.fn("ForkBot.routineCommand")(function* (
  botId: string,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
  flags: ReadonlyMap<string, string>,
  stdin: string,
) {
  const runtime = yield* BotRuntime;
  const store = runtime.store();
  const now = new Date();
  if (sub === "list") {
    const routines = store.listRoutines(botId);
    return routines.length === 0
      ? "(no routines)"
      : routines
          .map(
            (routine) =>
              `${routine.id}: ${describeSchedule(routine.schedule)} "${routine.title}", next ${routine.nextDueAt ?? "never"} - ${routine.prompt}`,
          )
          .join("\n");
  }
  if (sub === "add") {
    const schedule = parseSchedule(flags);
    if (typeof schedule === "string") return yield* fail(schedule);
    const title = flags.get("title")?.trim() ?? "";
    const prompt = textOf(rest, stdin);
    if (title === "" || prompt === "") return yield* fail("Give --title and the prompt it runs.");
    const id = store.addRoutine(botId, {
      title,
      prompt,
      schedule,
      nextDueAt: nextDueAt(schedule, now)?.toISOString() ?? null,
    });
    runtime.publish(botId);
    return `Routine ${id} added: ${describeSchedule(schedule)}.`;
  }
  const id = yield* idOf(rest[0], "routine");
  if (sub === "remove") {
    if (!store.removeRoutine(botId, id)) return yield* fail(`You have no routine ${id}.`);
    runtime.publish(botId);
    return `Routine ${id} removed.`;
  }
  if (sub !== "edit") return yield* fail("routine add | edit | remove | list");
  const changesSchedule = flags.has("daily") || flags.has("every");
  const schedule = changesSchedule ? parseSchedule(flags) : undefined;
  if (typeof schedule === "string") return yield* fail(schedule);
  const prompt = textOf(rest.slice(1), stdin);
  const changed = store.updateRoutine(botId, id, {
    ...(flags.has("title") ? { title: flags.get("title")! } : {}),
    ...(prompt !== "" ? { prompt } : {}),
    ...(schedule !== undefined
      ? { schedule, nextDueAt: nextDueAt(schedule, now)?.toISOString() ?? null }
      : {}),
  });
  if (!changed) return yield* fail(`You have no routine ${id}.`);
  runtime.publish(botId);
  return `Routine ${id} updated.`;
});

/** A thread is the user's once they type in it; messages T3 writes with the user role do not count. */
const takenOverByUser = Effect.fn("ForkBot.takenOverByUser")(function* (
  projectId: string,
  threadId: string,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads
    .getProjectThreadRecords(
      { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId) },
      ["messages"],
      { messageRoles: ["user"] },
    )
    .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
  const latest = records.messages
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )
    .at(-1);
  return (
    latest !== undefined &&
    latest.createdBy === "user" &&
    latest.notification === undefined &&
    latest.delegatedCompletion === undefined &&
    latest.idleCompaction === undefined
  );
});

const threadCommand = Effect.fn("ForkBot.threadCommand")(function* (
  botId: string,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
  flags: ReadonlyMap<string, string>,
  stdin: string,
) {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = runtime.store();
  const bot = store.getBot(botId)!;

  if (sub === "list") {
    const notebook = yield* readNotebook(botId);
    return notebook.threads.length === 0
      ? "(no threads)"
      : notebook.threads
          .map(
            (thread) =>
              `${thread.threadId} "${thread.title ?? "untitled"}"${thread.itemId === null ? "" : ` for #${thread.itemId}`} (follow ${thread.follow})`,
          )
          .join("\n");
  }

  if (sub === "start") {
    const prompt = textOf(rest, stdin);
    if (prompt === "") return yield* fail("Give the thread its task.");
    const follow = (flags.get("follow") ?? "attention") as FollowUp;
    if (!["now", "attention", "routine"].includes(follow)) {
      return yield* fail("--follow is now, attention or routine.");
    }
    const item = flags.get("item");
    const itemId = item === undefined ? null : yield* idOf(item, "item");
    if (itemId !== null && !store.listItems(botId).some((candidate) => candidate.id === itemId)) {
      return yield* fail(`You have no item #${itemId}.`);
    }
    const wanted = flags.get("project")?.trim() ?? "";
    if (wanted === "") return yield* fail("Name the project with --project.");
    const projects = (yield* (yield* Project.ProjectService)
      .listShells()
      .pipe(Effect.orElseSucceed(() => []))).filter((shell) => !shell.archivedAt);
    const project = projects.find(
      (shell) =>
        shell.id === wanted ||
        shell.workspaceRoot === wanted ||
        shell.title.toLowerCase() === wanted.toLowerCase(),
    );
    if (project === undefined) {
      return yield* fail(
        `No project "${wanted}". Projects: ${projects.map((shell) => `${shell.title} (${shell.workspaceRoot})`).join(", ")}`,
      );
    }
    const modelSelection = {
      instanceId: flags.get("provider") ?? bot.modelSelection.instanceId,
      model: flags.get("model") ?? (flags.has("provider") ? "" : bot.modelSelection.model),
    } as ModelSelection;
    if (modelSelection.model === "") return yield* fail("With --provider, give --model too.");
    const commandId = CommandId.make(newId("fork-bot"));
    const launched = yield* ThreadMessageIntake.launchThread({
      commandId,
      threadId: ThreadId.make(commandId),
      projectId: ProjectId.make(project.id),
      title: flags.get("title") ?? prompt.split("\n", 1)[0]!.slice(0, 80),
      modelSelection,
      runtimeMode: yield* runtimeModeFor(modelSelection),
      interactionMode: "default",
      workspaceStrategy: flags.has("worktree")
        ? { type: "worktree", baseRef: "HEAD" }
        : { type: "root" },
      initialMessage: {
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        text: prompt,
        attachments: [],
      },
      createdBy: "system",
      creationSource: "server",
    }).pipe(Effect.mapError((cause) => fail(`The thread did not start: ${cause.message}`)));
    store.addThread({
      threadId: launched.threadId,
      botId,
      projectId: project.id,
      itemId,
      follow,
      createdAt: nowIso(),
    });
    runtime.ownedThreads.set(launched.threadId, botId);
    if (itemId !== null) store.updateItem(botId, itemId, {}, nowIso());
    runtime.publish(botId);
    return `Thread ${launched.threadId} started in ${project.title}. It will wake you ${
      follow === "now"
        ? "when it stops"
        : follow === "attention"
          ? "if it fails or needs someone"
          : "never; read it on a routine"
    }. End your turn now.`;
  }

  const threadId = rest[0];
  if (threadId === undefined) return yield* fail("Name the thread.");

  if (sub === "send") {
    const owned = store.listThreads(botId).find((thread) => thread.threadId === threadId);
    if (owned === undefined) return yield* fail("You can only message threads you started.");
    if (yield* takenOverByUser(owned.projectId, threadId)) {
      return yield* fail("The user took this thread over; leave it to them.");
    }
    const text = textOf(rest.slice(1), stdin);
    if (text === "") return yield* fail("Write the message.");
    const sent = yield* threads
      .sendToThread({
        projectId: ProjectId.make(owned.projectId),
        commandId: CommandId.make(newId("fork-bot")),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        text,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError((cause) => fail(`Not sent: ${cause.message}`)));
    return `Sent (${sent.delivery}).`;
  }

  if (sub === "read") {
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return yield* fail(`No thread ${threadId}.`);
    const limit = Math.min(Number(flags.get("limit") ?? READ_LIMIT) || READ_LIMIT, 100);
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: shell.projectId, threadId: ThreadId.make(threadId) },
        ["messages", "runs"],
        { messageRoles: ["user", "assistant"] },
      )
      .pipe(Effect.mapError((cause) => fail(`Cannot read it: ${cause.message}`)));
    const latestRun = records.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
    const messages = records.messages
      .filter((message) => message.text.trim() !== "")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )
      .slice(-limit);
    return [
      `"${shell.title}" - latest run ${latestRun?.status ?? "none"}`,
      ...messages.map(
        (message) =>
          `[${message.role}${message.role === "user" && message.createdBy !== "user" ? ` (${message.createdBy})` : ""}] ${
            message.text.length > READ_CHARS
              ? `${message.text.slice(0, READ_CHARS)}… (cut)`
              : message.text
          }`,
      ),
    ].join("\n\n");
  }

  return yield* fail("thread start | send | read | list");
});
