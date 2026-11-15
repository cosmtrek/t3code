// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Context folders are plain files an agent writes; timestamps are wall-clock ISO strings for humans.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  isProviderAvailable,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
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
  type ChannelView,
} from "../channels/hub.ts";
import {
  Conversation,
  Message,
  SendResult,
  Timestamp,
  Topic,
  type Conversation as ConversationType,
  type Message as MessageType,
  type Topic as TopicType,
} from "../channels/protocol.ts";
import {
  applyFallback,
  fallbackApplied,
  readArtifacts,
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
  parseFallbackReply,
  threadTitle,
  type ContextImage,
} from "./context.ts";
import {
  compareItems,
  deriveItem,
  itemIdFor,
  PENDING_STATES,
  sortMessages,
  type DerivedItem,
  type ItemState,
} from "./derive.ts";
import { InboxRuntime } from "./InboxRuntime.ts";
import type { Link, MarkState, TopicKey } from "./store.ts";

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
const TOPIC_LIMIT = 200;
const MESSAGE_LIMIT = 200;
/** Page caps: far above a real inbox, low enough that a looping adapter cannot hang a request. */
const CONVERSATION_PAGES = 20;
const TOPIC_PAGES = 5;
const MESSAGE_PAGES = 50;
const SENDER_HISTORY_MS = 7 * 24 * 3_600_000;

const decodeSendResultOption = Schema.decodeUnknownOption(SendResult);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

const enc = encodeURIComponent;
const conversationsPath = `/conversations?relevant=1&limit=${CONVERSATION_LIMIT}`;
const topicsPath = (conversationId: string) =>
  `/conversations/${enc(conversationId)}/topics?limit=${TOPIC_LIMIT}`;
const messagesPath = (conversationId: string, topicId: string) =>
  `/conversations/${enc(conversationId)}/messages?topic=${enc(topicId)}&limit=${MESSAGE_LIMIT}`;

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
  readonly createdAt: string;
  readonly detachedAt: string | null;
}

const RUNNING = new Set<string>(ThreadManagement.ACTIVE_RUN_STATUSES);

function threadStatus(shell: OrchestrationV2ThreadShell): LinkedThreadStatus {
  if (shell.archivedAt !== null) return "archived";
  return shell.activeRunId !== null || RUNNING.has(shell.status) ? "running" : "idle";
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
  const reply = last ? parseFallbackReply(last.text) : { conclusion: null, draft: null };
  yield* Effect.promise(() => applyFallback(contextDir, runId, reply).catch(() => undefined));
});

/**
 * The link's thread as it is now. A thread that no longer exists detaches the link. Only the
 * item's current link fills its folder from tags; older ones are history and stay as they are.
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
    return { ...base, title: null, status: "deleted" } satisfies LinkedThreadView;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(ThreadId.make(link.threadId))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (shell === undefined)
    return { ...base, title: null, status: "unknown" } satisfies LinkedThreadView;
  if (shell === null || shell.deletedAt !== null) {
    const at = link.detachedAt ?? new Date().toISOString();
    if (link.detachedAt === null) {
      runtime.store.detachLink(link.itemId, link.threadId, "deleted", at);
    }
    return { ...base, detachedAt: at, title: null, status: "deleted" } satisfies LinkedThreadView;
  }
  if (options.current && link.detachedAt === null) {
    yield* applyFallbackFor(threadContextDir(runtime.itemsDir, link.itemId, link.threadId), shell);
  }
  return { ...base, title: shell.title, status: threadStatus(shell) } satisfies LinkedThreadView;
});

/** The newest link still attached; older ones were replaced or lost their thread. */
const activeLinkOf = (links: ReadonlyArray<Link>) => links.find((link) => link.detachedAt === null);

const isCurrent = (thread: LinkedThreadView | null): thread is LinkedThreadView =>
  thread !== null && thread.detachedAt === null && thread.status !== "deleted";

export interface InboxItem extends DerivedItem {
  readonly id: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly conversationKind: ConversationType["kind"];
  readonly topicId: string;
  readonly rootMessageId: string;
  readonly preview: string;
  readonly replyCount: number;
  readonly lastMessageAt: string;
  readonly lastAuthor: TopicType["lastAuthor"];
  readonly participatedBySelf: boolean;
  readonly mark: { readonly state: MarkState; readonly markedAt: string } | null;
  readonly thread: LinkedThreadView | null;
  readonly hasConclusion: boolean;
  readonly hasDraft: boolean;
}

const readMessages = Effect.fn("ForkInbox.readMessages")(function* (
  channelId: string,
  conversationId: string,
  topicId: string,
  options: { readonly cacheMs?: number } = {},
) {
  const { hub } = yield* InboxRuntime;
  const result = yield* attempt(() =>
    hub.getAllPages(channelId, messagesPath(conversationId, topicId), Message, {
      ...options,
      maxPages: MESSAGE_PAGES,
    }),
  );
  yield* warnSkipped(channelId, "messages", result.skipped);
  return { ...result, items: sortMessages(result.items) };
});

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

interface ChannelItems {
  readonly items: ReadonlyArray<InboxItem>;
  readonly stale: boolean;
  /** The page cap a list hit before it ended; null when every list was read to its end. */
  readonly truncatedAtPages: number | null;
  /** Conversations and topics left out because they did not decode. */
  readonly skipped: number;
  readonly conversations: ReadonlyArray<ConversationType>;
}

const readChannelItems = Effect.fn("ForkInbox.readChannelItems")(function* (channelId: string) {
  const runtime = yield* InboxRuntime;
  const { hub, store } = runtime;
  const conversations = yield* attempt(() =>
    hub.getAllPages(channelId, conversationsPath, Conversation, {
      maxPages: CONVERSATION_PAGES,
    }),
  );
  let stale = conversations.stale;
  let topicsTruncated = false;
  let skipped = conversations.skipped;
  const marks = new Map(store.listMarks(channelId).map((mark) => [itemIdFor(mark), mark] as const));
  const linksByItem = new Map<string, Link[]>();
  // Newest first, so each item's list starts with its latest link.
  for (const link of store.listLinks(channelId)) {
    const list = linksByItem.get(link.itemId) ?? [];
    list.push(link);
    linksByItem.set(link.itemId, list);
  }
  const now = Date.now();
  const perConversation = yield* Effect.forEach(
    conversations.items,
    (conversation) =>
      Effect.gen(function* () {
        const topics = yield* attempt(() =>
          hub.getAllPages(channelId, topicsPath(conversation.id), Topic, {
            maxPages: TOPIC_PAGES,
          }),
        ).pipe(Effect.orElseSucceed(() => null));
        if (topics === null) return [];
        if (topics.stale) stale = true;
        if (!topics.complete) topicsTruncated = true;
        skipped += topics.skipped;
        return yield* Effect.forEach(
          topics.items,
          (topic) =>
            Effect.gen(function* () {
              const key: TopicKey = {
                channelId,
                conversationId: conversation.id,
                topicId: topic.id,
              };
              const id = itemIdFor(key);
              const storedMark = marks.get(id) ?? null;
              const links = linksByItem.get(id) ?? [];
              const shown = activeLinkOf(links) ?? links[0];
              const thread = shown
                ? yield* inspectLink(shown, { current: shown.detachedAt === null })
                : null;
              const artifacts = thread
                ? yield* Effect.promise(() =>
                    readArtifacts(threadContextDir(runtime.itemsDir, id, thread.threadId)),
                  )
                : { conclusion: null, draft: null };
              // A deleted or replaced thread's draft is history: it no longer drives the state.
              const hasDraft = isCurrent(thread) && artifacts.draft !== null;
              const derived = deriveItem({
                conversation,
                topic,
                mentionsSelf: topic.mentionsSelfSinceOwn,
                lastOtherMessageAt: topic.lastOtherMessageAt,
                mark: storedMark,
                threadRunning: thread?.status === "running",
                hasDraft,
                now,
              });
              // Someone wrote after the mark: the mark is spent, and the state follows messages.
              if (derived.reopened) store.clearMark(key);
              const mark = derived.reopened ? null : storedMark;
              return {
                ...derived,
                id,
                channelId,
                conversationId: conversation.id,
                conversationName: conversation.name,
                conversationKind: conversation.kind,
                topicId: topic.id,
                rootMessageId: topic.rootMessageId,
                preview: topic.rootPreview,
                replyCount: topic.replyCount,
                lastMessageAt: topic.lastMessageAt,
                lastAuthor: topic.lastAuthor,
                participatedBySelf: topic.participatedBySelf,
                mark: mark ? { state: mark.state, markedAt: mark.markedAt } : null,
                thread,
                hasConclusion: artifacts.conclusion !== null,
                hasDraft,
              } satisfies InboxItem;
            }),
          { concurrency: 4 },
        );
      }),
    { concurrency: 4 },
  );
  const items = perConversation.flat().toSorted(compareItems);
  yield* warnSkipped(channelId, "conversations and topics", skipped);
  return {
    items,
    stale,
    truncatedAtPages: !conversations.complete
      ? CONVERSATION_PAGES
      : topicsTruncated
        ? TOPIC_PAGES
        : null,
    skipped,
    conversations: conversations.items,
  } satisfies ChannelItems;
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
  readonly pendingCount: number | null;
  readonly error: string | null;
}

/** Enabled channels with their state; the sidebar badge sums `pendingCount`. */
export const overview = Effect.fn("ForkInbox.overview")(function* () {
  const { hub } = yield* InboxRuntime;
  const channels = hub.list().filter((channel) => channel.enabled);
  const summaries = yield* Effect.forEach(
    channels,
    (channel) =>
      Effect.gen(function* () {
        const access = channelAccess(channel.status);
        const listing = access.read
          ? yield* readChannelItems(channel.id).pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error: ForkHttpError) =>
                Effect.succeed({ ok: false as const, error: error.detail }),
              ),
            )
          : null;
        return {
          id: channel.id,
          name: channel.config?.displayName ?? channel.name,
          kind: channel.kind,
          status: channel.status,
          statusSince: channel.statusSince,
          lastSyncAt: channel.health?.lastSyncAt ?? null,
          selfName: channel.health?.self.name ?? null,
          access,
          pendingCount:
            listing?.ok === true
              ? listing.result.items.filter((item) => PENDING_STATES.has(item.state)).length
              : null,
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

export const listItems = Effect.fn("ForkInbox.listItems")(function* (channelId: string) {
  const { hub } = yield* InboxRuntime;
  const channel = hub.get(channelId);
  if (channel === null) {
    return yield* new ForkHttpError({ status: 404, code: "missing", detail: "No such channel." });
  }
  const result = yield* readChannelItems(channelId);
  return {
    items: result.items,
    stale: result.stale,
    truncatedAtPages: result.truncatedAtPages,
    skipped: result.skipped,
    access: channelAccess(channel.status),
    status: channel.status,
  };
});

const TopicKeyInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  topicId: Schema.String,
});
const decodeTopicKeyInput = Schema.decodeUnknownEffect(TopicKeyInput);

const findTopic = Effect.fn("ForkInbox.findTopic")(function* (key: TopicKey) {
  const { hub } = yield* InboxRuntime;
  const listing = yield* readChannelItems(key.channelId);
  const item = listing.items.find(
    (candidate) =>
      candidate.conversationId === key.conversationId && candidate.topicId === key.topicId,
  );
  const conversation = listing.conversations.find(
    (candidate) => candidate.id === key.conversationId,
  );
  if (!item || !conversation) {
    return yield* new ForkHttpError({
      status: 404,
      code: "missing",
      detail:
        listing.truncatedAtPages === null
          ? "This topic is no longer listed by the channel."
          : `This topic is not in the first ${listing.truncatedAtPages} pages the channel lists.`,
    });
  }
  return { item, conversation, listing, channel: hub.get(key.channelId)! };
});

export const readTopic = Effect.fn("ForkInbox.readTopic")(function* (query: URLSearchParams) {
  const key = yield* decodeTopicKeyInput(Object.fromEntries(query)).pipe(
    Effect.mapError(() => badRequest("Name the channel, conversation, and topic.")),
  );
  const runtime = yield* InboxRuntime;
  const { item, conversation, channel } = yield* findTopic(key);
  const messages = yield* readMessages(key.channelId, key.conversationId, key.topicId, {
    cacheMs: 5_000,
  });
  const thread = item.thread;
  const artifacts = thread
    ? yield* Effect.promise(() =>
        readArtifacts(threadContextDir(runtime.itemsDir, item.id, thread.threadId)),
      )
    : { conclusion: null, draft: null };
  const current = isCurrent(thread);
  const history = yield* Effect.forEach(
    runtime.store.linksForItem(item.id).filter((link) => link.threadId !== thread?.threadId),
    (link) => inspectLink(link, { current: false }),
  );
  const access = channelAccess(channel.status);
  return {
    item,
    conversation,
    messages: messages.items,
    stale: messages.stale,
    truncatedAtPages: messages.complete ? null : MESSAGE_PAGES,
    skipped: messages.skipped,
    canSend: access.send,
    conclusion: artifacts.conclusion,
    // Only the current thread's draft fills the reply box.
    draft: current ? artifacts.draft : null,
    // A conclusion outlives a deleted thread; the detail shows it as history.
    conclusionIsHistorical: artifacts.conclusion !== null && !current,
    previousThreads: history,
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

const MarkInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  topicId: Schema.String,
  state: Schema.NullOr(Schema.Literals(["done", "ignored"])),
  /** The topic's last message as the client saw it: what was marked is what the user saw. */
  lastMessageAt: Schema.optional(Timestamp),
});
const decodeMarkInput = Schema.decodeUnknownEffect(MarkInput);

/** Without the client's view, only the topic's own conversation is read, not the whole channel. */
const topicLastMessageAt = Effect.fn("ForkInbox.topicLastMessageAt")(function* (key: TopicKey) {
  const { hub } = yield* InboxRuntime;
  const topics = yield* attempt(() =>
    hub.getAllPages(key.channelId, topicsPath(key.conversationId), Topic, {
      maxPages: TOPIC_PAGES,
    }),
  );
  const topic = topics.items.find((candidate) => candidate.id === key.topicId);
  if (!topic) {
    return yield* new ForkHttpError({
      status: 404,
      code: "missing",
      detail: "This topic is no longer listed by the channel.",
    });
  }
  return topic.lastMessageAt;
});

export const mark = Effect.fn("ForkInbox.mark")(function* (body: unknown) {
  const input = yield* decodeMarkInput(body).pipe(
    Effect.mapError(() => badRequest("Name the topic and a state.")),
  );
  const runtime = yield* InboxRuntime;
  if (input.state === null) {
    runtime.store.clearMark(input);
  } else {
    const watermarkMessageAt = input.lastMessageAt ?? (yield* topicLastMessageAt(input));
    runtime.store.setMark({
      channelId: input.channelId,
      conversationId: input.conversationId,
      topicId: input.topicId,
      state: input.state,
      markedAt: new Date().toISOString(),
      watermarkMessageAt,
    });
  }
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

type Providers = Effect.Success<ProviderRegistry.ProviderRegistry["Service"]["getProviders"]>;

/** With no default set, a new thread takes the first ready provider's default model. */
function firstProviderDefault(providers: Providers): ModelSelection | null {
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

export const delegateOptions = Effect.fn("ForkInbox.delegateOptions")(function* (
  query: URLSearchParams,
) {
  const key = yield* decodeTopicKeyInput(Object.fromEntries(query)).pipe(
    Effect.mapError(() => badRequest("Name the channel, conversation, and topic.")),
  );
  const runtime = yield* InboxRuntime;
  const { item, channel } = yield* findTopic(key);
  const projects = yield* activeProjects;
  const matches = matchProjectPaths(channel.config?.defaultProjectPaths ?? [], projects);
  const defaults = yield* Effect.forEach(projects, (project) =>
    projectDefaults(project).pipe(
      Effect.map((value) => [project.id, value.selection] as const),
      Effect.orElseSucceed(() => [project.id, null] as const),
    ),
  );
  const providers = yield* ProviderRegistry.ProviderRegistry.pipe(
    Effect.flatMap((registry) => registry.getProviders),
  );
  const links = runtime.store.linksForItem(item.id);
  const lastProjectId = links[0]?.projectId ?? null;
  const active = activeLinkOf(links);
  const existing = active ? yield* inspectLink(active, { current: true }) : null;
  return {
    itemId: item.id,
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModel: defaults.find(([id]) => id === project.id)?.[1] ?? null,
    })),
    // Another thread for this topic most likely belongs where the last one ran.
    defaultProjectId:
      projects.find((project) => project.id === lastProjectId)?.id ??
      matches.find((match) => match.projectId !== null)?.projectId ??
      null,
    templates: channel.config?.delegateTemplates ?? [],
    providers: providers
      .filter((provider) => provider.enabled && provider.installed)
      .map((provider) => ({
        instanceId: provider.instanceId,
        name: provider.displayName ?? provider.driver,
        models: provider.models.map((model) => ({ slug: model.slug, name: model.name })),
      })),
    existing: isCurrent(existing) ? existing : null,
  };
});

const DelegateInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  topicId: Schema.String,
  projectId: Schema.String,
  templateId: Schema.String,
  note: Schema.optional(Schema.String),
  modelSelection: Schema.optional(Schema.NullOr(Schema.Unknown)),
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
 * One delegation per item at a time: the linked-thread check and the launch run under the item's
 * lock, so two clicks never start two paid threads that share a folder. A replacement goes
 * ahead only while `replaceThreadId` is still the linked thread.
 */
export function delegateExclusively<E1, R1, E2, R2>(input: {
  readonly itemId: string;
  readonly replaceThreadId: string | null;
  readonly current: Effect.Effect<DelegatedThread | null, E1, R1>;
  readonly start: (replacing: DelegatedThread | null) => Effect.Effect<DelegatedThread, E2, R2>;
}): Effect.Effect<DelegatedThread & { readonly existing: boolean }, E1 | E2, R1 | R2> {
  let lock = delegateLocks.get(input.itemId);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    delegateLocks.set(input.itemId, lock);
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

export const delegate = Effect.fn("ForkInbox.delegate")(function* (body: unknown) {
  const input = yield* decodeDelegateInput(body).pipe(
    Effect.mapError(() => badRequest("The delegation is missing fields.")),
  );
  const runtime = yield* InboxRuntime;
  const { item, conversation, listing, channel } = yield* findTopic(input);

  const current = Effect.gen(function* () {
    const active = activeLinkOf(runtime.store.linksForItem(item.id));
    if (!active) return null;
    const view = yield* inspectLink(active, { current: true });
    return isCurrent(view) ? { threadId: view.threadId, projectId: view.projectId } : null;
  });

  const start = Effect.fn("ForkInbox.startDelegation")(function* (
    replacing: DelegatedThread | null,
  ) {
    // The whole topic, every page, oldest first.
    const messages = yield* readMessages(input.channelId, input.conversationId, input.topicId, {
      cacheMs: 0,
    });
    // A thread that sees only part of the topic would answer from half a conversation.
    if (!messages.complete) {
      return yield* new ForkHttpError({
        status: 422,
        code: "topic_too_long",
        detail: `This topic is longer than the ${MESSAGE_PAGES} pages T3 Code reads, so it cannot be delegated.`,
      });
    }
    const template = channel.config?.delegateTemplates.find(
      (candidate) => candidate.id === input.templateId,
    );
    if (!template) return yield* badRequest("Choose one of the adapter's templates.", "templateId");
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
    const runtimeMode = yield* resolveRuntimeMode(defaults.runtimeMode, undefined, {
      modelSelection,
      supportedRuntimeModes: defaults.providers.find(
        (provider) => provider.instanceId === modelSelection.instanceId,
      )?.supportedRuntimeModes,
    }).pipe(Effect.orElseSucceed(() => defaults.runtimeMode));

    const commandId = CommandId.make(`fork-inbox:${NodeCrypto.randomUUID()}`);
    const threadId = ThreadId.make(commandId);
    const contextDir = threadContextDir(runtime.itemsDir, item.id, threadId);
    yield* Effect.promise(() => NodeFSP.mkdir(contextDir, { recursive: true }));
    const images = yield* downloadImages(input.channelId, contextDir, messages.items);
    const sender =
      messages.items.find((message) => !message.author.isSelf)?.author ?? item.lastAuthor;
    const since = Date.now() - SENDER_HISTORY_MS;
    const senderHistory = listing.items
      .filter(
        (candidate) =>
          candidate.id !== item.id &&
          candidate.lastAuthor.id === sender.id &&
          Date.parse(candidate.lastMessageAt) >= since,
      )
      .slice(0, 20)
      .map((candidate) => ({
        at: candidate.lastMessageAt,
        conversationName: candidate.conversationName,
        preview: candidate.preview.slice(0, 160),
        state: candidate.state satisfies ItemState,
      }));
    const openUrl =
      messages.items.find((message) => message.id === item.rootMessageId)?.openUrl ??
      messages.items[0]?.openUrl ??
      null;
    const channelName = channel.config?.displayName ?? channel.name;
    const context = buildContextMarkdown({
      channelName,
      conversation,
      messages: messages.items,
      images,
      senderName: sender.name,
      senderHistory,
      contextDir,
      openUrl,
      skippedMessages: messages.skipped,
    });
    const text = firstMessage({
      template: template.prompt,
      contextDir,
      note: input.note ?? "",
      openUrl,
      skippedMessages: messages.skipped,
    });
    yield* Effect.promise(() =>
      Promise.all([
        NodeFSP.writeFile(NodePath.join(contextDir, CONTEXT_FILE), context),
        NodeFSP.writeFile(
          NodePath.join(contextDir, REQUEST_FILE),
          prettyJson({
            requestedAt: new Date().toISOString(),
            channelId: input.channelId,
            conversationId: input.conversationId,
            topicId: input.topicId,
            projectId: project.id,
            templateId: template.id,
            note: input.note ?? "",
            modelSelection,
            runtimeMode,
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
      title: threadTitle(sender.name.trim() || nameOrUnknown(conversation.name), item.preview),
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
      createdBy: "user",
      creationSource: "server",
    }).pipe(
      Effect.mapError(toForkError),
      Effect.tapError(() =>
        Effect.promise(() => NodeFSP.rm(contextDir, { recursive: true, force: true })),
      ),
    );
    const at = new Date().toISOString();
    runtime.store.addLink({
      itemId: item.id,
      channelId: input.channelId,
      conversationId: input.conversationId,
      topicId: input.topicId,
      threadId: result.threadId,
      projectId: project.id,
      createdAt: at,
    });
    if (replacing !== null) {
      runtime.store.detachLink(item.id, replacing.threadId, "replaced", at);
    }
    return { threadId: result.threadId, projectId: project.id };
  });

  const result = yield* delegateExclusively({
    itemId: item.id,
    replaceThreadId: input.replaceThreadId ?? null,
    current,
    start,
  });
  if (!result.existing) runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return result;
});

const SendInput = Schema.Struct({
  channelId: Schema.String,
  conversationId: Schema.String,
  topicId: Schema.optional(Schema.String),
  text: Schema.String,
});
const decodeSendInput = Schema.decodeUnknownEffect(SendInput);

const SEND_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_logged_in: "The adapter is not signed in.",
  rate_limited: "The chat app is limiting sends; try again shortly.",
  rejected: "The chat app refused the message.",
};

export const send = Effect.fn("ForkInbox.send")(function* (body: unknown) {
  const input = yield* decodeSendInput(body).pipe(
    Effect.mapError(() => badRequest("The message is missing fields.")),
  );
  const text = input.text.trim();
  if (text.length === 0 || text.length > 20_000) {
    return yield* badRequest("Write a message of up to 20,000 characters.", "text");
  }
  const runtime = yield* InboxRuntime;
  const key =
    input.topicId === undefined
      ? null
      : {
          channelId: input.channelId,
          conversationId: input.conversationId,
          topicId: input.topicId,
        };
  const itemId = key === null ? null : itemIdFor(key);
  const active = itemId === null ? undefined : activeLinkOf(runtime.store.linksForItem(itemId));
  const draftDir =
    itemId !== null && active ? threadContextDir(runtime.itemsDir, itemId, active.threadId) : null;
  const draftAtSend =
    draftDir === null ? null : (yield* Effect.promise(() => readArtifacts(draftDir))).draft;
  const answer = yield* attempt(() =>
    runtime.hub.postJson(input.channelId, "/messages", {
      conversationId: input.conversationId,
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      text,
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
  if (key === null || itemId === null) return { messageId, archived: null };
  // The message went out either way; a failed copy is reported, never retried by resending.
  const archived = yield* Effect.promise(() =>
    recordSent({
      itemDir: NodePath.join(runtime.itemsDir, itemId),
      draftDir,
      draftAtSend,
      text,
      messageId,
      sentAt: new Date().toISOString(),
    }).then(
      () => true,
      () => false,
    ),
  );
  runtime.store.clearMark(key);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { messageId, archived };
});
