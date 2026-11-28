// @effect-diagnostics nodeBuiltinImport:off - Context folders are plain files an agent writes; timestamps are wall-clock ISO strings for humans.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ThreadId,
  isProviderAvailable,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import { ThreadLaunchBaseRefError } from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ChannelConfigError, type ChannelConfigEntry } from "../channels/config.ts";
import { EXAMPLE_SIMULATIONS } from "../channels/example/exampleChannel.ts";
import {
  AdapterRequestError,
  ChannelUnavailableError,
  channelAccess,
  type ChannelHub,
  type ChannelView,
} from "../channels/hub.ts";
import {
  Conversation,
  Message,
  RawPage,
  Mention,
  SendResult,
  Upload,
  Timestamp,
  type Conversation as ConversationType,
  type Message as MessageType,
} from "../channels/protocol.ts";
import {
  applyFallback,
  discardDraft as discardDraftFile,
  fallbackApplied,
  readArtifacts,
  readSent,
  recordSent,
  threadContextDir,
} from "./artifacts.ts";
import {
  CONTEXT_FILE,
  MEDIA_DIR,
  REQUEST_FILE,
  buildContextMarkdown,
  firstMessage,
  mediaFileName,
  nameOrUnknown,
  parseFallbackDraft,
  threadTitle,
  type ContextImage,
} from "./context.ts";
import {
  agentUnseen,
  compareConversations,
  conversationCountsTowardBadge,
  delegationIdFor,
  deriveConversation,
  messagesInRange,
  rangeUntil,
  scopeIsChain,
  sortMessages,
  type ConversationState,
} from "./derive.ts";
import { InboxRuntime } from "./InboxRuntime.ts";
import type { Delegation, DelegationScope, Link } from "./store.ts";

export class ForkHttpError extends Schema.TaggedError<ForkHttpError>()("ForkHttpError", {
  status: Schema.Number,
  code: Schema.String,
  detail: Schema.String,
  field: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isForkHttpError = Schema.is(ForkHttpError);

const isBaseRefError = Schema.is(ThreadLaunchBaseRefError);

function toForkError(error: unknown): ForkHttpError {
  if (isForkHttpError(error)) return error;
  if (error instanceof ChannelUnavailableError) {
    return new ForkHttpError({
      status: error.status === "missing" ? 404 : 409,
      code: error.status,
      detail: error.message,
    });
  }
  if (error instanceof AdapterRequestError) {
    return new ForkHttpError({ status: 502, code: error.code, detail: error.message });
  }
  if (isBaseRefError(error)) {
    return new ForkHttpError({
      status: 400,
      code: "bad_request",
      detail: error.message,
      field: "workspaceStrategy",
    });
  }
  if (error instanceof ChannelConfigError) {
    return new ForkHttpError({
      status: 400,
      code: "invalid_config",
      detail: error.message,
      ...(error.field ? { field: error.field } : {}),
    });
  }
  return new ForkHttpError({
    status: 500,
    code: "internal",
    detail: error instanceof Error ? error.message : String(error),
  });
}

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toForkError });

const prettyJson = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

const badRequest = (detail: string, field?: string) =>
  new ForkHttpError({ status: 400, code: "bad_request", detail, ...(field ? { field } : {}) });

const CONVERSATION_LIMIT = 100;
const MESSAGE_LIMIT = 200;
/** One page of a conversation's chat; older pages load as the reader scrolls up. */
const CONVERSATION_MESSAGE_LIMIT = 100;
/** Page caps: far above a real inbox, low enough that a looping adapter cannot hang a request. */
const CONVERSATION_PAGES = 20;
const MESSAGE_PAGES = 50;
/** How far back a range delegation reads to find its first message. */
const RANGE_PAGES = 20;
const PREVIEW_CHARS = 140;
const SENDER_HISTORY_MS = 7 * 24 * 3_600_000;
/** A channel read for the first time shows only its last week as unread. */
const FIRST_READ_LOOKBACK_MS = 7 * 24 * 3_600_000;

const decodeSendResultOption = Schema.decodeUnknownOption(SendResult);
const decodeUpload = Schema.decodeUnknownOption(Upload);

/**
 * A list of ids in the adapter's send answer. Read apart from `messageId`, so a malformed one
 * never hides that the message went out.
 */
const idsIn = (answer: unknown, key: string): ReadonlySet<string> => {
  const value: unknown =
    typeof answer === "object" && answer !== null ? Reflect.get(answer, key) : undefined;
  return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
};
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeWorkspaceStrategy = Schema.decodeUnknownEffect(
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
);
type WorkspaceStrategy = OrchestrationV2ThreadLaunchWorkspaceStrategy;

const enc = encodeURIComponent;
const conversationsPath = `/conversations?relevant=1&limit=${CONVERSATION_LIMIT}`;
const chainPath = (conversationId: string, rootId: string) =>
  `/conversations/${enc(conversationId)}/messages?root=${enc(rootId)}&limit=${MESSAGE_LIMIT}`;
const conversationMessagesPath = (conversationId: string, cursor: string | undefined) =>
  `/conversations/${enc(conversationId)}/messages?order=desc&limit=${CONVERSATION_MESSAGE_LIMIT}${
    cursor === undefined ? "" : `&cursor=${enc(cursor)}`
  }`;

export interface ProjectPathMatch {
  readonly path: string;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
}

function expandHome(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return NodeOS.homedir();
  if (trimmed.startsWith("~/")) return NodePath.join(NodeOS.homedir(), trimmed.slice(2));
  return trimmed;
}

function matchProjectPaths(
  paths: ReadonlyArray<string>,
  projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">>,
): ReadonlyArray<ProjectPathMatch> {
  return paths.map((raw) => {
    const wanted = NodePath.resolve(expandHome(raw));
    const project = projects.find(
      (candidate) => NodePath.resolve(candidate.workspaceRoot) === wanted,
    );
    return { path: raw, projectId: project?.id ?? null, projectTitle: project?.title ?? null };
  });
}

const activeProjects = Effect.gen(function* () {
  const projects = yield* Project.ProjectService;
  const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
  return shells.filter((shell) => !shell.archivedAt);
});

export interface ChannelListEntry extends ChannelView {
  readonly projectMatches: ReadonlyArray<ProjectPathMatch>;
}

/** The one shape the settings page gets a channel in, from the list and from a test alike. */
const channelEntry = Effect.fn("ForkChannels.entry")(function* (view: ChannelView) {
  const projects = yield* activeProjects;
  return {
    ...view,
    projectMatches: matchProjectPaths(view.config?.defaultProjectPaths ?? [], projects),
  } satisfies ChannelListEntry;
});

export const listChannels = Effect.fn("ForkChannels.list")(function* () {
  const { hub } = yield* InboxRuntime;
  return { channels: yield* Effect.forEach(hub.list(), channelEntry) };
});

const ChannelInput = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["http-adapter", "example"]),
  name: Schema.String,
  baseUrl: Schema.String,
  tokenFile: Schema.String,
  enabled: Schema.Boolean,
});
const decodeChannelInput = Schema.decodeUnknownEffect(ChannelInput);

export const saveChannel = Effect.fn("ForkChannels.save")(function* (
  body: unknown,
  options: { readonly create: boolean },
) {
  const input = yield* decodeChannelInput(body).pipe(
    Effect.mapError(() => badRequest("The channel is missing fields.")),
  );
  const { hub } = yield* InboxRuntime;
  return yield* attempt(() => hub.save(input satisfies ChannelConfigEntry, options));
});

export const removeChannel = Effect.fn("ForkChannels.remove")(function* (channelId: string) {
  const { hub } = yield* InboxRuntime;
  const removed = yield* attempt(() => hub.remove(channelId));
  return { removed };
});

export const testChannel = Effect.fn("ForkChannels.test")(function* (channelId: string) {
  const { hub } = yield* InboxRuntime;
  return yield* channelEntry(yield* attempt(() => hub.test(channelId)));
});

const ProbeInput = Schema.Struct({ baseUrl: Schema.String, tokenFile: Schema.String });
const decodeProbeInput = Schema.decodeUnknownEffect(ProbeInput);

export const probeChannel = Effect.fn("ForkChannels.probe")(function* (body: unknown) {
  const input = yield* decodeProbeInput(body).pipe(
    Effect.mapError(() => badRequest("Give the adapter's address and token file.")),
  );
  const { hub } = yield* InboxRuntime;
  return yield* attempt(() => hub.probe(input));
});

const SimulateInput = Schema.Struct({
  channelId: Schema.String,
  simulation: Schema.Literals(EXAMPLE_SIMULATIONS),
});
const decodeSimulateInput = Schema.decodeUnknownEffect(SimulateInput);

export const simulateChannel = Effect.fn("ForkChannels.simulate")(function* (body: unknown) {
  const input = yield* decodeSimulateInput(body).pipe(
    Effect.mapError(() => badRequest("Name the channel and a state to simulate.")),
  );
  const { hub } = yield* InboxRuntime;
  return yield* channelEntry(yield* attempt(() => hub.simulate(input.channelId, input.simulation)));
});

export type LinkedThreadStatus = "running" | "idle" | "archived" | "deleted" | "unknown";

export interface LinkedThreadView {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly status: LinkedThreadStatus;
  /** When its last run worth a look finished; null while running or after a quiet run. */
  readonly runCompletedAt: string | null;
  readonly createdAt: string;
  readonly detachedAt: string | null;
}

const RUNNING = new Set<string>(ThreadManagement.ACTIVE_RUN_STATUSES);

function threadStatus(shell: OrchestrationV2ThreadShell): LinkedThreadStatus {
  if (shell.archivedAt !== null) return "archived";
  return shell.activeRunId !== null || RUNNING.has(shell.status) ? "running" : "idle";
}

/** A stopped run, a rollback, or a background-work wake (a Monitor line) has nothing new to show. */
const NOTABLE_RUN_STATUSES = new Set<string>(["completed", "failed", "interrupted"]);

function runCompletedAt(shell: OrchestrationV2ThreadShell): string | null {
  if (
    threadStatus(shell) === "running" ||
    !NOTABLE_RUN_STATUSES.has(shell.status) ||
    shell.latestRunStopRequested === true ||
    shell.latestRunBackgroundWake === true ||
    !shell.latestRunCompletedAt
  ) {
    return null;
  }
  return DateTime.formatIso(shell.latestRunCompletedAt);
}

/**
 * A thread that could not write into its context folder answers with tags instead. Read each
 * finished run once and write what it holds, so the rest of the inbox reads only files.
 */
const applyFallbackFor = Effect.fn("ForkInbox.applyFallback")(function* (
  contextDir: string,
  shell: OrchestrationV2ThreadShell,
) {
  const runId = shell.latestRunId;
  // Only a finished run: a launch reads as idle for a moment before its run starts.
  if (
    runId === null ||
    threadStatus(shell) === "running" ||
    shell.latestRunCompletedAt === null ||
    shell.latestRunCompletedAt === undefined
  ) {
    return;
  }
  if (yield* Effect.promise(() => fallbackApplied(contextDir, runId))) return;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads
    .getThreadRecords(shell.id, ["messages"], {
      messageRunIds: [runId],
      messageRoles: ["assistant"],
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (records === null) return;
  const finished = records.messages.filter((message) => !message.streaming);
  const last = finished.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
  )[finished.length - 1];
  const draft = last ? parseFallbackDraft(last.text) : null;
  yield* Effect.promise(() => applyFallback(contextDir, runId, draft).catch(() => undefined));
});

/**
 * The link's thread as it is now. A thread that no longer exists detaches the link. Only the
 * delegation's current link fills its folder from tags; older ones are history and stay as they are.
 */
const inspectLink = Effect.fn("ForkInbox.inspectLink")(function* (
  link: Link,
  options: { readonly current: boolean },
) {
  const runtime = yield* InboxRuntime;
  const base = {
    threadId: link.threadId,
    projectId: link.projectId,
    createdAt: link.createdAt,
    detachedAt: link.detachedAt,
  };
  if (link.detachedAt !== null && link.detachedReason === "deleted") {
    return {
      ...base,
      title: null,
      status: "deleted",
      runCompletedAt: null,
    } satisfies LinkedThreadView;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(ThreadId.make(link.threadId))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (shell === undefined)
    return {
      ...base,
      title: null,
      status: "unknown",
      runCompletedAt: null,
    } satisfies LinkedThreadView;
  if (shell === null || shell.deletedAt !== null) {
    const at = link.detachedAt ?? DateTime.formatIso(yield* DateTime.now);
    if (link.detachedAt === null) {
      runtime.store.detachLink(link.delegationId, link.threadId, "deleted", at);
    }
    return {
      ...base,
      detachedAt: at,
      title: null,
      status: "deleted",
      runCompletedAt: null,
    } satisfies LinkedThreadView;
  }
  if (options.current && link.detachedAt === null) {
    yield* applyFallbackFor(
      threadContextDir(runtime.itemsDir, link.delegationId, link.threadId),
      shell,
    );
  }
  return {
    ...base,
    title: shell.title,
    status: threadStatus(shell),
    runCompletedAt: runCompletedAt(shell),
  } satisfies LinkedThreadView;
});

/** The newest link still attached; older ones were replaced or lost their thread. */
const activeLinkOf = (links: ReadonlyArray<Link>) => links.find((link) => link.detachedAt === null);

const isCurrent = (thread: LinkedThreadView | null): thread is LinkedThreadView =>
  thread !== null && thread.detachedAt === null && thread.status !== "deleted";

export interface InboxConversation extends ConversationState {
  readonly id: string;
  readonly channelId: string;
  readonly kind: ConversationType["kind"];
  readonly name: string;
  readonly lastActivityAt: string;
  readonly lastMessage: ConversationType["lastMessage"];
  /** Notifications are off for it in the chat app. */
  readonly muted: boolean;
}

export interface InboxDelegation {
  readonly id: string;
  readonly channelId: string;
  readonly conversationId: string;
  /** Empty when the channel no longer lists the conversation. */
  readonly conversationName: string;
  readonly anchorMessageId: string;
  readonly scope: DelegationScope | null;
  readonly preview: string | null;
  readonly createdAt: string;
  readonly thread: LinkedThreadView | null;
  /** The thread finished a run after the user last looked. */
  readonly agentUnseen: boolean;
  readonly hasDraft: boolean;
  /** When the user last replied from this delegation; null before the first reply. */
  readonly lastSentAt: string | null;
  /** When the user marked it done; null while it is open. */
  readonly settledAt: string | null;
}

/** The count only: the records themselves may hold message text. */
const warnSkipped = (channelId: string, list: string, skipped: number) =>
  skipped === 0
    ? Effect.void
    : Effect.logWarning(
        `Skipped ${skipped} ${list} from the adapter that do not match the protocol.`,
        {
          channelId,
        },
      );

interface ChannelListing {
  readonly conversations: ReadonlyArray<InboxConversation>;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly stale: boolean;
  /** The page cap the conversation list hit before it ended; null when it was read to its end. */
  readonly truncatedAtPages: number | null;
  /** Conversations left out because they did not decode. */
  readonly skipped: number;
  /** The conversations as the adapter sent them. */
  readonly raw: ReadonlyArray<ConversationType>;
}

interface ListingMemo {
  readonly revision: number;
  readonly at: number;
  readonly fiber: Fiber.Fiber<ChannelListing, ForkHttpError>;
}

/** Bounds a change no signal announced, as the client's poll does. */
const LISTING_MEMO_MS = 10_000;
const listingMemos = new WeakMap<ChannelHub, Map<string, ListingMemo>>();

/**
 * One event sends the overview, the list, and the open delegation here at once. They share one
 * read of the channel, reused until the hub's revision for it moves (an adapter event, a read, a
 * link, a thread's run) or it gets old.
 */
export const readChannel = Effect.fn("ForkInbox.readChannel")(function* (channelId: string) {
  const { hub } = yield* InboxRuntime;
  let memos = listingMemos.get(hub);
  if (memos === undefined) {
    memos = new Map();
    listingMemos.set(hub, memos);
  }
  const revision = hub.revision(channelId);
  const now = yield* Clock.currentTimeMillis;
  let memo = memos.get(channelId);
  if (memo === undefined || memo.revision !== revision || now - memo.at >= LISTING_MEMO_MS) {
    // Detached: a client that gives up must not cancel the read the others are waiting on.
    memo = { revision, at: now, fiber: yield* Effect.forkDetach(computeChannel(channelId)) };
    memos.set(channelId, memo);
  }
  const joined = memo;
  return yield* Fiber.join(joined.fiber).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        if (memos.get(channelId) === joined) memos.delete(channelId);
      }),
    ),
  );
});

const inspectDelegation = Effect.fn("ForkInbox.inspectDelegation")(function* (
  delegation: Delegation,
  links: ReadonlyArray<Link>,
) {
  const runtime = yield* InboxRuntime;
  const shown = activeLinkOf(links) ?? links[0];
  const thread = shown ? yield* inspectLink(shown, { current: shown.detachedAt === null }) : null;
  const [artifacts, sent] = yield* Effect.promise(() =>
    Promise.all([
      thread
        ? readArtifacts(threadContextDir(runtime.itemsDir, delegation.id, thread.threadId))
        : { draft: null },
      readSent(NodePath.join(runtime.itemsDir, delegation.id)),
    ]),
  );
  return { thread, artifacts, lastSentAt: sent[0]?.sentAt ?? null };
});

const computeChannel = Effect.fn("ForkInbox.computeChannel")(function* (channelId: string) {
  const runtime = yield* InboxRuntime;
  const { hub, store } = runtime;
  const listed = yield* attempt(() =>
    hub.getAllPages(channelId, conversationsPath, Conversation, { maxPages: CONVERSATION_PAGES }),
  );
  const reads = new Map(
    store.listConversationReads(channelId).map((read) => [read.conversationId, read] as const),
  );
  const readAllBefore = store.readAllBefore(
    channelId,
    DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - FIRST_READ_LOOKBACK_MS),
    ),
  );
  const conversations = listed.items
    .map(
      (conversation) =>
        ({
          ...deriveConversation({
            conversation,
            read: reads.get(conversation.id) ?? null,
            readAllBefore,
          }),
          id: conversation.id,
          channelId,
          kind: conversation.kind,
          name: conversation.name,
          lastActivityAt: conversation.lastActivityAt,
          lastMessage: conversation.lastMessage,
          muted: conversation.muted,
        }) satisfies InboxConversation,
    )
    .toSorted(compareConversations);
  const linksByDelegation = new Map<string, Link[]>();
  // Newest first, so each delegation's list starts with its latest link.
  for (const link of store.listLinks(channelId)) {
    const list = linksByDelegation.get(link.delegationId) ?? [];
    list.push(link);
    linksByDelegation.set(link.delegationId, list);
  }
  const names = new Map(listed.items.map((conversation) => [conversation.id, conversation.name]));
  const delegations = yield* Effect.forEach(
    store.listDelegations(channelId),
    (delegation) =>
      Effect.gen(function* () {
        // A settled delegation is history: it raises no signal, so its thread is not read here.
        if (delegation.settledAt !== null) {
          return {
            id: delegation.id,
            channelId,
            conversationId: delegation.conversationId,
            conversationName: names.get(delegation.conversationId) ?? "",
            anchorMessageId: delegation.anchorMessageId,
            scope: delegation.scope,
            preview: delegation.preview,
            createdAt: delegation.createdAt,
            thread: null,
            agentUnseen: false,
            hasDraft: false,
            lastSentAt: null,
            settledAt: delegation.settledAt,
          } satisfies InboxDelegation;
        }
        const { thread, artifacts, lastSentAt } = yield* inspectDelegation(
          delegation,
          linksByDelegation.get(delegation.id) ?? [],
        );
        // A deleted or replaced thread is history: its draft and runs no longer count.
        const current = isCurrent(thread) ? thread : null;
        return {
          id: delegation.id,
          channelId,
          conversationId: delegation.conversationId,
          conversationName: names.get(delegation.conversationId) ?? "",
          anchorMessageId: delegation.anchorMessageId,
          scope: delegation.scope,
          preview: delegation.preview,
          createdAt: delegation.createdAt,
          thread,
          agentUnseen: agentUnseen({
            delegation,
            runCompletedAt: current?.runCompletedAt ?? null,
            readAllBefore,
          }),
          hasDraft: current !== null && artifacts.draft !== null,
          lastSentAt,
          settledAt: null,
        } satisfies InboxDelegation;
      }),
    { concurrency: 4 },
  );
  yield* warnSkipped(channelId, "conversations", listed.skipped);
  return {
    conversations,
    delegations,
    stale: listed.stale,
    truncatedAtPages: listed.complete ? null : CONVERSATION_PAGES,
    skipped: listed.skipped,
    raw: listed.items,
  } satisfies ChannelListing;
});

export interface InboxChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ChannelView["kind"];
  readonly status: ChannelView["status"];
  readonly statusSince: string;
  readonly lastSyncAt: string | null;
  readonly selfName: string | null;
  readonly access: ReturnType<typeof channelAccess>;
  /** The optional parts of the protocol the adapter implements. */
  readonly capabilities: ReadonlyArray<string>;
  readonly unreadCount: number | null;
  /** What may wait on the user, for the sidebar; null until the listing is read. */
  readonly attention: ChannelAttention | null;
  readonly error: string | null;
}

/**
 * Unread DMs, mentions, and conversations with an open follow-up, with those follow-ups. The
 * client picks the ones that need the user, since a follow-up's blocked thread is client state.
 */
interface ChannelAttention {
  readonly conversations: ReadonlyArray<InboxConversation>;
  readonly delegations: ReadonlyArray<InboxDelegation>;
}

const badgeCount = (listing: ChannelListing) =>
  listing.conversations.filter((conversation) =>
    conversationCountsTowardBadge(conversation.kind, conversation),
  ).length + listing.delegations.filter((delegation) => delegation.agentUnseen).length;

const attentionOf = (listing: ChannelListing): ChannelAttention => {
  const delegations = listing.delegations.filter((delegation) => delegation.settledAt === null);
  const followed = new Set(delegations.map((delegation) => delegation.conversationId));
  return {
    conversations: listing.conversations.filter(
      (conversation) =>
        followed.has(conversation.id) ||
        conversationCountsTowardBadge(conversation.kind, conversation),
    ),
    delegations,
  };
};

/** How long the overview waits on a channel's listing before answering without its count. */
const OVERVIEW_WAIT = "500 millis";

/** Enabled channels with their state; the sidebar badge sums `unreadCount`. */
export const overview = Effect.fn("ForkInbox.overview")(function* () {
  const { hub } = yield* InboxRuntime;
  const channels = hub.list().filter((channel) => channel.enabled);
  const summaries = yield* Effect.forEach(
    channels,
    (channel) =>
      Effect.gen(function* () {
        const access = channelAccess(channel.status);
        const read = access.read
          ? yield* readChannel(channel.id).pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error: ForkHttpError) =>
                Effect.succeed({ ok: false as const, error: error.detail }),
              ),
              Effect.timeoutOption(OVERVIEW_WAIT),
            )
          : Option.none();
        if (access.read && Option.isNone(read)) {
          // The read goes on; clients refetch the count once it lands.
          yield* Effect.forkDetach(
            readChannel(channel.id).pipe(
              Effect.andThen(
                Effect.sync(() => hub.publish({ type: "counts", channelId: channel.id })),
              ),
              Effect.ignore,
            ),
          );
        }
        const listing = Option.getOrNull(read);
        return {
          id: channel.id,
          name: channel.config?.displayName ?? channel.name,
          kind: channel.kind,
          status: channel.status,
          statusSince: channel.statusSince,
          lastSyncAt: channel.health?.lastSyncAt ?? null,
          selfName: channel.health?.self.name ?? null,
          access,
          capabilities: channel.config?.capabilities ?? [],
          unreadCount: listing?.ok === true ? badgeCount(listing.result) : null,
          attention: listing?.ok === true ? attentionOf(listing.result) : null,
          error:
            listing?.ok === false
              ? listing.error
              : (channel.steps.find((step) => !step.ok)?.detail ?? null),
        } satisfies InboxChannelSummary;
      }),
    { concurrency: 2 },
  );
  return { channels: summaries };
});

const channelOrMissing = Effect.fn("ForkInbox.channel")(function* (channelId: string) {
  const { hub } = yield* InboxRuntime;
  const channel = hub.get(channelId);
  if (channel === null) {
    return yield* new ForkHttpError({ status: 404, code: "missing", detail: "No such channel." });
  }
  return channel;
});

export const listInbox = Effect.fn("ForkInbox.list")(function* (channelId: string) {
  const channel = yield* channelOrMissing(channelId);
  const result = yield* readChannel(channelId);
  return {
    conversations: result.conversations,
    delegations: result.delegations,
    stale: result.stale,
    truncatedAtPages: result.truncatedAtPages,
    skipped: result.skipped,
    access: channelAccess(channel.status),
    status: channel.status,
  };
});

const decodeMessageExit = Schema.decodeUnknownExit(Message);

function decodeMessages(items: ReadonlyArray<unknown>) {
  const messages: Array<MessageType> = [];
  let skipped = 0;
  for (const raw of items) {
    const decoded = decodeMessageExit(raw);
    if (decoded._tag === "Success") messages.push(decoded.value);
    else skipped += 1;
  }
  return { messages, skipped };
}

interface ScopeMessages {
  /** Oldest first. */
  readonly messages: ReadonlyArray<MessageType>;
  /** Every message the scope covers was read. */
  readonly complete: boolean;
  /** The adapter no longer has the chain's first message; only its replies were read. */
  readonly rootMissing: boolean;
  readonly skipped: number;
  readonly stale: boolean;
}

export const readChain = Effect.fn("ForkInbox.readChain")(function* (
  channelId: string,
  conversationId: string,
  rootId: string,
  options: { readonly cacheMs?: number },
) {
  const { hub } = yield* InboxRuntime;
  const result = yield* attempt(() =>
    hub.getAllPages(channelId, chainPath(conversationId, rootId), Message, {
      ...options,
      maxPages: MESSAGE_PAGES,
    }),
  );
  yield* warnSkipped(channelId, "messages", result.skipped);
  const messages = sortMessages(result.items);
  return {
    messages,
    complete: result.complete,
    rootMissing: !messages.some((message) => message.id === rootId),
    skipped: result.skipped,
    stale: result.stale,
  } satisfies ScopeMessages;
});

/** Reads the conversation back, newest page first, until `anchorMessageId` turns up. */
const readBackTo = Effect.fn("ForkInbox.readBackTo")(function* (
  channelId: string,
  conversationId: string,
  anchorMessageId: string,
  options: { readonly cacheMs?: number },
) {
  const { hub } = yield* InboxRuntime;
  const messages: Array<MessageType> = [];
  const cursors = new Set<string>();
  let skipped = 0;
  let stale = false;
  let cursor: string | undefined;
  let found = false;
  for (let page = 0; page < RANGE_PAGES && !found; page++) {
    const answer = yield* attempt(() =>
      hub.getJson(channelId, conversationMessagesPath(conversationId, cursor), RawPage, options),
    );
    if (answer.stale) stale = true;
    const decoded = decodeMessages(answer.value.items);
    messages.push(...decoded.messages);
    skipped += decoded.skipped;
    found = decoded.messages.some((message) => message.id === anchorMessageId);
    const next = answer.value.nextCursor;
    if (next === null || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  yield* warnSkipped(channelId, "messages", skipped);
  return { messages: sortMessages(messages), found, skipped, stale };
});

/** The messages a delegation covers, as it reads now. */
const readScope = Effect.fn("ForkInbox.readScope")(function* (
  delegation: Pick<
    Delegation,
    "channelId" | "conversationId" | "anchorMessageId" | "scope" | "untilAt"
  >,
  kind: ConversationType["kind"],
  options: { readonly cacheMs?: number },
) {
  const { channelId, conversationId, anchorMessageId } = delegation;
  if (scopeIsChain(delegation, kind)) {
    return yield* readChain(channelId, conversationId, anchorMessageId, options);
  }
  const back = yield* readBackTo(channelId, conversationId, anchorMessageId, options);
  const anchor = back.messages.find((message) => message.id === anchorMessageId);
  return {
    messages: messagesInRange(
      back.messages,
      anchorMessageId,
      rangeUntil(delegation, anchor?.createdAt ?? null),
    ),
    complete: back.found,
    rootMissing: false,
    skipped: back.skipped,
    stale: back.stale,
  } satisfies ScopeMessages;
});

const DelegationQuery = Schema.Struct({ channelId: Schema.String, delegationId: Schema.String });
const decodeDelegationQuery = Schema.decodeUnknownEffect(DelegationQuery);

const missingDelegation = () =>
  new ForkHttpError({ status: 404, code: "missing", detail: "No such delegation." });

const findDelegation = Effect.fn("ForkInbox.findDelegation")(function* (
  channelId: string,
  delegationId: string,
) {
  const runtime = yield* InboxRuntime;
  const channel = yield* channelOrMissing(channelId);
  const delegation = runtime.store.getDelegation(delegationId);
  if (delegation === null || delegation.channelId !== channelId) return yield* missingDelegation();
  const listing = yield* readChannel(channelId);
  const listed = listing.delegations.find((candidate) => candidate.id === delegationId);
  if (listed === undefined) return yield* missingDelegation();
  // The listing skips a settled delegation's thread; opening it shows its history.
  const item =
    listed.settledAt === null
      ? listed
      : yield* inspectDelegation(delegation, runtime.store.linksForDelegation(delegation.id)).pipe(
          Effect.map(({ thread, lastSentAt }) => ({ ...listed, thread, lastSentAt })),
        );
  const conversation = listing.raw.find((candidate) => candidate.id === delegation.conversationId);
  return {
    delegation,
    item,
    // A conversation the channel stopped listing still has its delegations; read it as a group.
    conversation: {
      id: delegation.conversationId,
      name: conversation?.name ?? "",
      kind: conversation?.kind ?? "group",
    },
    channel,
  };
});

export const readDelegation = Effect.fn("ForkInbox.readDelegation")(function* (
  query: URLSearchParams,
) {
  const input = yield* decodeDelegationQuery(Object.fromEntries(query)).pipe(
    Effect.mapError(() => badRequest("Name the channel and delegation.")),
  );
  const runtime = yield* InboxRuntime;
  const { delegation, item, conversation, channel } = yield* findDelegation(
    input.channelId,
    input.delegationId,
  );
  const scoped = yield* readScope(delegation, conversation.kind, { cacheMs: 5_000 });
  const thread = item.thread;
  // Only the current thread's draft can go into the reply box.
  const draft =
    thread && isCurrent(thread)
      ? (yield* Effect.promise(() =>
          readArtifacts(threadContextDir(runtime.itemsDir, item.id, thread.threadId)),
        )).draft
      : null;
  const history = yield* Effect.forEach(
    runtime.store.linksForDelegation(item.id).filter((link) => link.threadId !== thread?.threadId),
    (link) => inspectLink(link, { current: false }),
  );
  const access = channelAccess(channel.status);
  return {
    delegation: item,
    conversation,
    messages: scoped.messages,
    complete: scoped.complete,
    rootMissing: scoped.rootMissing,
    stale: scoped.stale,
    skipped: scoped.skipped,
    canSend: access.send,
    draft,
    previousThreads: history,
  };
});

const ConversationInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  cursor: Schema.optional(Schema.String),
});
const decodeConversationInput = Schema.decodeUnknownEffect(ConversationInput);

/** One page of the conversation, newest first from the adapter, oldest first to the client. */
export const readConversation = Effect.fn("ForkInbox.readConversation")(function* (
  query: URLSearchParams,
) {
  const input = yield* decodeConversationInput(Object.fromEntries(query)).pipe(
    Effect.mapError(() => badRequest("Name the channel and conversation.")),
  );
  const { hub } = yield* InboxRuntime;
  const page = yield* attempt(() =>
    hub.getJson(
      input.channelId,
      conversationMessagesPath(input.conversationId, input.cursor),
      RawPage,
      { cacheMs: 5_000 },
    ),
  );
  const { messages, skipped } = decodeMessages(page.value.items);
  yield* warnSkipped(input.channelId, "messages", skipped);
  return {
    messages: sortMessages(messages),
    nextCursor: page.value.nextCursor,
    stale: page.stale,
    skipped,
  };
});

export const media = Effect.fn("ForkInbox.media")(function* (query: URLSearchParams) {
  const channelId = query.get("channelId");
  const messageId = query.get("messageId");
  const key = query.get("key");
  if (!channelId || !messageId || !key) return yield* badRequest("Name the message and its file.");
  const { hub } = yield* InboxRuntime;
  return yield* attempt(() => hub.getMedia(channelId, `/media/${enc(messageId)}/${enc(key)}`));
});

const ReadInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  read: Schema.Boolean,
  /** The newest message the client showed: what is marked read is what the user saw. */
  lastMessageAt: Schema.optional(Timestamp),
});
const decodeReadInput = Schema.decodeUnknownEffect(ReadInput);

export const setRead = Effect.fn("ForkInbox.setRead")(function* (body: unknown) {
  const input = yield* decodeReadInput(body).pipe(
    Effect.mapError(() => badRequest("Name the conversation and whether it is read.")),
  );
  const runtime = yield* InboxRuntime;
  const key = { channelId: input.channelId, conversationId: input.conversationId };
  if (input.read) runtime.store.markConversationRead(key, input.lastMessageAt);
  else runtime.store.pinConversationUnread(key);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

const SeenInput = Schema.Struct({
  channelId: Schema.String,
  delegationId: Schema.String,
  /** The run end the client showed. */
  runCompletedAt: Timestamp,
});
const decodeSeenInput = Schema.decodeUnknownEffect(SeenInput);

/** The user looked at the delegation's result. */
export const markSeen = Effect.fn("ForkInbox.markSeen")(function* (body: unknown) {
  const input = yield* decodeSeenInput(body).pipe(
    Effect.mapError(() => badRequest("Name the delegation and the run end it showed.")),
  );
  const runtime = yield* InboxRuntime;
  runtime.store.markAgentSeen(input.delegationId, input.runCompletedAt);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

const SettleInput = Schema.Struct({
  channelId: Schema.String,
  delegationId: Schema.String,
  settled: Schema.Boolean,
});
const decodeSettleInput = Schema.decodeUnknownEffect(SettleInput);

/**
 * Marks a delegation done, or open again. Settling also settles its thread, as finished work does
 * in the sidebar; reopening leaves the thread alone, since writing to it wakes it anyway.
 */
export const settle = Effect.fn("ForkInbox.settle")(function* (body: unknown) {
  const input = yield* decodeSettleInput(body).pipe(
    Effect.mapError(() => badRequest("Name the delegation and whether it is settled.")),
  );
  const runtime = yield* InboxRuntime;
  const delegation = runtime.store.getDelegation(input.delegationId);
  if (delegation === null || delegation.channelId !== input.channelId) {
    return yield* badRequest("There is no such delegation.");
  }
  runtime.store.setSettled(
    delegation.id,
    input.settled ? DateTime.formatIso(yield* DateTime.now) : null,
  );
  const active = activeLinkOf(runtime.store.linksForDelegation(delegation.id));
  if (input.settled && active !== undefined) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads
      .settleThread({
        threadId: ThreadId.make(active.threadId),
        commandId: CommandId.make(`fork-inbox:settle:${NodeCrypto.randomUUID()}`),
        byOwnAgent: false,
      })
      .pipe(Effect.ignore);
  }
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

const ReadAllInput = Schema.Struct({
  channelId: Schema.String,
  /** The newest message or run end the client showed, so nothing it did not show is cleared. */
  before: Timestamp,
});
const decodeReadAllInput = Schema.decodeUnknownEffect(ReadAllInput);

export const markAllRead = Effect.fn("ForkInbox.markAllRead")(function* (body: unknown) {
  const input = yield* decodeReadAllInput(body).pipe(
    Effect.mapError(() => badRequest("Name the channel and a time.")),
  );
  const runtime = yield* InboxRuntime;
  runtime.store.markAllRead(input.channelId, input.before);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

type Providers = Effect.Success<ProviderRegistry.ProviderRegistry["Service"]["getProviders"]>;

/** With no default set, a new thread takes the first ready provider's default model. */
export function firstProviderDefault(providers: Providers): ModelSelection | null {
  const provider = providers.find(
    (candidate) =>
      candidate.enabled &&
      candidate.installed &&
      isProviderAvailable(candidate) &&
      candidate.models.length > 0,
  );
  if (!provider) return null;
  const model =
    provider.models.find((candidate) => candidate.isDefault && !candidate.isCustom) ??
    provider.models.find((candidate) => !candidate.isCustom) ??
    provider.models[0]!;
  return { instanceId: provider.instanceId, model: model.slug };
}

const projectDefaults = Effect.fn("ForkInbox.projectDefaults")(function* (
  project: OrchestrationProjectShell,
) {
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
  );
  const providers = yield* ProviderRegistry.ProviderRegistry.pipe(
    Effect.flatMap((registry) => registry.getProviders),
  );
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  const selection =
    resolveNewThreadModelSelection({
      defaultSelection: resolved.defaultModelSelection,
      fallbackSelection: resolved.fallbackModelSelection,
      providers,
      settings: resolved,
      projectId: project.id,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    }).selection ?? firstProviderDefault(providers);
  return { selection, runtimeMode: resolved.defaultRuntimeMode, providers };
});

const AnchorInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  anchorMessageId: Schema.String,
});
const decodeAnchorInput = Schema.decodeUnknownEffect(AnchorInput);

export const delegateOptions = Effect.fn("ForkInbox.delegateOptions")(function* (
  query: URLSearchParams,
) {
  const key = yield* decodeAnchorInput(Object.fromEntries(query)).pipe(
    Effect.mapError(() => badRequest("Name the channel, conversation, and message.")),
  );
  const runtime = yield* InboxRuntime;
  const channel = yield* channelOrMissing(key.channelId);
  const delegationId = delegationIdFor(key);
  const projects = yield* activeProjects;
  const matches = matchProjectPaths(channel.config?.defaultProjectPaths ?? [], projects);
  const defaults = yield* Effect.forEach(projects, (project) =>
    projectDefaults(project).pipe(
      Effect.map((value) => [project.id, value.selection] as const),
      Effect.orElseSucceed(() => [project.id, null] as const),
    ),
  );
  const links = runtime.store.linksForDelegation(delegationId);
  const lastProjectId = links[0]?.projectId ?? null;
  const active = activeLinkOf(links);
  const existing = active ? yield* inspectLink(active, { current: true }) : null;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const lastShell = links[0]
    ? yield* threads
        .getThreadShell(ThreadId.make(links[0].threadId))
        .pipe(Effect.orElseSucceed(() => null))
    : null;
  return {
    delegationId,
    scope: runtime.store.getDelegation(delegationId)?.scope ?? null,
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModel: defaults.find(([id]) => id === project.id)?.[1] ?? null,
    })),
    // Another thread for this delegation most likely belongs where the last one ran.
    defaultProjectId:
      projects.find((project) => project.id === lastProjectId)?.id ??
      matches.find((match) => match.projectId !== null)?.projectId ??
      null,
    // The last thread's checkout: a new worktree once made is the place to continue.
    defaultWorkspaceStrategy: (lastShell?.worktreePath && lastShell.deletedAt === null
      ? { type: "existing_worktree", worktreePath: lastShell.worktreePath }
      : { type: "root" }) satisfies WorkspaceStrategy,
    existing: isCurrent(existing) ? existing : null,
  };
});

const DelegateInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  /** For a chain, the root of the reply thread; the client picks it from the message. */
  anchorMessageId: Schema.String,
  /** The message the user delegated from, inside a chain's thread; its sender gets the reaction. */
  pickedMessageId: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.Literals(["chain", "range"]),
  /** A range's last message; the newest one when left out. */
  untilMessageId: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.String,
  /** What the agent should do; a default request when blank. */
  note: Schema.optional(Schema.String),
  modelSelection: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /** Where the thread works; the project checkout when left out. */
  workspaceStrategy: Schema.optional(Schema.NullOr(Schema.Unknown)),
  /** Start another thread in place of this linked one; ignored once another took its place. */
  replaceThreadId: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeDelegateInput = Schema.decodeUnknownEffect(DelegateInput);

const downloadImages = Effect.fn("ForkInbox.downloadImages")(function* (
  channelId: string,
  contextDir: string,
  messages: ReadonlyArray<MessageType>,
) {
  const { hub } = yield* InboxRuntime;
  const mediaDir = NodePath.join(contextDir, MEDIA_DIR);
  const wanted = messages.flatMap((message) =>
    message.attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({ message, attachment })),
  );
  if (wanted.length > 0) yield* Effect.promise(() => NodeFSP.mkdir(mediaDir, { recursive: true }));
  return yield* Effect.forEach(
    wanted,
    ({ message, attachment }) =>
      attempt(async (): Promise<ContextImage> => {
        const response = await hub.getMedia(
          channelId,
          `/media/${enc(message.id)}/${enc(attachment.key)}`,
        );
        const filePath = NodePath.join(
          mediaDir,
          mediaFileName(message.id, attachment.key, response.contentType),
        );
        await NodeFSP.writeFile(filePath, response.body);
        return { messageId: message.id, key: attachment.key, path: filePath };
      }).pipe(
        Effect.orElseSucceed((): ContextImage => ({
          messageId: message.id,
          key: attachment.key,
          path: null,
        })),
      ),
    { concurrency: 3 },
  );
});

interface DelegatedThread {
  readonly threadId: string;
  readonly projectId: string;
}

const delegateLocks = new Map<string, Semaphore.Semaphore>();

/**
 * One launch per delegation at a time: the linked-thread check and the launch run under its
 * lock, so two clicks never start two paid threads that share a folder. A replacement goes
 * ahead only while `replaceThreadId` is still the linked thread.
 */
export function delegateExclusively<E1, R1, E2, R2>(input: {
  readonly key: string;
  readonly replaceThreadId: string | null;
  readonly current: Effect.Effect<DelegatedThread | null, E1, R1>;
  readonly start: (replacing: DelegatedThread | null) => Effect.Effect<DelegatedThread, E2, R2>;
}): Effect.Effect<DelegatedThread & { readonly existing: boolean }, E1 | E2, R1 | R2> {
  let lock = delegateLocks.get(input.key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    delegateLocks.set(input.key, lock);
  }
  return lock
    .withPermit(
      Effect.gen(function* () {
        const current = yield* input.current;
        if (current !== null && current.threadId !== input.replaceThreadId) {
          return { ...current, existing: true };
        }
        const started = yield* input.start(current);
        return { ...started, existing: false };
      }),
    )
    .pipe(Effect.withSpan("ForkInbox.delegateExclusively"));
}

const clipPreview = (message: MessageType | undefined) =>
  Array.from(
    (message?.richSummary || message?.text.trim() || message?.attachments[0]?.name || "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, PREVIEW_CHARS)
    .join("");

/** The messages a new delegation covers, read now, with the range's end fixed. */
const readNewScope = Effect.fn("ForkInbox.readNewScope")(function* (
  input: typeof DelegateInput.Type,
) {
  if (input.scope === "chain") {
    const chain = yield* readChain(input.channelId, input.conversationId, input.anchorMessageId, {
      cacheMs: 0,
    });
    // A thread that sees only part of the thread would answer from half a conversation.
    if (!chain.complete) {
      return yield* new ForkHttpError({
        status: 422,
        code: "scope_too_long",
        detail: `This reply thread is longer than the ${MESSAGE_PAGES} pages T3 Code reads, so it cannot be delegated.`,
      });
    }
    return { ...chain, untilAt: null };
  }
  const back = yield* readBackTo(input.channelId, input.conversationId, input.anchorMessageId, {
    cacheMs: 0,
  });
  if (!back.found) {
    return yield* new ForkHttpError({
      status: 422,
      code: "scope_too_long",
      detail: `That message is older than the ${RANGE_PAGES} pages T3 Code reads back, so it cannot be delegated.`,
    });
  }
  const all = messagesInRange(back.messages, input.anchorMessageId, null);
  const until =
    input.untilMessageId === undefined || input.untilMessageId === null
      ? all.length - 1
      : all.findIndex((message) => message.id === input.untilMessageId);
  if (until === -1) {
    return yield* badRequest("The last message must come after the first.", "untilMessageId");
  }
  const messages = all.slice(0, until + 1);
  return {
    messages,
    complete: true,
    rootMissing: false,
    skipped: back.skipped,
    stale: back.stale,
    untilAt: messages.at(-1)?.createdAt ?? null,
  };
});

/** Shows the sender the request was taken; a failure is logged and never fails the delegation. */
const acknowledge = Effect.fn("ForkInbox.acknowledge")(function* (
  channelId: string,
  conversationId: string,
  message: MessageType | undefined,
  config: ChannelView["config"],
) {
  const key = config?.ackReaction;
  if (!key || message === undefined) return;
  // Some chat apps toggle a reaction: adding the user's own again would take it away.
  if (message.reactions?.some((reaction) => reaction.key === key && reaction.includesSelf)) return;
  const { hub } = yield* InboxRuntime;
  yield* attempt(() =>
    hub.postJson(channelId, "/reactions", { conversationId, messageId: message.id, key }),
  ).pipe(
    Effect.catch((error: ForkHttpError) =>
      Effect.logWarning("The adapter did not add the delegation's reaction.", {
        channelId,
        code: error.code,
      }),
    ),
  );
});

export const delegate = Effect.fn("ForkInbox.delegate")(function* (body: unknown) {
  const input = yield* decodeDelegateInput(body).pipe(
    Effect.mapError(() => badRequest("The delegation is missing fields.")),
  );
  const runtime = yield* InboxRuntime;
  const channel = yield* channelOrMissing(input.channelId);
  const listing = yield* readChannel(input.channelId);
  const conversation = listing.raw.find((candidate) => candidate.id === input.conversationId);
  if (conversation === undefined) {
    return yield* new ForkHttpError({
      status: 404,
      code: "missing",
      detail:
        listing.truncatedAtPages === null
          ? "This conversation is no longer listed by the channel."
          : `This conversation is not in the first ${listing.truncatedAtPages} pages the channel lists.`,
    });
  }
  const delegationId = delegationIdFor(input);

  const current = Effect.gen(function* () {
    const active = activeLinkOf(runtime.store.linksForDelegation(delegationId));
    if (!active) return null;
    const view = yield* inspectLink(active, { current: true });
    return isCurrent(view) ? { threadId: view.threadId, projectId: view.projectId } : null;
  });

  const start = Effect.fn("ForkInbox.startDelegation")(function* (
    replacing: DelegatedThread | null,
  ) {
    const scoped = yield* readNewScope(input);
    if (scoped.messages.length === 0) {
      return yield* new ForkHttpError({
        status: 422,
        code: "missing",
        detail: "The channel has none of these messages any more.",
      });
    }
    const projects = yield* activeProjects;
    const project = projects.find((candidate) => candidate.id === input.projectId);
    if (!project) return yield* badRequest("Choose a project in this environment.", "projectId");
    const defaults = yield* projectDefaults(project).pipe(Effect.mapError(toForkError));
    const modelSelection =
      input.modelSelection === undefined || input.modelSelection === null
        ? defaults.selection
        : yield* decodeModelSelection(input.modelSelection).pipe(
            Effect.mapError(() => badRequest("The model is not valid.", "modelSelection")),
          );
    if (modelSelection === null) {
      return yield* badRequest("This project has no default model; choose one.", "modelSelection");
    }
    const workspaceStrategy: WorkspaceStrategy =
      input.workspaceStrategy === undefined || input.workspaceStrategy === null
        ? { type: "root" }
        : yield* decodeWorkspaceStrategy(input.workspaceStrategy).pipe(
            Effect.mapError(() => badRequest("The workspace is not valid.", "workspaceStrategy")),
          );
    if (workspaceStrategy.type === "existing_worktree") {
      const isDirectory = yield* Effect.promise(() =>
        NodeFSP.stat(workspaceStrategy.worktreePath).then(
          (stat) => stat.isDirectory(),
          () => false,
        ),
      );
      if (!isDirectory) {
        return yield* badRequest("That checkout does not exist.", "workspaceStrategy");
      }
    }
    const runtimeMode = yield* resolveRuntimeMode(defaults.runtimeMode, undefined, {
      modelSelection,
      supportedRuntimeModes: defaults.providers.find(
        (provider) => provider.instanceId === modelSelection.instanceId,
      )?.supportedRuntimeModes,
    }).pipe(Effect.orElseSucceed(() => defaults.runtimeMode));

    const commandId = CommandId.make(`fork-inbox:${NodeCrypto.randomUUID()}`);
    const threadId = ThreadId.make(commandId);
    const contextDir = threadContextDir(runtime.itemsDir, delegationId, threadId);
    yield* Effect.promise(() => NodeFSP.mkdir(contextDir, { recursive: true }));
    const images = yield* downloadImages(input.channelId, contextDir, scoped.messages);
    const anchor = scoped.messages.find((message) => message.id === input.anchorMessageId);
    const preview = clipPreview(anchor ?? scoped.messages[0]);
    const picked = scoped.messages.find(
      (message) => message.id === (input.pickedMessageId ?? input.anchorMessageId),
    );
    const request =
      picked !== undefined && !picked.author.isSelf
        ? picked
        : scoped.messages.find((message) => !message.author.isSelf);
    const sender = request?.author ?? scoped.messages[0]!.author;
    const since = (yield* Clock.currentTimeMillis) - SENDER_HISTORY_MS;
    const senderHistory = listing.conversations
      .filter(
        (candidate) =>
          candidate.id !== conversation.id &&
          candidate.lastMessage !== null &&
          candidate.lastMessage.author.id === sender.id &&
          Date.parse(candidate.lastMessage.createdAt) >= since,
      )
      .slice(0, 20)
      .map((candidate) => ({
        at: candidate.lastMessage!.createdAt,
        conversationName: candidate.name,
        preview: candidate.lastMessage!.preview.slice(0, 160),
        state: candidate.unread ? "unread" : "read",
      }));
    const openUrl =
      anchor?.openUrl ?? scoped.messages.find((message) => message.openUrl)?.openUrl ?? null;
    const channelName = channel.config?.displayName ?? channel.name;
    const context = buildContextMarkdown({
      channelName,
      conversation,
      messages: scoped.messages,
      images,
      senderName: sender.name,
      senderHistory,
      openUrl,
      skippedMessages: scoped.skipped,
      rootMissing: scoped.rootMissing,
    });
    const text = firstMessage({
      contextDir,
      request: input.note ?? "",
      openUrl,
      skippedMessages: scoped.skipped,
      markdown: supports(channel, "markdown"),
    });
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.promise(() =>
      Promise.all([
        NodeFSP.writeFile(NodePath.join(contextDir, CONTEXT_FILE), context),
        NodeFSP.writeFile(
          NodePath.join(contextDir, REQUEST_FILE),
          prettyJson({
            requestedAt,
            channelId: input.channelId,
            conversationId: input.conversationId,
            anchorMessageId: input.anchorMessageId,
            scope: input.scope,
            untilAt: scoped.untilAt,
            projectId: project.id,
            note: input.note ?? "",
            modelSelection,
            runtimeMode,
            workspaceStrategy,
            threadId,
            replacesThreadId: replacing?.threadId ?? null,
          }),
        ),
      ]),
    );
    const result = yield* ThreadMessageIntake.launchThread({
      commandId,
      threadId,
      projectId: ProjectId.make(project.id),
      // Adapters may not know the sender's name; the conversation's is the next best label.
      title: threadTitle(sender.name.trim() || nameOrUnknown(conversation.name), preview),
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      workspaceStrategy,
      initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
      createdBy: "user",
      creationSource: "server",
    }).pipe(
      Effect.mapError(toForkError),
      Effect.tapError(() =>
        Effect.promise(() => NodeFSP.rm(contextDir, { recursive: true, force: true })),
      ),
    );
    const at = DateTime.formatIso(yield* DateTime.now);
    runtime.store.saveDelegation({
      id: delegationId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      anchorMessageId: input.anchorMessageId,
      scope: input.scope,
      untilAt: scoped.untilAt,
      preview,
      createdAt: at,
    });
    runtime.store.addLink({
      delegationId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      threadId: result.threadId,
      projectId: project.id,
      createdAt: at,
    });
    if (replacing !== null) {
      runtime.store.detachLink(delegationId, replacing.threadId, "replaced", at);
    } else {
      yield* acknowledge(input.channelId, input.conversationId, request, channel.config);
    }
    return { threadId: result.threadId, projectId: project.id };
  });

  const result = yield* delegateExclusively({
    key: delegationId,
    replaceThreadId: input.replaceThreadId ?? null,
    current,
    start,
  });
  if (!result.existing) runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ...result, delegationId };
});

const SendInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  /** The adapter sends it into this message's reply thread. */
  replyToId: Schema.optional(Schema.String),
  /** With `replyToId`: false quotes it on the timeline instead, for an adapter that takes quotes. */
  inThread: Schema.optional(Schema.Boolean),
  /** The delegation whose draft this is; a copy of what was sent goes into its folder. */
  delegationId: Schema.optional(Schema.String),
  text: Schema.String,
  mentions: Schema.optional(Schema.Array(Mention)),
  format: Schema.optional(Schema.Literals(["text", "markdown"])),
  /** Files uploaded before; `name` is only for telling the user which one failed. */
  attachments: Schema.optional(
    Schema.Array(Schema.Struct({ uploadId: Schema.String, name: Schema.String })),
  ),
});
const decodeSendInput = Schema.decodeUnknownEffect(SendInput);

const SEND_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_logged_in: "The adapter is not signed in.",
  rate_limited: "The chat app is limiting sends; try again shortly.",
  rejected: "The chat app refused the message.",
};

const MAX_MENTIONS = 20;
const MAX_ATTACHMENTS = 9;
/** The adapter's own limit; a larger file is refused before it is read. */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

type Capability = "mentions" | "markdown" | "attachments" | "quotes";
const supports = (channel: ChannelView, capability: Capability) =>
  channel.config?.capabilities?.includes(capability) ?? false;

/** The adapter replaces each `@name` literally, so a name stands for one person and is in the text. */
function mentionsToSend(text: string, mentions: ReadonlyArray<Mention>): ReadonlyArray<Mention> {
  const ids = new Set<string>();
  const names = new Set<string>();
  return mentions
    .filter(({ userId, name }) => {
      if (userId.length === 0 || name.length === 0 || !text.includes(`@${name}`)) return false;
      if (ids.has(userId) || names.has(name)) return false;
      ids.add(userId);
      names.add(name);
      return true;
    })
    .slice(0, MAX_MENTIONS);
}

export const send = Effect.fn("ForkInbox.send")(function* (body: unknown) {
  const input = yield* decodeSendInput(body).pipe(
    Effect.mapError(() => badRequest("The message is missing fields.")),
  );
  const text = input.text.trim();
  const runtime = yield* InboxRuntime;
  const channel = yield* channelOrMissing(input.channelId);
  const attachments = input.attachments ?? [];
  if (attachments.length > 0 && !supports(channel, "attachments")) {
    return yield* badRequest("This channel cannot send files.", "attachments");
  }
  if (
    attachments.length > MAX_ATTACHMENTS ||
    new Set(attachments.map((attachment) => attachment.uploadId)).size !== attachments.length
  ) {
    return yield* badRequest(`Attach up to ${MAX_ATTACHMENTS} different files.`, "attachments");
  }
  if ((text.length === 0 && attachments.length === 0) || text.length > 20_000) {
    return yield* badRequest("Write a message of up to 20,000 characters.", "text");
  }
  const mentions = supports(channel, "mentions") ? mentionsToSend(text, input.mentions ?? []) : [];
  const markdown = input.format === "markdown" && supports(channel, "markdown");
  const delegation =
    input.delegationId === undefined ? null : runtime.store.getDelegation(input.delegationId);
  const delegationId =
    delegation !== null && delegation.channelId === input.channelId ? delegation.id : null;
  const active =
    delegationId === null
      ? undefined
      : activeLinkOf(runtime.store.linksForDelegation(delegationId));
  const draftDir =
    delegationId !== null && active
      ? threadContextDir(runtime.itemsDir, delegationId, active.threadId)
      : null;
  const draftAtSend =
    draftDir === null ? null : (yield* Effect.promise(() => readArtifacts(draftDir))).draft;
  const answer = yield* attempt(() =>
    runtime.hub.postJson(input.channelId, "/messages", {
      conversationId: input.conversationId,
      ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }),
      ...(input.replyToId !== undefined &&
      input.inThread !== undefined &&
      supports(channel, "quotes")
        ? { inThread: input.inThread }
        : {}),
      text,
      ...(mentions.length === 0 ? {} : { mentions }),
      ...(markdown ? { format: "markdown" } : {}),
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map(({ uploadId }) => ({ uploadId })) }),
    }),
  ).pipe(
    Effect.mapError((error) =>
      error.status === 502 && SEND_ERROR_MESSAGES[error.code]
        ? new ForkHttpError({
            ...error,
            detail: `${SEND_ERROR_MESSAGES[error.code]} ${error.detail}`,
          })
        : error,
    ),
  );
  runtime.hub.invalidate(input.channelId);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  const result = decodeSendResultOption(answer);
  if (result._tag === "None" || result.value.messageId.trim().length === 0) {
    // It may have gone out; sending again could post it twice, so nothing is cleared.
    return yield* new ForkHttpError({
      status: 502,
      code: "delivery_unknown",
      detail:
        "The adapter took the message but did not confirm it was sent. Check the chat before sending again; the draft is kept.",
    });
  }
  const messageId = result.value.messageId;
  const unresolved = idsIn(answer, "unresolvedMentions");
  const failed = idsIn(answer, "failedAttachments");
  const outcome = {
    messageId,
    /** Names whose mention went out as plain text: nobody was notified for these. */
    unresolvedMentions: mentions
      .filter((mention) => unresolved.has(mention.userId))
      .map((mention) => mention.name),
    /** Names of the files that did not go out; the text and the other files did. */
    failedAttachments: attachments
      .filter((attachment) => failed.has(attachment.uploadId))
      .map((attachment) => attachment.name),
  };
  if (delegationId === null) return { ...outcome, archived: null };
  // The message went out either way; a failed copy is reported, never retried by resending.
  const sentAt = DateTime.formatIso(yield* DateTime.now);
  const archived = yield* Effect.promise(() =>
    recordSent({
      itemDir: NodePath.join(runtime.itemsDir, delegationId),
      draftDir,
      draftAtSend,
      text,
      files: attachments.map((attachment) => attachment.name),
      messageId,
      sentAt,
    }).then(
      () => true,
      () => false,
    ),
  );
  return { ...outcome, archived };
});

/** Hands the adapter a file to attach to a later send. */
export const upload = Effect.fn("ForkInbox.upload")(function* (
  query: URLSearchParams,
  bytes: Uint8Array,
) {
  const channelId = query.get("channelId");
  const name = query.get("name")?.trim() ?? "";
  if (channelId === null || name.length === 0) {
    return yield* badRequest("Name the channel and the file.");
  }
  const channel = yield* channelOrMissing(channelId);
  if (!supports(channel, "attachments")) {
    return yield* badRequest("This channel cannot send files.");
  }
  if (bytes.byteLength === 0) return yield* badRequest("The file is empty.");
  const { hub } = yield* InboxRuntime;
  const answer = yield* attempt(() => hub.upload(channelId, `/uploads?name=${enc(name)}`, bytes));
  const uploaded = decodeUpload(answer);
  if (uploaded._tag === "None") {
    return yield* new ForkHttpError({
      status: 502,
      code: "upload_failed",
      detail: "The adapter did not confirm the upload.",
    });
  }
  return uploaded.value;
});

const DiscardDraftInput = Schema.Struct({
  channelId: Schema.String,
  delegationId: Schema.String,
  /** The draft the client showed. */
  draft: Schema.String,
});
const decodeDiscardDraftInput = Schema.decodeUnknownEffect(DiscardDraftInput);

/** Drops the current thread's draft; "Draft reply" asks for a new one. */
export const discardDraft = Effect.fn("ForkInbox.discardDraft")(function* (body: unknown) {
  const input = yield* decodeDiscardDraftInput(body).pipe(
    Effect.mapError(() => badRequest("Name the delegation and its draft.")),
  );
  const runtime = yield* InboxRuntime;
  const delegation = runtime.store.getDelegation(input.delegationId);
  const active =
    delegation !== null && delegation.channelId === input.channelId
      ? activeLinkOf(runtime.store.linksForDelegation(delegation.id))
      : undefined;
  if (active === undefined) return yield* badRequest("This delegation has no thread.");
  const discardedAt = DateTime.formatIso(yield* DateTime.now);
  const discarded = yield* Effect.promise(() =>
    discardDraftFile(
      threadContextDir(runtime.itemsDir, input.delegationId, active.threadId),
      input.draft,
      discardedAt,
    ),
  );
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { discarded };
});
