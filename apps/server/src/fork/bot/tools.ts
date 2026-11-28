// @effect-diagnostics nodeBuiltinImport:off - Compares tool tokens in constant time; times are ISO text.
/**
 * What `t3bot` does. The CLI sends its arguments as they are; parsing, checks, and effects all
 * happen here, so every action a bot takes passes the same place.
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../../project/ProjectService.ts";
import { describeInboxError } from "../inbox/operations.ts";
import { BotOperationError, BotRejection, describeBotError } from "./errors.ts";
import { BotRuntime } from "./BotRuntime.ts";
import { enabledFor, helpFor, listInstances, RESERVED_COMMANDS } from "./connectors/registry.ts";
import { textOf, toolError, type FlagSpec } from "./connectors/types.ts";
import { decide, QUESTION_TTL_MS } from "./gate.ts";
import {
  decode,
  isTerminalRunStatus,
  newId,
  nowIso,
  modelFlags,
  ROLE_CHARS,
  appendRule,
  type BotCore,
} from "./operations.ts";
import { renderNotebook } from "./packet.ts";
import { describeSchedule, nextDueAt, parseSchedule } from "./routines.ts";
import { connectorSettings, type FollowUp, type ItemStatus, type Permission } from "./store.ts";

export const MEMORY_BYTES = 4_096;
const SAY_CHARS = 20_000;
const READ_LIMIT = 20;
const READ_CHARS = 1_500;

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
  "thread send": { booleans: ["fresh"] },
  "thread read": { values: ["limit"] },
};

export const HELP = `t3bot <command> - everything you do goes through these.

  say <text> | say -             post to your chat with the user (- reads stdin)
  notebook                       print your items, threads, routines, memory
  role                           print your role: who you are, what you own, your rules
  role add <rule>                add one rule the user gave you to the end of your role
  role edit -                    replace your whole role with stdin
                                 both wait for the user's approval

  item add [--note <next step>] <title>
  item edit <id> [--title t] [--status open|waiting|done] [--note t]
  item done <id> [--note t]
  item list [--all]              --all includes done and set-aside items

  routine add --title <t> (--daily HH:MM [--weekdays 1-5] | --every <minutes>) <prompt>
  routine edit <id> [--title t] [--daily HH:MM [--weekdays ..] | --every <min>] [prompt]
  routine remove <id> | routine list

  memory add <text> | memory edit <id> <text> | memory remove <id>
                                 one fact you found per note, ${MEMORY_BYTES} bytes in all;
                                 how you should act is a rule for your role, not memory

  thread start --project <path|name|id> [--item <id>] [--follow now|attention|routine]
               [--worktree] [--provider <instance>] [--model <model>] [--title t] <prompt>
               runs on {threadModel} unless you pass --provider and --model
               starts a thread that works for you; it wakes you as --follow says:
               now = when it stops, attention (default) = when it fails or needs someone,
               routine = never, read it on your next routine
  thread send [--fresh] <thread> <text>
                                 message a thread you own, unless the user took it over;
               --fresh starts it on a clean context, keeping its folder, branch and history
               in T3, so the text must stand on its own: the goal, what is done, the branch
               and files that matter, and the next step. It can read its earlier work with
               t3_thread_read on its own thread when its tools have it.
  thread read <thread> [--limit n]
                                 its messages, and how full its context is
  thread list
{connectors}
Flags take --name value or --name=value. Text that itself starts with -- goes after a bare --.

Some actions need the user's approval. Then the command does not run: it becomes a question in
your chat, and approving it runs exactly that command. You hear the answer on a later turn.`;

interface Parsed {
  readonly positional: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string>;
}

/** `spec` defaults to the core command's; a connector passes its operation's. */
export function parseArgs(
  argv: ReadonlyArray<string>,
  spec: FlagSpec = FLAGS[`${argv[0]} ${argv[1]}`] ?? {},
): Parsed {
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

const fail = toolError;

const idOf = (value: string | undefined, what: string) => {
  const id = Number(value?.replace(/^#/, ""));
  return Number.isInteger(id) && id > 0
    ? Effect.succeed(id)
    : Effect.fail(fail(`Give the ${what} id.`));
};

const ToolRequest = Schema.Struct({
  bot: Schema.String,
  argv: Schema.Array(Schema.String),
  stdin: Schema.String,
});

/** Checks the caller's token against the bot it names. */
const authenticateTool = Effect.fn("ForkBot.authenticateTool")(function* (
  authorization: string | undefined,
  input: unknown,
) {
  const runtime = yield* BotRuntime;
  const request = yield* decode(ToolRequest, input);
  const given = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  // Only a stored bot's id becomes a path, so the request cannot point the read elsewhere.
  const known = (yield* runtime.existingStore()?.getBot(request.bot) ?? Effect.undefined) != null;
  const expected = known ? yield* runtime.files.readToken(runtime.botsDir, request.bot) : null;
  const ok =
    expected !== null &&
    given.length === expected.length &&
    NodeCrypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    return yield* new BotRejection({
      code: "unauthorized",
      message: "This bot's token was not accepted.",
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
/** What a new role adds and drops, so approving it does not mean rereading the whole role. */
function roleChanges(before: string, after: string): string {
  const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
  const was = new Set(lines(before));
  const now = new Set(lines(after));
  const added = lines(after).filter((line) => !was.has(line));
  const removed = lines(before).filter((line) => !now.has(line));
  if (before.trim() === "") return after;
  return [
    ...(added.length > 0 ? ["Adds:", ...added] : []),
    ...(removed.length > 0 ? [...(added.length > 0 ? [""] : []), "Removes:", ...removed] : []),
  ].join("\n");
}

const gate = Effect.fn("ForkBot.gate")(function* (
  call: ToolCall,
  permission: Permission,
  overBudget: boolean,
  what: string,
  detail: string,
) {
  if (call.approved === true) return null;
  const runtime = yield* BotRuntime;
  const store = yield* runtime.store;
  if (decide({ permission, overBudget }) === "allow") return null;
  const now = yield* Clock.currentTimeMillis;
  const id = yield* store.addQuestion({
    botId: call.bot,
    text: detail === "" ? what : `${what}\n\n${detail}`,
    argv: call.argv,
    stdin: call.stdin,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + QUESTION_TTL_MS)),
  });
  runtime.publish(call.bot);
  return `Not done yet: the user must approve this (question ${id}). Approving runs exactly this command; you hear the answer on a later turn, and the question lapses after 24 hours. Say why you need it in your reply, then end your turn.`;
});

const routineCommand = Effect.fn("ForkBot.routineCommand")(function* (
  botId: string,
  sub: string | undefined,
  rest: ReadonlyArray<string>,
  flags: ReadonlyMap<string, string>,
  stdin: string,
) {
  const runtime = yield* BotRuntime;
  const store = yield* runtime.store;
  const now = yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal);
  if (sub === "list") {
    const routines = yield* store.listRoutines(botId);
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
    const id = yield* store.addRoutine(botId, {
      title,
      prompt,
      schedule,
      nextDueAt: nextDueAt(schedule, now)?.pipe(DateTime.formatIso) ?? null,
    });
    runtime.publish(botId);
    return `Routine ${id} added: ${describeSchedule(schedule)}.`;
  }
  const id = yield* idOf(rest[0], "routine");
  if (sub === "remove") {
    if (!(yield* store.removeRoutine(botId, id))) return yield* fail(`You have no routine ${id}.`);
    runtime.publish(botId);
    return `Routine ${id} removed.`;
  }
  if (sub !== "edit") return yield* fail("routine add | edit | remove | list");
  const changesSchedule = flags.has("daily") || flags.has("every");
  const schedule = changesSchedule ? parseSchedule(flags) : undefined;
  if (typeof schedule === "string") return yield* fail(schedule);
  const prompt = textOf(rest.slice(1), stdin);
  const changed = yield* store.updateRoutine(botId, id, {
    ...(flags.has("title") ? { title: flags.get("title")! } : {}),
    ...(prompt !== "" ? { prompt } : {}),
    ...(schedule !== undefined
      ? { schedule, nextDueAt: nextDueAt(schedule, now)?.pipe(DateTime.formatIso) ?? null }
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
const takenOverByUser = Effect.fn("ForkBot.takenOverByUser")(function* (
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

/** Share of a thread's context past which the bot is told to send with `--fresh`. */
const FRESH_AT = 0.7;

/**
 * How full a thread's current provider session is, from its latest reported usage; null when
 * its provider reports none. A fresh send starts a new session, which starts from empty.
 */
function contextFill(
  records: Pick<OrchestrationV2ThreadProjection, "thread" | "providerTurns">,
): { readonly used: number; readonly max: number } | null {
  const usage = records.providerTurns
    .filter(
      (turn) =>
        turn.providerThreadId === records.thread.activeProviderThreadId &&
        turn.tokenUsage !== undefined,
    )
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const max = usage?.autoCompactThreshold ?? usage?.maxTokens;
  return usage === undefined || !max ? null : { used: usage.usedTokens, max };
}

const contextLine = (fill: ReturnType<typeof contextFill>) => {
  if (fill === null) return "Its provider does not report context size.";
  const share = fill.used / fill.max;
  const line = `Context ${Math.round(fill.used / 1000)}k of ${Math.round(fill.max / 1000)}k tokens (${Math.round(share * 100)}%).`;
  return share < FRESH_AT
    ? line
    : `${line} Give it more work with \`thread send --fresh\`, so it does not compact.`;
};

const threadContext = Effect.fn("ForkBot.threadContext")(function* (
  projectId: string,
  threadId: string,
) {
  const records = yield* (yield* ThreadManagement.ThreadManagementService)
    .getProjectThreadRecords(
      { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId) },
      ["providerTurns"],
    )
    .pipe(Effect.orElseSucceed(() => null));
  return records === null ? null : contextFill(records);
});

/** Earlier builds had one `chat` command for every channel; each channel is its own now. */
const chatMoved = Effect.fn("ForkBot.chatMoved")(function* (botId: string) {
  const bot = (yield* (yield* (yield* BotRuntime).store).getBot(botId))!;
  const chats = (yield* enabledFor(bot)).filter((entry) => entry.instance.kind === "chat");
  return yield* fail(
    chats.length === 0
      ? "No chat channel is on for you; the user can turn one on in your settings."
      : `Each chat channel is its own command now: ${chats.map((entry) => `\`${entry.instance.id} …\` for ${entry.instance.name}`).join(", ")}. Run help, and fix any skill or note that says \`chat\`.`,
  );
});

/**
 * `<instance> <operation> …`: the connector resolves the call, and every write it resolves to
 * passes the gate here, so no connector can write without the user's say.
 */
const connectorCommand = Effect.fn("ForkBot.connectorCommand")(function* (call: ToolCall) {
  const [command, operation] = call.argv;
  const bot = (yield* (yield* (yield* BotRuntime).store).getBot(call.bot))!;
  const entry = (yield* listInstances()).find(
    (candidate) => candidate.callable && candidate.instance.id === command,
  );
  if (entry === undefined) return yield* fail(`Unknown command "${command}". Run help.`);
  const { connector, instance } = entry;
  const settings = connectorSettings(bot.settings, instance.id);
  if (!settings.enabled) {
    return yield* fail(
      `${instance.name} is off for you; the user can turn it on in your settings.`,
    );
  }
  if (instance.status === "down") {
    return yield* fail(`${instance.name} cannot be used now: ${instance.reason ?? "it is down"}.`);
  }
  const { positional, flags } = parseArgs(
    call.argv,
    operation === undefined ? {} : (connector.flags[operation] ?? {}),
  );
  const action = yield* connector.resolve({
    bot,
    instance,
    settings,
    operation: positional[1],
    args: positional.slice(2),
    flags,
    stdin: call.stdin,
  });
  if (action.effect === "read") return yield* action.run;
  const asked = yield* gate(
    call,
    settings.permissions[action.operation] ?? "ask",
    false,
    `${instance.name}: ${action.what}`,
    action.detail,
  );
  if (asked !== null) return asked;
  return yield* action.run(call.askedAt === undefined ? {} : { askedAt: call.askedAt });
});

const AnswerInput = Schema.Struct({
  botId: Schema.String,
  questionId: Schema.Number,
  approve: Schema.Boolean,
});

export const makeToolOperations = ({
  notify,
  readNotebook,
  runtimeModeFor,
  threadModelFor,
  withShown,
}: Pick<
  BotCore,
  "notify" | "readNotebook" | "runtimeModeFor" | "threadModelFor" | "withShown"
>) => {
  const runTool = Effect.fn("ForkBot.runTool")(function* (input: ToolCall) {
    if (input.argv[0] !== undefined && !RESERVED_COMMANDS.has(input.argv[0])) {
      return yield* connectorCommand(input);
    }
    const { positional, flags } = parseArgs(input.argv);
    const [command, sub, ...rest] = positional;
    const botId = input.bot;
    const runtime = yield* BotRuntime;
    const store = yield* runtime.store;
    const at = yield* nowIso;
    const touched = (output: string) => {
      runtime.publish(botId);
      return output;
    };

    switch (command) {
      case undefined:
      case "help": {
        const bot = (yield* store.getBot(botId))!;
        return HELP.replace("{connectors}", yield* helpFor(bot)).replace(
          "{threadModel}",
          modelFlags(yield* threadModelFor(bot)),
        );
      }
      case "say": {
        const text = textOf([sub ?? "", ...rest].filter(Boolean), input.stdin);
        if (text === "" || text.length > SAY_CHARS)
          return yield* fail(`Say 1 to ${SAY_CHARS} characters.`);
        const said = { id: newId("msg"), botId, role: "bot" as const, text, createdAt: at };
        const bot = yield* store.getBot(botId);
        const turn = yield* store.getTurn(botId);
        const posts = bot === null || turn === null ? [said] : yield* withShown(bot, turn, said);
        for (const post of posts) yield* store.addChat(post);
        yield* store.markSaid(botId);
        return touched("Posted.");
      }
      case "notebook":
        return renderNotebook(yield* readNotebook(botId));
      case "role": {
        const current = yield* runtime.files.readRole(runtime.botsDir, botId);
        if (sub === undefined) return current || "(no role yet)";
        if (sub !== "edit" && sub !== "add")
          return yield* fail("role | role add <rule> | role edit -");
        const text = textOf(rest, input.stdin);
        const role = sub === "add" ? appendRule(current, text) : text;
        if (text === "" || role.length > ROLE_CHARS) {
          return yield* fail(
            sub === "add"
              ? `Give the rule, keeping the role under ${ROLE_CHARS} characters.`
              : `Give the whole role on stdin, under ${ROLE_CHARS} characters.`,
          );
        }
        if (role.trim() === current.trim()) return "Role unchanged.";
        // Its role is the user's word on what it does, so changing it always asks.
        const asked = yield* gate(
          input,
          "ask",
          false,
          sub === "add" ? "add to its role" : "change its role",
          sub === "add" ? text : roleChanges(current, role),
        );
        if (asked !== null) return asked;
        yield* runtime.files.writeRole(runtime.botsDir, botId, role);
        return touched(sub === "add" ? "Rule added to your role." : "Role replaced.");
      }
      case "item": {
        if (sub === "add") {
          const title = textOf(rest, input.stdin);
          if (title === "") return yield* fail("Give the item a title.");
          const id = yield* store.addItem(botId, { title, note: flags.get("note") ?? "" }, at);
          return touched(`Item #${id} added.`);
        }
        if (sub === "list") {
          const items = (yield* store.listItems(botId)).filter(
            (item) => flags.has("all") || (item.status !== "done" && !item.setAside),
          );
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
        const changed = yield* store.updateItem(
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
        const check = Effect.fn("ForkBot.checkMemory")(function* (
          text: string,
          excludeId?: number,
        ) {
          if (text === "") return yield* fail("Write the note.");
          const notes = yield* store.listMemory(botId);
          const total = (except?: number) =>
            notes
              .filter((note) => note.id !== except)
              .reduce((sum, note) => sum + Buffer.byteLength(note.text), 0);
          if (total(excludeId) + Buffer.byteLength(text) > MEMORY_BYTES) {
            return yield* fail(
              `Memory would pass ${MEMORY_BYTES} bytes (now ${total()}). Merge or remove notes first.`,
            );
          }
        });
        if (sub === "add") {
          const text = textOf(rest, input.stdin);
          yield* check(text);
          return touched(`Note ${yield* store.addMemory(botId, text)} saved.`);
        }
        const id = yield* idOf(rest[0], "note");
        if (sub === "edit") {
          const text = textOf(rest.slice(1), input.stdin);
          yield* check(text, id);
          return (yield* store.editMemory(botId, id, text))
            ? touched(`Note ${id} rewritten.`)
            : yield* fail(`You have no note ${id}.`);
        }
        if (sub === "remove") {
          return (yield* store.removeMemory(botId, id))
            ? touched(`Note ${id} removed.`)
            : yield* fail(`You have no note ${id}.`);
        }
        return yield* fail("memory add | edit | remove");
      }
      case "thread":
        return yield* threadCommand(input, sub, rest, flags);
      case "chat":
        return yield* chatMoved(botId);
      default:
        return yield* fail(`Unknown command "${command}". Run help.`);
    }
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
    }).pipe(
      Effect.mapError((cause) => new BotOperationError({ stage: "launch-owned-thread", cause })),
    );
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
    const store = yield* runtime.store;
    const bot = (yield* store.getBot(botId))!;

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
      if (
        itemId !== null &&
        !(yield* store.listItems(botId)).some((candidate) => candidate.id === itemId)
      ) {
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
      const preset = yield* threadModelFor(bot);
      const picked = {
        instanceId: flags.get("provider") ?? preset.instanceId,
        model: flags.get("model") ?? (flags.has("provider") ? "" : preset.model),
      } as ModelSelection;
      if (picked.model === "") return yield* fail("With --provider, give --model too.");
      // The preset keeps its options, effort among them; another starts at that model's defaults.
      const modelSelection =
        picked.instanceId === preset.instanceId && picked.model === preset.model ? preset : picked;
      // One start at a time, so two starts in one turn cannot both fit under the limit.
      return yield* runtime.threadStartLock.withPermit(
        Effect.gen(function* () {
          const running = (yield* store.listThreads(botId)).filter(
            (thread) => !thread.takenOver && !isTerminalRunStatus(thread.status),
          ).length;
          const overBudget = running >= bot.settings.maxThreads;
          const asked = yield* gate(
            call,
            "allow",
            overBudget,
            `start a thread in ${project.title}${overBudget ? ` (${running} of its ${bot.settings.maxThreads} threads already run)` : ""}`,
            prompt,
          );
          if (asked !== null) return asked;
          const commandId = CommandId.make(newId("fork-bot"));
          const threadId = ThreadId.make(commandId);
          // Owned before it launches: a run that ends at once is still reported.
          yield* store.addThread({
            threadId,
            botId,
            projectId: project.id,
            itemId,
            follow,
            createdAt: yield* nowIso,
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
              Effect.gen(function* () {
                yield* store.removeThread(threadId, yield* nowIso);
                runtime.ownedThreads.delete(threadId);
              }).pipe(Effect.orDie),
            ),
          );
          if (itemId !== null) yield* store.updateItem(botId, itemId, {}, yield* nowIso);
          runtime.publish(botId);
          return `Thread ${threadId} started in ${project.title}. ${
            follow === "now"
              ? "It will wake you when it stops; meanwhile the chat shows the user its progress. End your turn now, with NO_REPLY unless you have more to tell them."
              : `It will wake you ${follow === "attention" ? "if it fails or needs someone" : "never; read it on a routine"}. End your turn now.`
          }`;
        }),
      );
    }

    const threadId = rest[0];
    if (threadId === undefined) return yield* fail("Name the thread.");

    if (sub === "send") {
      const owned = (yield* store.listThreads(botId)).find(
        (thread) => thread.threadId === threadId,
      );
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
      const fresh = flags.has("fresh");
      const sent = yield* threads
        .sendToThread({
          projectId: ProjectId.make(owned.projectId),
          commandId: CommandId.make(newId("fork-bot")),
          threadId: ThreadId.make(threadId),
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text,
          attachments: [],
          // A fresh start cannot join a running turn, so it waits for that turn to end.
          ...(fresh ? { mode: "queue", freshContext: true } : { mode: "auto" }),
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (cause) => new BotOperationError({ stage: "send-to-owned-thread", cause }),
          ),
        );
      if (fresh) return `Sent (${sent.delivery}), on a clean context.`;
      const fill = yield* threadContext(owned.projectId, threadId);
      return fill === null || fill.used / fill.max < FRESH_AT
        ? `Sent (${sent.delivery}).`
        : `Sent (${sent.delivery}). ${contextLine(fill)}`;
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
          ["messages", "runs", "providerTurns"],
          { messageRoles: ["user", "assistant"] },
        )
        .pipe(
          Effect.mapError((cause) => new BotOperationError({ stage: "read-owned-thread", cause })),
        );
      const latestRun = records.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const messages = records.messages
        .filter((message) => message.text.trim() !== "")
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        )
        .slice(-limit);
      return [
        `"${shell.title}" - latest run ${latestRun?.status ?? "none"}. ${contextLine(contextFill(records))}`,
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

  /**
   * The user's answer to a question. Approving claims it once and runs the stored call, whose own
   * checks (ownership, takeover) run again; the bot hears the outcome on its next turn.
   */
  const answerQuestion = Effect.fn("ForkBot.answerQuestion")(function* (input: unknown) {
    const runtime = yield* BotRuntime;
    const decoded = yield* decode(AnswerInput, input);
    const store = runtime.existingStore();
    const question =
      (yield* (
        store?.answerQuestion(
          decoded.botId,
          decoded.questionId,
          decoded.approve ? "approved" : "declined",
          yield* nowIso,
        ) ?? Effect.undefined
      )) ?? null;
    if (question === null) {
      return yield* new BotRejection({
        code: "question_closed",
        message: "That question was already answered or has lapsed.",
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
        BotRejection: (error) => Effect.succeed({ ok: false, output: error.message }),
        BotOperationError: (error) =>
          Effect.succeed({ ok: false, output: describeBotError(error) }),
        InboxOperationError: (error) =>
          Effect.succeed({ ok: false, output: describeInboxError(error) }),
        InboxRejection: (error) => Effect.succeed({ ok: false, output: error.message }),
      }),
    );
    yield* store!.setQuestionResult(question.id, outcome.output);
    yield* notify(
      question.botId,
      outcome.ok
        ? `The user approved your question ${question.id}, and it ran: ${outcome.output}`
        : `The user approved your question ${question.id}, but it failed: ${outcome.output}`,
      true,
    );
    return { ok: outcome.ok, output: outcome.output };
  });

  return { authenticateTool, runTool, answerQuestion, takenOverByUser };
};
