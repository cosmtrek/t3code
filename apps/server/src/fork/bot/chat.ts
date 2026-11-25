// @effect-diagnostics globalDate:off globalDateInEffect:off - Mention delays are wall-clock; adapter times are ISO text.
/**
 * What bots do with the environment's chat channels: read them through the inbox's own reads,
 * send as the user through its `send`, and wake the one bot per channel that handles the user's
 * mentions. Mentions are found from the conversation list the inbox reads anyway, so a busy
 * conversation that never mentions the user costs nothing more.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ChannelView } from "../channels/hub.ts";
import type { Conversation, Message } from "../channels/protocol.ts";
import { InboxRuntime } from "../inbox/InboxRuntime.ts";
import * as Inbox from "../inbox/operations.ts";
import { BotRuntime } from "./BotRuntime.ts";
import { channelName, notify, readableChannels } from "./operations.ts";
import { channelSettings, type Bot, type BotStore, type MentionMark } from "./store.ts";

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

const toolError = (detail: string) =>
  new Inbox.ForkHttpError({ status: 400, code: "tool_error", detail });

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

/** The bot that wakes on the user's mentions in this channel, if any. */
const mentionBotFor = (store: BotStore, channelId: string): Bot | null =>
  store
    .listBots()
    .find(
      (bot) => bot.settings.channelsEnabled && channelSettings(bot.settings, channelId).mentions,
    ) ?? null;

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
        dueAt: new Date(input.now.getTime() + MENTION_DELAY_MS).toISOString(),
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

/** `<channel>/<conversation>`, a conversation id, or a conversation's exact name. */
export const resolveConversation = Effect.fn("ForkBot.resolveConversation")(function* (
  ref: string | undefined,
) {
  const wanted = ref?.trim() ?? "";
  if (wanted === "") return yield* toolError("Name the conversation (see `chat list`).");
  const channels = yield* readableChannels();
  if (channels.length === 0) return yield* toolError("No chat channel can be read here.");
  const slash = wanted.indexOf("/");
  const named =
    slash > 0 ? channels.find((channel) => channel.id === wanted.slice(0, slash)) : null;
  const scope = named ? [named] : channels;
  const id = named ? wanted.slice(slash + 1) : wanted;
  const found: Array<ChatTarget> = [];
  for (const channel of scope) {
    const listing = yield* readChannel(channel.id).pipe(Effect.orElseSucceed(() => null));
    for (const conversation of listing?.raw ?? []) {
      if (
        conversation.id === id ||
        conversation.name.trim().toLowerCase() === id.trim().toLowerCase()
      ) {
        found.push({
          channel,
          conversationId: conversation.id,
          name: conversation.name,
          raw: conversation,
        });
      }
    }
  }
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    return yield* toolError(
      `"${id}" matches several conversations: ${found.map((target) => `${target.channel.id}/${target.conversationId} "${target.name}"`).join(", ")}. Give one of these.`,
    );
  }
  // Not in the recent list: an exact id still reads, in the one channel it can be in.
  if (scope.length === 1 && (named || /^[\w-]+$/.test(id))) {
    return { channel: scope[0]!, conversationId: id, name: id, raw: null } satisfies ChatTarget;
  }
  return yield* toolError(`No conversation "${id}". Run \`chat list --query <name>\`.`);
});

/** `chat list` and `chat unread`: the conversations the inbox shows, as one line each. */
export const listConversations = Effect.fn("ForkBot.listConversations")(function* (options: {
  readonly query?: string;
  readonly unreadOnly: boolean;
}) {
  const channels = yield* readableChannels();
  if (channels.length === 0) return "No chat channel can be read here.";
  const query = options.query?.trim().toLowerCase() ?? "";
  const lines: Array<{ readonly at: number; readonly text: string }> = [];
  for (const channel of channels) {
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
        text: `${channel.id}/${conversation.id} "${conversation.name}" (${conversation.kind}, ${shortTime(conversation.lastActivityAt)}${
          flags.length > 0 ? `, ${flags.join(", ")}` : ""
        })${last ? ` - ${last.author.isSelf ? "the user" : last.author.name}: ${clip(last.preview, 120)}` : ""}`,
      });
    }
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

/** `chat read`: a page of the conversation, or one reply thread, oldest first. */
export const readMessages = Effect.fn("ForkBot.readMessages")(function* (
  target: ChatTarget,
  options: { readonly limit: number; readonly before?: string; readonly root?: string },
) {
  const ref = `${target.channel.id}/${target.conversationId}`;
  const header = `"${target.name}" in ${channelName(target.channel)} (${ref})`;
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
export const signed = (bot: Bot, text: string) => {
  const signature = bot.settings.signature.trim().replaceAll("{bot}", bot.name);
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
  const store = (yield* BotRuntime).store();
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
  store.recordSent(input.botId, input.target.channel.id, sent.messageId, new Date().toISOString());
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
  const store = (yield* BotRuntime).store();
  const messages = yield* newestPage(target);
  const sent = store.sentByBots(
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
  const channel = (yield* readableChannels()).find((candidate) => candidate.id === channelId);
  if (channel === undefined) return;
  const listing = yield* readChannel(channelId);
  const steps = trackMentions({
    conversations: listing.raw,
    marks: store.listMentions(channelId),
    since: channelSettings(bot.settings, channelId).mentionsSince ?? bot.createdAt,
    now: new Date(),
  });
  for (const step of steps) {
    if (step.type === "handled") {
      store.markMentionHandled(channelId, step.conversationId, step.through);
    } else {
      store.markMentionPending(
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
  const now = new Date();
  const store = (yield* BotRuntime).existingStore();
  if (store === null) return;
  for (const mark of store.dueMentions(now.toISOString())) {
    const handled = yield* fireMention(store, mark).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("A mention could not be read; trying again later.", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!handled) {
      store.delayMention(
        mark.channelId,
        mark.conversationId,
        new Date(now.getTime() + RETRY_MS).toISOString(),
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
  const channel = (yield* readableChannels()).find((candidate) => candidate.id === mark.channelId);
  if (bot === null || channel === undefined) {
    store.markMentionHandled(mark.channelId, mark.conversationId, pendingAt);
    return;
  }
  const listing = yield* readChannel(mark.channelId);
  const conversation = listing.raw.find((candidate) => candidate.id === mark.conversationId);
  const latest = latestOf(pendingAt, conversation?.lastMentionAt);
  if (conversation?.lastSelfMessageAt && !later(latest, conversation.lastSelfMessageAt)) {
    store.markMentionHandled(mark.channelId, mark.conversationId, latest);
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
  store.markMentionHandled(mark.channelId, mark.conversationId, latest);
  const ref = `${mark.channelId}/${mark.conversationId}`;
  const where = `"${conversation?.name ?? mark.conversationId}" in ${channelName(channel)} (${ref})`;
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
      `Read around it with \`chat read ${ref}\` (add --root <thread> for a thread). Then tell the user what needs them, draft a reply with \`chat send\`, or start a thread for real work; end with NO_REPLY when it needs nothing.`,
    ].join("\n"),
    true,
  );
});
