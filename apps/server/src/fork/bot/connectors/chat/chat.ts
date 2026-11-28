/**
 * What bots do with one of the environment's chat channels: read it through the inbox's own
 * reads, send as the user through its `send`, and wake the one bot per channel that handles the
 * user's mentions. Mentions are found from the conversation list the inbox reads anyway, so a busy
 * conversation that never mentions the user costs nothing more.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { channelAccess, type ChannelView } from "../../../channels/hub.ts";
import type { Conversation, Message } from "../../../channels/protocol.ts";
import { InboxRuntime } from "../../../inbox/InboxRuntime.ts";
import * as Inbox from "../../../inbox/operations.ts";
import { BotRuntime } from "../../BotRuntime.ts";
import { notify } from "../../operations.ts";
import { connectorSettings, type Bot, type BotStore, type ConnectorSettings } from "../../store.ts";
import { toolError } from "../types.ts";
import * as State from "./state.ts";
import type { MentionMark } from "./state.ts";

/** The sender gets this long to finish, and the user to answer first. */
export const MENTION_DELAY_MS = 30_000;
/** A channel that could not be read is tried again after this. */
const RETRY_MS = 60_000;
const LIST_LIMIT = 40;
export const READ_LIMIT = 30;
const MESSAGE_CHARS = 1_500;
const QUOTE_CHARS = 300;
/** Pages read back to find a conversation's new mentions. */
const MENTION_PAGES = 5;

const ms = (iso: string | null | undefined) => (iso == null ? Number.NaN : Date.parse(iso));
const later = (left: string | null | undefined, right: string | null | undefined) =>
  ms(left) > ms(right) || (Number.isNaN(ms(right)) && !Number.isNaN(ms(left)));
const latestOf = (left: string, right: string | null | undefined) =>
  later(right, left) ? right! : left;

/** The inbox's reads and send, where the environment has an inbox at all. */
// Untraced: it only wraps inbox operations that carry their own spans.
const withInbox = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const inbox = yield* Effect.serviceOption(InboxRuntime);
  if (Option.isNone(inbox)) return yield* toolError("No chat channel is set up here.");
  return yield* Effect.provideService(effect, InboxRuntime, inbox.value);
});
const readChannel = (channelId: string) => withInbox(Inbox.readChannel(channelId));
const readChain = (...args: Parameters<typeof Inbox.readChain>) =>
  withInbox(Inbox.readChain(...args));
const readConversation = (query: URLSearchParams) => withInbox(Inbox.readConversation(query));
const sendMessage = (body: unknown) => withInbox(Inbox.send(body));

const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}… (cut)` : text;

/** The environment's channels that are switched on, whatever their state. */
export const configuredChannels = Effect.fn("ForkBot.configuredChannels")(function* () {
  const inbox = yield* Effect.serviceOption(InboxRuntime);
  if (Option.isNone(inbox)) return [] as ReadonlyArray<ChannelView>;
  return inbox.value.hub.list().filter((channel) => channel.enabled);
});

export const channelName = (channel: ChannelView) => channel.config?.displayName ?? channel.name;

/** The channel, when it can be read now. */
const readableChannel = Effect.fn("ForkBot.readableChannel")(function* (channelId: string) {
  return (
    (yield* configuredChannels()).find(
      (channel) => channel.id === channelId && channelAccess(channel.status).read,
    ) ?? null
  );
});

/** A bot's settings for one channel, beside the ones every connector has. */
export interface ChatConfig {
  /** Appended on its own line to what it sends; `{bot}` is its name. Empty sends as written. */
  readonly signature: string;
  /** It wakes when someone mentions the user there; one bot per channel at most. */
  readonly mentions: boolean;
  /** When mentions were turned on: earlier ones are not this bot's to answer. */
  readonly mentionsSince: string | null;
}

const ChatConfigShape = Schema.Struct({
  signature: Schema.optional(Schema.String),
  mentions: Schema.optional(Schema.Boolean),
  mentionsSince: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeChatConfig = Schema.decodeUnknownOption(ChatConfigShape);

export const chatConfig = (settings: ConnectorSettings): ChatConfig => {
  const decoded = decodeChatConfig(settings.config as unknown);
  const config = Option.getOrElse(decoded, () => ({}) as typeof ChatConfigShape.Type);
  return {
    signature: config.signature ?? "",
    mentions: settings.enabled && config.mentions === true,
    mentionsSince: config.mentionsSince ?? null,
  };
};

/** The bot that wakes on the user's mentions in this channel, if any. */
export const mentionBotFor = (store: BotStore, channelId: string): Bot | null =>
  store.listBots().find((bot) => chatConfig(connectorSettings(bot.settings, channelId)).mentions) ??
  null;

type MentionStep =
  | {
      readonly type: "pending";
      readonly conversationId: string;
      readonly pendingAt: string;
      readonly dueAt: string;
      readonly handledThrough: string;
    }
  | { readonly type: "handled"; readonly conversationId: string; readonly through: string };

/**
 * Pure: which conversations hold a mention newer than what was handled (and than when the bot
 * took mentions on), and whether the user already answered it.
 */
export function trackMentions(input: {
  readonly conversations: ReadonlyArray<
    Pick<Conversation, "id" | "lastMentionAt" | "lastSelfMessageAt">
  >;
  readonly marks: ReadonlyArray<MentionMark>;
  readonly since: string;
  readonly now: Date;
}): ReadonlyArray<MentionStep> {
  const marks = new Map(input.marks.map((mark) => [mark.conversationId, mark] as const));
  return input.conversations.flatMap((conversation): ReadonlyArray<MentionStep> => {
    const mentionAt = conversation.lastMentionAt;
    const mark = marks.get(conversation.id);
    const handled = latestOf(input.since, mark?.handledThrough);
    if (mentionAt == null || !later(mentionAt, handled)) return [];
    if (mark?.pendingAt === mentionAt) return [];
    if (conversation.lastSelfMessageAt && !later(mentionAt, conversation.lastSelfMessageAt)) {
      return [{ type: "handled", conversationId: conversation.id, through: mentionAt }];
    }
    return [
      {
        type: "pending",
        conversationId: conversation.id,
        pendingAt: mentionAt,
        dueAt: DateTime.formatIso(DateTime.makeUnsafe(input.now.getTime() + MENTION_DELAY_MS)),
        handledThrough: handled,
      },
    ];
  });
}

/** Pure: the messages that mention the user since the mark, oldest first. */
export const newMentions = (messages: ReadonlyArray<Message>, handledThrough: string) =>
  messages.filter(
    (message) =>
      message.mentionsSelf && !message.author.isSelf && later(message.createdAt, handledThrough),
  );

const shortTime = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** One message as a bot reads it: id first, so it can reply to or open the thread of it. */
function formatMessage(message: Message): string {
  const marks = [
    message.mentionsSelf ? "mentions the user" : null,
    message.rootId != null && message.rootId !== message.id ? `in thread ${message.rootId}` : null,
    message.replyTo ? `replying to ${message.replyTo.id}` : null,
  ].filter((mark) => mark !== null);
  const files = message.attachments.map((file) => `[${file.kind} ${file.name}]`);
  const body = [message.text.trim() || message.richSummary?.trim() || "", ...files]
    .filter(Boolean)
    .join(" ");
  return `[${message.id}] ${shortTime(message.createdAt)} ${message.author.isSelf ? "the user" : message.author.name}${
    marks.length > 0 ? ` (${marks.join(", ")})` : ""
  }: ${clip(body, MESSAGE_CHARS)}`;
}

export interface ChatTarget {
  readonly channel: ChannelView;
  readonly conversationId: string;
  readonly name: string;
  readonly raw: Conversation | null;
}

/** A conversation id or exact name in the channel; `<channel>/<id>` as earlier builds wrote it. */
export const resolveConversation = Effect.fn("ForkBot.resolveConversation")(function* (
  channel: ChannelView,
  ref: string | undefined,
) {
  const prefix = `${channel.id}/`;
  const raw = ref?.trim() ?? "";
  const wanted = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (wanted === "") return yield* toolError(`Name the conversation (see \`${channel.id} list\`).`);
  const listing = yield* readChannel(channel.id).pipe(Effect.orElseSucceed(() => null));
  const found = (listing?.raw ?? []).filter(
    (conversation) =>
      conversation.id === wanted || conversation.name.trim().toLowerCase() === wanted.toLowerCase(),
  );
  if (found.length === 1) {
    const conversation = found[0]!;
    return {
      channel,
      conversationId: conversation.id,
      name: conversation.name,
      raw: conversation,
    } satisfies ChatTarget;
  }
  if (found.length > 1) {
    return yield* toolError(
      `"${wanted}" matches several conversations: ${found.map((conversation) => `${conversation.id} "${conversation.name}"`).join(", ")}. Give one of these ids.`,
    );
  }
  // Not in the recent list: an exact id still reads.
  if (/^[\w-]+$/.test(wanted)) {
    return { channel, conversationId: wanted, name: wanted, raw: null } satisfies ChatTarget;
  }
  return yield* toolError(
    `No conversation "${wanted}". Run \`${channel.id} list --query <name>\`.`,
  );
});

/** `list` and `unread`: the conversations the inbox shows, as one line each. */
export const listConversations = Effect.fn("ForkBot.listConversations")(function* (
  channel: ChannelView,
  options: { readonly query?: string; readonly unreadOnly: boolean },
) {
  const query = options.query?.trim().toLowerCase() ?? "";
  const lines: Array<{ readonly at: number; readonly text: string }> = [];
  const listing = yield* readChannel(channel.id).pipe(
    Effect.mapError((error) => toolError(`${channelName(channel)}: ${error.detail}`)),
  );
  for (const conversation of listing.conversations) {
    if (query !== "" && !conversation.name.toLowerCase().includes(query)) continue;
    if (options.unreadOnly && !conversation.unread && !conversation.mentioned) continue;
    const flags = [
      conversation.mentioned ? "mentions the user" : null,
      conversation.unread
        ? `unread${conversation.unreadCount ? ` ${conversation.unreadCount}` : ""}`
        : null,
      conversation.muted ? "muted" : null,
    ].filter((flag) => flag !== null);
    const last = conversation.lastMessage;
    lines.push({
      at: ms(conversation.lastActivityAt),
      text: `${conversation.id} "${conversation.name}" (${conversation.kind}, ${shortTime(conversation.lastActivityAt)}${
        flags.length > 0 ? `, ${flags.join(", ")}` : ""
      })${last ? ` - ${last.author.isSelf ? "the user" : last.author.name}: ${clip(last.preview, 120)}` : ""}`,
    });
  }
  if (lines.length === 0) {
    return options.unreadOnly ? "Nothing unread and no mentions." : "No conversations match.";
  }
  const shown = lines.toSorted((left, right) => right.at - left.at).slice(0, LIST_LIMIT);
  return [
    ...shown.map((line) => line.text),
    ...(lines.length > shown.length
      ? [`and ${lines.length - shown.length} more; narrow with --query`]
      : []),
  ].join("\n");
});

/** `read`: a page of the conversation, or one reply thread, oldest first. */
export const readMessages = Effect.fn("ForkBot.readMessages")(function* (
  target: ChatTarget,
  options: { readonly limit: number; readonly before?: string; readonly root?: string },
) {
  const header = `"${target.name}" (${target.conversationId})`;
  if (options.root !== undefined) {
    const thread = yield* readChain(target.channel.id, target.conversationId, options.root, {
      cacheMs: 5_000,
    });
    const messages = thread.messages.slice(-options.limit);
    return [
      `${header}, thread ${options.root}:`,
      ...messages.map(formatMessage),
      ...(thread.messages.length > messages.length
        ? [`(${thread.messages.length - messages.length} earlier replies left out)`]
        : []),
    ].join("\n");
  }
  const page = yield* readConversation(
    new URLSearchParams({
      channelId: target.channel.id,
      conversationId: target.conversationId,
      ...(options.before === undefined ? {} : { cursor: options.before }),
    }),
  );
  const messages = page.messages.slice(-options.limit);
  const older = page.messages.length > messages.length || page.nextCursor !== null;
  return [
    `${header}:`,
    ...(messages.length === 0 ? ["(no messages)"] : messages.map(formatMessage)),
    ...(older
      ? [
          page.messages.length > messages.length
            ? `Older: raise --limit (up to 100)${page.nextCursor ? `, then --before ${page.nextCursor}` : ""}.`
            : `Older: --before ${page.nextCursor}`,
        ]
      : []),
  ].join("\n");
});

/** The text as it goes out: with the bot's signature on its own line, when it has one. */
export const signed = (bot: Bot, config: ChatConfig, text: string) => {
  const signature = config.signature.trim().replaceAll("{bot}", bot.name);
  return signature === "" ? text : `${text}\n\n${signature}`;
};

/** The newest page of a conversation, oldest first. */
const newestPage = (target: ChatTarget) =>
  readConversation(
    new URLSearchParams({ channelId: target.channel.id, conversationId: target.conversationId }),
  ).pipe(Effect.map((page) => page.messages));

/**
 * Pure: whom the text names as `@name`, among people seen in the conversation; the longest name
 * wins, so `@Zhang Sanfeng` is not taken for `@Zhang San`.
 */
export function mentionsIn(
  text: string,
  messages: ReadonlyArray<Message>,
): ReadonlyArray<{ readonly userId: string; readonly name: string }> {
  const people = new Map<string, string>();
  for (const message of messages) {
    if (!message.author.isSelf) people.set(message.author.name, message.author.id);
    for (const mention of message.mentions ?? []) {
      if (!mention.isSelf && mention.userId !== "all") people.set(mention.name, mention.userId);
    }
  }
  let rest = text;
  const found: Array<{ readonly userId: string; readonly name: string }> = [];
  for (const [name, userId] of [...people].toSorted((a, b) => b[0].length - a[0].length)) {
    if (name === "" || !rest.includes(`@${name}`)) continue;
    found.push({ userId, name });
    rest = rest.replaceAll(`@${name}`, "");
  }
  return found;
}

/** One message: by a thread read rooted at it, else paging back as far as mentions look. */
const findMessage = Effect.fn("ForkBot.findMessage")(function* (
  target: ChatTarget,
  messageId: string,
) {
  const thread = yield* readChain(target.channel.id, target.conversationId, messageId, {
    cacheMs: 5_000,
  }).pipe(Effect.orElseSucceed(() => null));
  const inThread = thread?.messages.find((message) => message.id === messageId);
  if (inThread !== undefined) return inThread;
  let cursor: string | null = null;
  for (let pages = 0; pages < MENTION_PAGES; pages++) {
    const page: { readonly messages: ReadonlyArray<Message>; readonly nextCursor: string | null } =
      yield* readConversation(
        new URLSearchParams({
          channelId: target.channel.id,
          conversationId: target.conversationId,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
    const found = page.messages.find((message) => message.id === messageId);
    if (found !== undefined) return found;
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return undefined;
});

/** The message replied to, as the approval card names it. */
export const describeReply = Effect.fn("ForkBot.describeReply")(function* (
  target: ChatTarget,
  replyToId: string,
) {
  const message = yield* findMessage(target, replyToId).pipe(Effect.orElseSucceed(() => undefined));
  if (message === undefined) return `message ${replyToId}`;
  const text = (message.text.trim() || message.richSummary?.trim() || "[no text]").split("\n")[0]!;
  return `${message.author.isSelf ? "your message" : message.author.name}: "${clip(text, 120)}"`;
});

/** Sends as the user; `text` is already signed. `@name` of someone in the conversation notifies them. */
export const sendAsUser = Effect.fn("ForkBot.sendAsUser")(function* (input: {
  readonly botId: string;
  readonly target: ChatTarget;
  readonly text: string;
  readonly replyToId?: string;
}) {
  const store = yield* (yield* BotRuntime).store;
  // People on the newest page, and whoever wrote the message it answers.
  const known = input.text.includes("@")
    ? [
        ...(yield* newestPage(input.target).pipe(Effect.orElseSucceed(() => []))),
        ...(input.replyToId === undefined
          ? []
          : [
              yield* findMessage(input.target, input.replyToId).pipe(
                Effect.orElseSucceed(() => undefined),
              ),
            ].filter((message) => message !== undefined)),
      ]
    : [];
  const mentions = mentionsIn(input.text, known);
  const sent = yield* sendMessage({
    channelId: input.target.channel.id,
    conversationId: input.target.conversationId,
    ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }),
    text: input.text,
    format: "markdown",
    ...(mentions.length === 0 ? {} : { mentions }),
  });
  State.recordSent(
    store,
    input.botId,
    input.target.channel.id,
    sent.messageId,
    DateTime.formatIso(yield* DateTime.now),
  );
  return sent;
});

/** Pure: the user's own messages after `at`, leaving out what bots sent as them. */
export const userWroteAfter = (
  messages: ReadonlyArray<Message>,
  at: string,
  sentByBots: ReadonlySet<string>,
) =>
  messages.some(
    (message) =>
      message.author.isSelf && later(message.createdAt, at) && !sentByBots.has(message.id),
  );

/** The user wrote in the conversation after `at`, so a draft from then may no longer fit. */
export const userWroteSince = Effect.fn("ForkBot.userWroteSince")(function* (
  target: ChatTarget,
  at: string,
) {
  if (!later(target.raw?.lastSelfMessageAt, at)) return false;
  const store = yield* (yield* BotRuntime).store;
  const messages = yield* newestPage(target);
  const sent = State.sentByBots(
    store,
    target.channel.id,
    messages.map((message) => message.id),
  );
  return userWroteAfter(messages, at, sent);
});

/**
 * Reads one channel's conversation list and marks new mentions of the user to wake its mention
 * bot after the delay. Mentions the user answered are marked handled without a wake.
 */
export const scanMentions = Effect.fn("ForkBot.scanMentions")(function* (channelId: string) {
  const store = (yield* BotRuntime).existingStore();
  const bot = store === null ? null : mentionBotFor(store, channelId);
  if (store === null || bot === null) return;
  if ((yield* readableChannel(channelId)) === null) return;
  const listing = yield* readChannel(channelId);
  const steps = trackMentions({
    conversations: listing.raw,
    marks: State.listMentions(store, channelId),
    since: chatConfig(connectorSettings(bot.settings, channelId)).mentionsSince ?? bot.createdAt,
    now: DateTime.toDateUtc(yield* DateTime.now),
  });
  for (const step of steps) {
    if (step.type === "handled") {
      State.markMentionHandled(store, channelId, step.conversationId, step.through);
    } else {
      State.markMentionPending(
        store,
        channelId,
        step.conversationId,
        step.pendingAt,
        step.dueAt,
        step.handledThrough,
      );
    }
  }
});

/** Wakes the mention bot for each conversation whose delay has passed. */
export const fireDueMentions = Effect.fn("ForkBot.fireDueMentions")(function* () {
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const store = (yield* BotRuntime).existingStore();
  if (store === null) return;
  for (const mark of State.dueMentions(store, now.toISOString())) {
    const handled = yield* fireMention(store, mark).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("A mention could not be read; trying again later.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!handled) {
      State.delayMention(
        store,
        mark.channelId,
        mark.conversationId,
        DateTime.formatIso(DateTime.makeUnsafe(now.getTime() + RETRY_MS)),
      );
    }
  }
});

const fireMention = Effect.fn("ForkBot.fireMention")(function* (
  store: BotStore,
  mark: MentionMark,
) {
  const pendingAt = mark.pendingAt ?? mark.handledThrough;
  const bot = mentionBotFor(store, mark.channelId);
  const channel = yield* readableChannel(mark.channelId);
  if (bot === null || channel === null) {
    State.markMentionHandled(store, mark.channelId, mark.conversationId, pendingAt);
    return;
  }
  const listing = yield* readChannel(mark.channelId);
  const conversation = listing.raw.find((candidate) => candidate.id === mark.conversationId);
  const latest = latestOf(pendingAt, conversation?.lastMentionAt);
  if (conversation?.lastSelfMessageAt && !later(latest, conversation.lastSelfMessageAt)) {
    State.markMentionHandled(store, mark.channelId, mark.conversationId, latest);
    return;
  }
  // Back to the handled mark, so a mention a busy conversation pushed off the first page is found.
  const read: Array<Message> = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < MENTION_PAGES; pages++) {
    const page: { readonly messages: ReadonlyArray<Message>; readonly nextCursor: string | null } =
      yield* readConversation(
        new URLSearchParams({
          channelId: mark.channelId,
          conversationId: mark.conversationId,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
    read.push(...page.messages);
    cursor = page.nextCursor;
    const oldest = page.messages[0]?.createdAt;
    if (cursor === null || oldest === undefined || !later(oldest, mark.handledThrough)) break;
  }
  const mentions = newMentions(
    read.toSorted((left, right) => ms(left.createdAt) - ms(right.createdAt)),
    mark.handledThrough,
  );
  State.markMentionHandled(store, mark.channelId, mark.conversationId, latest);
  const command = channel.id;
  const where = `"${conversation?.name ?? mark.conversationId}" in ${channelName(channel)} (${mark.conversationId})`;
  const lines =
    mentions.length === 0
      ? [
          `The user was mentioned in ${where} at ${shortTime(latest)}; it is further back than you were shown.`,
        ]
      : [
          `The user was mentioned in ${where}:`,
          ...mentions.map(
            (message) =>
              `  [${message.id}] ${message.author.name}${
                message.rootId != null && message.rootId !== message.id
                  ? ` (in thread ${message.rootId})`
                  : ""
              }: ${clip(message.text.trim() || "[no text]", QUOTE_CHARS)}`,
          ),
        ];
  yield* notify(
    bot.id,
    [
      ...lines,
      `Read around it with \`${command} read ${mark.conversationId}\` (add --root <thread> for a thread). Then tell the user what needs them, draft a reply with \`${command} send\`, or start a thread for real work; end with NO_REPLY when it needs nothing.`,
    ].join("\n"),
    true,
  );
});
