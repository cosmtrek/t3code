// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - Context folders are plain files an agent writes; timestamps are wall-clock ISO strings for humans.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ChannelConfigError, type ChannelConfigEntry } from "../channels/config.ts";
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
  Topic,
  page,
  type Conversation as ConversationType,
  type Message as MessageType,
  type Topic as TopicType,
} from "../channels/protocol.ts";
import {
  CONCLUSION_FILE,
  CONTEXT_FILE,
  DRAFT_FILE,
  MEDIA_DIR,
  REQUEST_FILE,
  buildContextMarkdown,
  firstMessage,
  mediaFileName,
  parseFallbackReply,
  threadTitle,
  type ContextImage,
} from "./context.ts";
import {
  compareItems,
  deriveItem,
  itemIdFor,
  PENDING_STATES,
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
const TOPIC_LIMIT = 50;
const MESSAGE_LIMIT = 200;
const SENDER_HISTORY_MS = 7 * 24 * 3_600_000;
const FALLBACK_MARKER = ".fallback-run";

const ConversationPage = page(Conversation);
const TopicPage = page(Topic);
const MessagePage = page(Message);
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

export const listChannels = Effect.fn("ForkChannels.list")(function* () {
  const { hub } = yield* InboxRuntime;
  const projects = yield* activeProjects;
  return {
    channels: hub.list().map((view): ChannelListEntry => ({
      ...view,
      projectMatches: matchProjectPaths(view.config?.defaultProjectPaths ?? [], projects),
    })),
  };
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
  return yield* attempt(() => hub.test(channelId));
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

const exists = (filePath: string) => NodeFS.existsSync(filePath);

async function readText(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * A thread that could not write into its context folder answers with tags instead. Read its
 * latest finished run once and write what it holds, so the rest of the inbox reads only files.
 */
const applyFallback = Effect.fn("ForkInbox.applyFallback")(function* (
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
  const markerPath = NodePath.join(contextDir, FALLBACK_MARKER);
  const marker = yield* Effect.promise(() => readText(markerPath));
  if (marker?.trim() === runId) return;
  const conclusionPath = NodePath.join(contextDir, CONCLUSION_FILE);
  const draftPath = NodePath.join(contextDir, DRAFT_FILE);
  if (!exists(conclusionPath) || !exists(draftPath)) {
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
    if (last) {
      const parsed = parseFallbackReply(last.text);
      yield* Effect.promise(async () => {
        if (parsed.conclusion !== null && !exists(conclusionPath)) {
          await NodeFSP.writeFile(conclusionPath, `${parsed.conclusion}\n`);
        }
        if (parsed.draft !== null && !exists(draftPath)) {
          await NodeFSP.writeFile(draftPath, `${parsed.draft}\n`);
        }
      });
    }
  }
  yield* Effect.promise(() => NodeFSP.writeFile(markerPath, `${runId}\n`).catch(() => undefined));
});

/** The link's thread as it is now. A thread that no longer exists detaches the link. */
const inspectLink = Effect.fn("ForkInbox.inspectLink")(function* (link: Link) {
  const runtime = yield* InboxRuntime;
  const base = {
    threadId: link.threadId,
    projectId: link.projectId,
    createdAt: link.createdAt,
    detachedAt: link.detachedAt,
  };
  if (link.detachedAt !== null) {
    return { ...base, title: null, status: "deleted" } satisfies LinkedThreadView;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(ThreadId.make(link.threadId))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (shell === undefined)
    return { ...base, title: null, status: "unknown" } satisfies LinkedThreadView;
  if (shell === null || shell.deletedAt !== null) {
    const at = new Date().toISOString();
    runtime.store.detachLink(link.itemId, link.threadId, "deleted", at);
    return { ...base, detachedAt: at, title: null, status: "deleted" } satisfies LinkedThreadView;
  }
  yield* applyFallback(NodePath.join(runtime.itemsDir, link.itemId), shell);
  return { ...base, title: shell.title, status: threadStatus(shell) } satisfies LinkedThreadView;
});

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

/** Mentions are per message; topics are re-read only when their last message changes. */
const mentionCache = new Map<
  string,
  { readonly lastMessageAt: string; readonly mentions: boolean }
>();

const mentionsSelf = Effect.fn("ForkInbox.mentionsSelf")(function* (
  channelId: string,
  conversation: ConversationType,
  topic: TopicType,
) {
  const { hub } = yield* InboxRuntime;
  const key = itemIdFor({ channelId, conversationId: conversation.id, topicId: topic.id });
  const cached = mentionCache.get(key);
  if (cached?.lastMessageAt === topic.lastMessageAt) return cached.mentions;
  const messages = yield* attempt(() =>
    hub.getJson(channelId, messagesPath(conversation.id, topic.id), MessagePage),
  ).pipe(Effect.orElseSucceed(() => null));
  if (messages === null) return cached?.mentions ?? false;
  const items = messages.value.items;
  const lastOwn = items.findLastIndex((message) => message.author.isSelf);
  const mentions = items.slice(lastOwn + 1).some((message) => message.mentionsSelf);
  mentionCache.set(key, { lastMessageAt: topic.lastMessageAt, mentions });
  return mentions;
});

interface ChannelItems {
  readonly items: ReadonlyArray<InboxItem>;
  readonly stale: boolean;
  readonly conversations: ReadonlyArray<ConversationType>;
}

const readChannelItems = Effect.fn("ForkInbox.readChannelItems")(function* (channelId: string) {
  const runtime = yield* InboxRuntime;
  const { hub, store } = runtime;
  const conversations = yield* attempt(() =>
    hub.getJson(channelId, conversationsPath, ConversationPage),
  );
  let stale = conversations.stale;
  const marks = new Map(store.listMarks(channelId).map((mark) => [itemIdFor(mark), mark] as const));
  const links = new Map<string, Link>();
  for (const link of store.listLinks(channelId)) {
    // Newest first: an active link wins over older detached ones of the same item.
    const current = links.get(link.itemId);
    if (!current || (current.detachedAt !== null && link.detachedAt === null)) {
      links.set(link.itemId, link);
    }
  }
  const now = Date.now();
  const perConversation = yield* Effect.forEach(
    conversations.value.items,
    (conversation) =>
      Effect.gen(function* () {
        const topics = yield* attempt(() =>
          hub.getJson(channelId, topicsPath(conversation.id), TopicPage),
        ).pipe(Effect.orElseSucceed(() => null));
        if (topics === null) return [];
        if (topics.stale) stale = true;
        return yield* Effect.forEach(
          topics.value.items,
          (topic) =>
            Effect.gen(function* () {
              const key: TopicKey = {
                channelId,
                conversationId: conversation.id,
                topicId: topic.id,
              };
              const id = itemIdFor(key);
              const needsMention =
                conversation.kind !== "dm" && !topic.participatedBySelf && !topic.lastAuthor.isSelf;
              const mentions = needsMention
                ? yield* mentionsSelf(channelId, conversation, topic)
                : false;
              const link = links.get(id);
              const thread = link ? yield* inspectLink(link) : null;
              const contextDir = NodePath.join(runtime.itemsDir, id);
              const hasDraft = link !== undefined && exists(NodePath.join(contextDir, DRAFT_FILE));
              const hasConclusion =
                link !== undefined && exists(NodePath.join(contextDir, CONCLUSION_FILE));
              const mark = marks.get(id) ?? null;
              const derived = deriveItem({
                conversation,
                topic,
                mentionsSelf: mentions,
                mark,
                threadRunning: thread?.status === "running",
                hasDraft,
                now,
              });
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
                hasConclusion,
                hasDraft,
              } satisfies InboxItem;
            }),
          { concurrency: 4 },
        );
      }),
    { concurrency: 4 },
  );
  const items = perConversation.flat().toSorted(compareItems);
  return { items, stale, conversations: conversations.value.items } satisfies ChannelItems;
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
      detail: "This topic is no longer listed by the channel.",
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
  const messages = yield* attempt(() =>
    runtime.hub.getJson(key.channelId, messagesPath(key.conversationId, key.topicId), MessagePage, {
      cacheMs: 5_000,
    }),
  );
  const contextDir = NodePath.join(runtime.itemsDir, item.id);
  const [conclusion, draft] = yield* Effect.promise(() =>
    Promise.all([
      readText(NodePath.join(contextDir, CONCLUSION_FILE)),
      readText(NodePath.join(contextDir, DRAFT_FILE)),
    ]),
  );
  const history = yield* Effect.forEach(
    runtime.store.linksForItem(item.id).filter((link) => link.threadId !== item.thread?.threadId),
    inspectLink,
  );
  const access = channelAccess(channel.status);
  return {
    item,
    conversation,
    messages: messages.value.items,
    stale: messages.stale,
    canSend: access.send,
    conclusion,
    draft,
    // A conclusion outlives a deleted thread; the detail shows it as history.
    conclusionIsHistorical: conclusion !== null && (item.thread?.status ?? "deleted") === "deleted",
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
});
const decodeMarkInput = Schema.decodeUnknownEffect(MarkInput);

export const mark = Effect.fn("ForkInbox.mark")(function* (body: unknown) {
  const input = yield* decodeMarkInput(body).pipe(
    Effect.mapError(() => badRequest("Name the topic and a state.")),
  );
  const runtime = yield* InboxRuntime;
  if (input.state === null) {
    runtime.store.clearMark(input);
  } else {
    const { item } = yield* findTopic(input);
    runtime.store.setMark({
      channelId: input.channelId,
      conversationId: input.conversationId,
      topicId: input.topicId,
      state: input.state,
      markedAt: new Date().toISOString(),
      watermarkMessageAt: item.lastMessageAt,
    });
  }
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { ok: true };
});

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
    }).selection ?? null;
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
  const previous = yield* Effect.forEach(runtime.store.linksForItem(item.id), inspectLink);
  return {
    itemId: item.id,
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModel: defaults.find(([id]) => id === project.id)?.[1] ?? null,
    })),
    defaultProjectId: matches.find((match) => match.projectId !== null)?.projectId ?? null,
    templates: channel.config?.delegateTemplates ?? [],
    providers: providers
      .filter((provider) => provider.enabled && provider.installed)
      .map((provider) => ({
        instanceId: provider.instanceId,
        name: provider.displayName ?? provider.driver,
        models: provider.models.map((model) => ({ slug: model.slug, name: model.name })),
      })),
    existing: previous.find((link) => link.status !== "deleted") ?? null,
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
  /** Start another thread although one is linked already. */
  forceNew: Schema.optional(Schema.Boolean),
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
        return { messageId: message.id, name: attachment.name, path: filePath };
      }).pipe(
        Effect.orElseSucceed((): ContextImage => ({
          messageId: message.id,
          name: attachment.name,
          path: null,
        })),
      ),
    { concurrency: 3 },
  );
});

export const delegate = Effect.fn("ForkInbox.delegate")(function* (body: unknown) {
  const input = yield* decodeDelegateInput(body).pipe(
    Effect.mapError(() => badRequest("The delegation is missing fields.")),
  );
  const runtime = yield* InboxRuntime;
  const { item, conversation, listing, channel } = yield* findTopic(input);
  const active = runtime.store.linksForItem(item.id).find((link) => link.detachedAt === null);
  if (active && input.forceNew !== true) {
    const view = yield* inspectLink(active);
    if (view.status !== "deleted") {
      return { threadId: view.threadId, projectId: view.projectId, existing: true };
    }
  }
  const template = channel.config?.delegateTemplates.find(
    (candidate) => candidate.id === input.templateId,
  );
  if (!template) return yield* badRequest("Choose one of the adapter's templates.", "templateId");
  const projects = yield* activeProjects;
  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (!project) return yield* badRequest("Choose a project in this environment.", "projectId");

  const messages = yield* attempt(() =>
    runtime.hub.getJson(
      input.channelId,
      messagesPath(input.conversationId, input.topicId),
      MessagePage,
      {
        cacheMs: 0,
      },
    ),
  );
  const contextDir = NodePath.join(runtime.itemsDir, item.id);
  yield* Effect.promise(() => NodeFSP.mkdir(contextDir, { recursive: true }));
  const images = yield* downloadImages(input.channelId, contextDir, messages.value.items);
  const sender =
    messages.value.items.find((message) => !message.author.isSelf)?.author ?? item.lastAuthor;
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
    messages.value.items.find((message) => message.id === item.rootMessageId)?.openUrl ??
    messages.value.items[0]?.openUrl ??
    null;
  const channelName = channel.config?.displayName ?? channel.name;
  const context = buildContextMarkdown({
    channelName,
    conversation,
    messages: messages.value.items,
    images,
    senderName: sender.name,
    senderHistory,
    contextDir,
    openUrl,
  });
  yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(contextDir, CONTEXT_FILE), context));

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
  const text = firstMessage({
    template: template.prompt,
    contextDir,
    note: input.note ?? "",
    openUrl,
  });
  yield* Effect.promise(() =>
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
      }),
    ),
  );
  const result = yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId,
    projectId: ProjectId.make(project.id),
    title: threadTitle(channelName, sender.name, item.preview),
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
    createdBy: "user",
    creationSource: "server",
  }).pipe(Effect.mapError(toForkError));
  runtime.store.addLink({
    itemId: item.id,
    channelId: input.channelId,
    conversationId: input.conversationId,
    topicId: input.topicId,
    threadId: result.threadId,
    projectId: project.id,
    createdAt: new Date().toISOString(),
  });
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { threadId: result.threadId, projectId: project.id, existing: false };
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
  const result = decodeSendResultOption(answer);
  if (input.topicId !== undefined) {
    const itemId = itemIdFor({
      channelId: input.channelId,
      conversationId: input.conversationId,
      topicId: input.topicId,
    });
    const draftPath = NodePath.join(runtime.itemsDir, itemId, DRAFT_FILE);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    yield* Effect.promise(() =>
      NodeFSP.rename(
        draftPath,
        NodePath.join(runtime.itemsDir, itemId, `draft.sent.${stamp}.md`),
      ).catch(() => undefined),
    );
    runtime.store.clearMark({
      channelId: input.channelId,
      conversationId: input.conversationId,
      topicId: input.topicId,
    });
  }
  runtime.hub.invalidate(input.channelId);
  runtime.hub.publish({ type: "inbox", channelId: input.channelId });
  return { messageId: result._tag === "Some" ? result.value.messageId : null };
});
