// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Compares tool tokens in constant time; times are ISO text.
/**
 * What `t3bot` does. The CLI sends its arguments as they are; parsing, checks, and effects all
 * happen here, so every action a bot takes passes the same place.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../../project/ProjectService.ts";
import { ForkHttpError } from "../inbox/operations.ts";
import { BotRuntime } from "./BotRuntime.ts";
import {
  describeReply,
  listConversations,
  readMessages,
  READ_LIMIT as CHAT_READ_LIMIT,
  resolveConversation,
  sendAsUser,
  signed,
  userWroteSince,
} from "./chat.ts";
import { decide, QUESTION_TTL_MS } from "./gate.ts";
import {
  configuredChannels,
  decode,
  isTerminalRunStatus,
  newId,
  notify,
  nowIso,
  readNotebook,
  readRole,
  rolePath,
  runtimeModeFor,
  tokenPath,
  ROLE_CHARS,
} from "./operations.ts";
import { renderNotebook } from "./packet.ts";
import { describeSchedule, nextDueAt, parseSchedule } from "./routines.ts";
import { channelSettings, type FollowUp, type ItemStatus, type Permission } from "./store.ts";

export const MEMORY_BYTES = 4_096;
const SAY_CHARS = 20_000;
const READ_LIMIT = 20;
const READ_CHARS = 1_500;

interface FlagSpec {
  readonly values?: ReadonlyArray<string>;
  readonly booleans?: ReadonlyArray<string>;
}

const ROUTINE_FLAGS: FlagSpec = { values: ["title", "daily", "weekdays", "every"] };
/**
 * The flags each command takes. Any other `--word` is text, so a message that mentions
 * `--dry-run` reaches its thread whole; commands without an entry take only text.
 */
const FLAGS: Readonly<Record<string, FlagSpec>> = {
  "item add": { values: ["note"] },
  "item edit": { values: ["title", "status", "note"] },
  "item done": { values: ["note"] },
  "item list": { booleans: ["all"] },
  "routine add": ROUTINE_FLAGS,
  "routine edit": ROUTINE_FLAGS,
  "thread start": {
    values: ["project", "item", "follow", "provider", "model", "title"],
    booleans: ["worktree"],
  },
  "thread read": { values: ["limit"] },
  "chat list": { values: ["query"] },
  "chat read": { values: ["limit", "before", "root"] },
  "chat send": { values: ["reply-to"] },
};

const CHAT_HELP = `
  chat unread                    conversations with unread messages or mentions of the user
  chat list [--query <name>]     recent conversations; each line starts with its <channel>/<id>
  chat read <conversation> [--limit n] [--before <cursor>] [--root <message>]
                                 newest messages, oldest first; --root reads one reply thread
  chat send <conversation> [--reply-to <message>] <text> | -
                                 sends as the user, in that message's thread with --reply-to;
                                 @Name of someone in the conversation notifies them
                                 <conversation> is <channel>/<id>, an id, or an exact name
`;

const HELP = `t3bot <command> - everything you do goes through these.

  say <text> | say -             post to your chat with the user (- reads stdin)
  notebook                       print your items, threads, routines, memory
  role                           print your role: who you are, what you own, your rules
  role edit -                    replace your role with stdin; the user may have to approve

  item add [--note <next step>] <title>
  item edit <id> [--title t] [--status open|waiting|done] [--note t]
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
  thread list
{chat}
Flags take --name value or --name=value. Text that itself starts with -- goes after a bare --.

Some actions need the user's approval. Then the command does not run: it becomes a question in
your chat, and approving it runs exactly that command. You hear the answer on a later turn.`;

interface Parsed {
  readonly positional: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string>;
}

export function parseArgs(argv: ReadonlyArray<string>): Parsed {
  const spec = FLAGS[`${argv[0]} ${argv[1]}`] ?? {};
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const match = /^--([a-z][a-z-]*)(?:=([\s\S]*))?$/.exec(arg);
    const name = match?.[1];
    const inline = match?.[2];
    if (name !== undefined && spec.booleans?.includes(name) && inline === undefined) {
      flags.set(name, "true");
    } else if (name !== undefined && spec.values?.includes(name)) {
      if (inline !== undefined) flags.set(name, inline);
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
  // Only a stored bot's id becomes a path, so the request cannot point the read elsewhere.
  const known = runtime.existingStore()?.getBot(request.bot) != null;
  const expected = known
    ? yield* Effect.promise(() =>
        NodeFSP.readFile(tokenPath(runtime.botsDir, request.bot), "utf8").then(
          (value) => value.trim(),
          () => null,
        ),
      )
    : null;
  const ok =
    expected !== null &&
    given.length === expected.length &&
    NodeCrypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    return yield* new ForkHttpError({
      status: 401,
      code: "unauthorized",
      detail: "This bot's token was not accepted.",
    });
  }
  return request;
});

export interface ToolCall {
  readonly bot: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin: string;
  /** The user approved exactly this call: it runs without asking again. */
  readonly approved?: boolean;
  /** When the approved question was asked. */
  readonly askedAt?: string;
}

/**
 * Null when the call may run now. Otherwise it is refused, or stored as a question whose answer
 * runs this exact call, and the bot is told so.
 */
const gate = Effect.fn("ForkBot.gate")(function* (
  call: ToolCall,
  permission: Permission,
  overBudget: boolean,
  what: string,
  detail: string,
) {
  if (call.approved === true) return null;
  const runtime = yield* BotRuntime;
  const store = runtime.store();
  if (decide({ permission, overBudget }) === "allow") return null;
  const now = Date.now();
  const id = store.addQuestion({
    botId: call.bot,
    text: detail === "" ? what : `${what}\n\n${detail}`,
    argv: call.argv,
    stdin: call.stdin,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUESTION_TTL_MS).toISOString(),
  });
  runtime.publish(call.bot);
  return `Not done yet: the user must approve this (question ${id}). Approving runs exactly this command; you hear the answer on a later turn, and the question lapses after 24 hours. Say why you need it in your reply, then end your turn.`;
});

export const runTool = Effect.fn("ForkBot.runTool")(function* (input: ToolCall) {
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
    case "help": {
      const bot = store.getBot(botId)!;
      const chat = bot.settings.channelsEnabled && (yield* configuredChannels()).length > 0;
      return HELP.replace("{chat}", chat ? CHAT_HELP : "");
    }
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
    case "role": {
      if (sub === undefined) return (yield* readRole(runtime.botsDir, botId)) || "(no role yet)";
      if (sub !== "edit") return yield* fail("role | role edit -");
      const role = textOf(rest, input.stdin);
      if (role === "" || role.length > ROLE_CHARS) {
        return yield* fail(`Give the whole role on stdin, under ${ROLE_CHARS} characters.`);
      }
      // Its role is the user's word on what it does, so changing it always asks.
      const asked = yield* gate(input, "ask", false, "replace its role", role);
      if (asked !== null) return asked;
      yield* Effect.promise(() => NodeFSP.writeFile(rolePath(runtime.botsDir, botId), role));
      return touched("Role replaced.");
    }
    case "item": {
      if (sub === "add") {
        const title = textOf(rest, input.stdin);
        if (title === "") return yield* fail("Give the item a title.");
        const id = store.addItem(botId, { title, note: flags.get("note") ?? "" }, at);
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
      return yield* threadCommand(input, sub, rest, flags);
    case "chat":
      return yield* chatCommand(input, sub, rest, flags);
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

/**
 * A thread is the user's once they type in it after the bot last had it; messages T3 writes with
 * the user role do not count.
 */
export const takenOverByUser = Effect.fn("ForkBot.takenOverByUser")(function* (
  projectId: string,
  threadId: string,
  handedBackAt: string | null,
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
    (handedBackAt === null ||
      DateTime.toEpochMillis(latest.createdAt) > Date.parse(handedBackAt)) &&
    latest.createdBy === "user" &&
    latest.notification === undefined &&
    latest.delegatedCompletion === undefined &&
    latest.idleCompaction === undefined
  );
});

/** Launches a thread the bot starts, under the id it already owns. */
const launchOwned = Effect.fn("ForkBot.launchOwned")(function* (
  commandId: CommandId,
  threadId: ThreadId,
  projectId: string,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  prompt: string,
  flags: ReadonlyMap<string, string>,
) {
  return yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId,
    projectId: ProjectId.make(projectId),
    title: flags.get("title") ?? prompt.split("\n", 1)[0]!.slice(0, 80),
    modelSelection,
    runtimeMode: yield* runtimeModeFor(modelSelection, runtimeMode),
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
});

const threadCommand = Effect.fn("ForkBot.threadCommand")(function* (
  call: ToolCall,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
  flags: ReadonlyMap<string, string>,
) {
  const botId = call.bot;
  const stdin = call.stdin;
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
    const picked = {
      instanceId: flags.get("provider") ?? bot.modelSelection.instanceId,
      model: flags.get("model") ?? (flags.has("provider") ? "" : bot.modelSelection.model),
    } as ModelSelection;
    if (picked.model === "") return yield* fail("With --provider, give --model too.");
    // Its own model keeps its options, effort among them; another starts at that model's defaults.
    const modelSelection =
      picked.instanceId === bot.modelSelection.instanceId &&
      picked.model === bot.modelSelection.model
        ? bot.modelSelection
        : picked;
    // One start at a time, so two starts in one turn cannot both fit under the limit.
    return yield* runtime.threadStartLock.withPermit(
      Effect.gen(function* () {
        const running = store
          .listThreads(botId)
          .filter((thread) => !thread.takenOver && !isTerminalRunStatus(thread.status)).length;
        const overBudget = running >= bot.settings.maxThreads;
        const asked = yield* gate(
          call,
          bot.settings.threads,
          overBudget,
          `start a thread in ${project.title}${overBudget ? ` (${running} of its ${bot.settings.maxThreads} threads already run)` : ""}`,
          prompt,
        );
        if (asked !== null) return asked;
        const commandId = CommandId.make(newId("fork-bot"));
        const threadId = ThreadId.make(commandId);
        // Owned before it launches: a run that ends at once is still reported.
        store.addThread({
          threadId,
          botId,
          projectId: project.id,
          itemId,
          follow,
          createdAt: nowIso(),
        });
        runtime.ownedThreads.set(threadId, botId);
        yield* launchOwned(
          commandId,
          threadId,
          project.id,
          modelSelection,
          bot.settings.runtimeMode,
          prompt,
          flags,
        ).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              store.removeThread(threadId);
              runtime.ownedThreads.delete(threadId);
            }),
          ),
        );
        if (itemId !== null) store.updateItem(botId, itemId, {}, nowIso());
        runtime.publish(botId);
        return `Thread ${threadId} started in ${project.title}. It will wake you ${
          follow === "now"
            ? "when it stops"
            : follow === "attention"
              ? "if it fails or needs someone"
              : "never; read it on a routine"
        }. End your turn now.`;
      }),
    );
  }

  const threadId = rest[0];
  if (threadId === undefined) return yield* fail("Name the thread.");

  if (sub === "send") {
    const owned = store.listThreads(botId).find((thread) => thread.threadId === threadId);
    if (owned === undefined) return yield* fail("You can only message threads you started.");
    if (
      owned.takenOver ||
      (yield* takenOverByUser(owned.projectId, threadId, owned.handedBackAt))
    ) {
      return yield* fail(
        "The user took this thread over; leave it to them until they hand it back.",
      );
    }
    const text = textOf(rest.slice(1), stdin);
    if (text === "") return yield* fail("Write the message.");
    const title = (yield* readNotebook(botId)).threads.find(
      (thread) => thread.threadId === threadId,
    )?.title;
    const asked = yield* gate(
      call,
      bot.settings.threads,
      false,
      `message its thread "${title ?? threadId}"`,
      text,
    );
    if (asked !== null) return asked;
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
    // Another bot's work thread is its private workspace, not something in scope.
    const workOf = runtime.workThreads.get(threadId);
    if (workOf !== undefined && workOf !== botId) return yield* fail(`No thread ${threadId}.`);
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

const chatCommand = Effect.fn("ForkBot.chatCommand")(function* (
  call: ToolCall,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
  flags: ReadonlyMap<string, string>,
) {
  const bot = (yield* BotRuntime).store().getBot(call.bot)!;
  if ((yield* configuredChannels()).length === 0) {
    return yield* fail("No chat channel is set up here.");
  }
  if (!bot.settings.channelsEnabled) {
    return yield* fail("Your chat channels are off; the user can turn them on in your settings.");
  }
  if (sub === "unread") return yield* listConversations({ unreadOnly: true });
  if (sub === "list") {
    return yield* listConversations({
      query: flags.get("query") ?? rest.join(" "),
      unreadOnly: false,
    });
  }
  if (sub === "read") {
    const target = yield* resolveConversation(rest[0]);
    const limit = Math.min(
      Math.max(Number(flags.get("limit") ?? CHAT_READ_LIMIT) || CHAT_READ_LIMIT, 1),
      100,
    );
    const before = flags.get("before");
    const root = flags.get("root");
    return yield* readMessages(target, {
      limit,
      ...(before === undefined ? {} : { before }),
      ...(root === undefined ? {} : { root }),
    });
  }
  if (sub !== "send") return yield* fail("chat unread | list | read | send");
  const target = yield* resolveConversation(rest[0]);
  const text = textOf(rest.slice(1), call.stdin);
  if (text === "" || text.length > SAY_CHARS) {
    return yield* fail(`Write 1 to ${SAY_CHARS} characters.`);
  }
  const replyToId = flags.get("reply-to");
  const outgoing = signed(bot, text);
  const asked = yield* gate(
    call,
    channelSettings(bot.settings, target.channel.id).send,
    false,
    `send as you to "${target.name}"${
      replyToId === undefined ? "" : `, replying to ${yield* describeReply(target, replyToId)}`
    }`,
    outgoing,
  );
  if (asked !== null) return asked;
  if (call.askedAt !== undefined && (yield* userWroteSince(target, call.askedAt))) {
    return yield* fail(
      `Not sent: the user wrote in "${target.name}" after you drafted this. Read it again and draft anew if it still needs saying. Your draft: ${text}`,
    );
  }
  const sent = yield* sendAsUser({
    botId: bot.id,
    target,
    text: outgoing,
    ...(replyToId === undefined ? {} : { replyToId }),
  });
  return [
    `Sent as the user to "${target.name}" (message ${sent.messageId}).`,
    ...(sent.unresolvedMentions.length > 0
      ? [`Not notified (mention went out as plain text): ${sent.unresolvedMentions.join(", ")}.`]
      : []),
  ].join(" ");
});

const AnswerInput = Schema.Struct({
  botId: Schema.String,
  questionId: Schema.Number,
  approve: Schema.Boolean,
});

/**
 * The user's answer to a question. Approving claims it once and runs the stored call, whose own
 * checks (ownership, takeover) run again; the bot hears the outcome on its next turn.
 */
export const answerQuestion = Effect.fn("ForkBot.answerQuestion")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(AnswerInput, input);
  const store = runtime.existingStore();
  const question =
    store?.answerQuestion(
      decoded.botId,
      decoded.questionId,
      decoded.approve ? "approved" : "declined",
      nowIso(),
    ) ?? null;
  if (question === null) {
    return yield* new ForkHttpError({
      status: 409,
      code: "question_closed",
      detail: "That question was already answered or has lapsed.",
    });
  }
  if (!decoded.approve) {
    yield* notify(
      question.botId,
      `The user declined your question ${question.id}; it did not run.`,
      true,
    );
    return {};
  }
  const outcome = yield* runTool({
    bot: question.botId,
    argv: question.argv,
    stdin: question.stdin,
    approved: true,
    askedAt: question.createdAt,
  }).pipe(
    Effect.map((output) => ({ ok: true, output })),
    Effect.catchTags({
      ForkHttpError: (error) => Effect.succeed({ ok: false, output: error.detail }),
    }),
  );
  store!.setQuestionResult(question.id, outcome.output);
  yield* notify(
    question.botId,
    outcome.ok
      ? `The user approved your question ${question.id}, and it ran: ${outcome.output}`
      : `The user approved your question ${question.id}, but it failed: ${outcome.output}`,
    true,
  );
  return { ok: outcome.ok, output: outcome.output };
});
