/**
 * Chat channels as a connector kind: each channel the inbox has switched on is an instance whose
 * id is its command (`t3bot lark send …`). Reads and sends go through the inbox; what goes out is
 * the user's own message.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { channelAccess, type ChannelStatus, type ChannelView } from "../../../channels/hub.ts";
import { InboxRuntime } from "../../../inbox/InboxRuntime.ts";
import { ForkHttpError } from "../../../inbox/operations.ts";
import { BotRuntime } from "../../BotRuntime.ts";
import { decode } from "../../operations.ts";
import { connectorSettings } from "../../store.ts";
import { textOf, toolError, type Action, type Connector, type Instance } from "../types.ts";
import {
  channelName,
  chatConfig,
  configuredChannels,
  describeReply,
  fireDueMentions,
  listConversations,
  mentionBotFor,
  readMessages,
  READ_LIMIT,
  resolveConversation,
  scanMentions,
  sendAsUser,
  signed,
  userWroteSince,
} from "./chat.ts";

const SEND_CHARS = 20_000;
const SIGNATURE_CHARS = 200;

/** Why a channel is not fully usable, in the bot's and the user's terms. */
const STATUS_REASONS: Partial<Record<ChannelStatus, string>> = {
  needs_login: "sign-in needed in the chat app: reading works, sending does not",
  unreachable:
    "the chat adapter is unreachable: reading shows what was fetched last, sending fails",
  token_missing: "the chat adapter's token is missing",
  unauthorized: "the chat adapter refused its token",
  incompatible: "the chat adapter speaks another protocol version",
};

const toInstance = (channel: ChannelView): Omit<Instance, "kind"> => {
  const access = channelAccess(channel.status);
  return {
    id: channel.id,
    name: channelName(channel),
    status: !access.read ? "down" : !access.send || access.stale ? "degraded" : "ok",
    reason: STATUS_REASONS[channel.status] ?? null,
    operations: [{ id: "send", label: "Send messages" }],
  };
};

const pad = (words: string) => `  ${words.padEnd(31)}`;

const help = (instance: Instance) => {
  const id = instance.id;
  return [
    `  ${id}: ${instance.name}, the user's chat app; everything you send there is the user's message`,
    `${pad(`${id} unread`)}conversations with unread messages or mentions of the user`,
    `${pad(`${id} list [--query <name>]`)}recent conversations; each line starts with its id`,
    `  ${id} read <conversation> [--limit n] [--before <cursor>] [--root <message>]`,
    `${pad("")}newest messages, oldest first; --root reads one reply thread`,
    `  ${id} send <conversation> [--reply-to <message>] <text> | -`,
    `${pad("")}sends as the user, in that message's thread with --reply-to;`,
    `${pad("")}@Name of someone in the conversation notifies them`,
    `${pad("")}<conversation> is an id or an exact name`,
  ].join("\n");
};

const brief: Connector["brief"] = (instance, settings) => {
  const id = instance.id;
  const config = chatConfig(settings);
  return [
    `- \`${id}\` is the user's chat app ${instance.name}: read it with \`${id} unread\`, \`${id} list\` and`,
    `  \`${id} read\`. Nobody there knows you exist: what you send with \`${id} send\` goes out as the`,
    `  user, so send only what they would. Sending ${settings.permissions.send === "allow" ? "goes out at once" : "asks the user first"}.`,
    ...(config.mentions
      ? [
          `  You handle the user's @-mentions in ${instance.name}. When one wakes you, read around it,`,
          "  then tell the user what needs them, draft a reply, or start a thread for real work. A",
          "  mention that needs nothing ends with NO_REPLY.",
        ]
      : []),
  ];
};

const resolve: Connector["resolve"] = Effect.fn("ForkBot.chat.resolve")(function* (call) {
  const id = call.instance.id;
  const channel = (yield* configuredChannels()).find((candidate) => candidate.id === id);
  if (channel === undefined) return yield* toolError(`No channel "${id}" here.`);
  switch (call.operation) {
    case "unread":
      return {
        effect: "read",
        run: listConversations(channel, { unreadOnly: true }),
      } satisfies Action;
    case "list":
      return {
        effect: "read",
        run: listConversations(channel, {
          query: call.flags.get("query") ?? call.args.join(" "),
          unreadOnly: false,
        }),
      } satisfies Action;
    case "read": {
      const target = yield* resolveConversation(channel, call.args[0]);
      const limit = Math.min(
        Math.max(Number(call.flags.get("limit") ?? READ_LIMIT) || READ_LIMIT, 1),
        100,
      );
      const before = call.flags.get("before");
      const root = call.flags.get("root");
      return {
        effect: "read",
        run: readMessages(target, {
          limit,
          ...(before === undefined ? {} : { before }),
          ...(root === undefined ? {} : { root }),
        }),
      } satisfies Action;
    }
    case "send": {
      const target = yield* resolveConversation(channel, call.args[0]);
      const text = textOf(call.args.slice(1), call.stdin);
      if (text === "" || text.length > SEND_CHARS) {
        return yield* toolError(`Write 1 to ${SEND_CHARS} characters.`);
      }
      const replyToId = call.flags.get("reply-to");
      const outgoing = signed(call.bot, chatConfig(call.settings), text);
      return {
        effect: "write",
        operation: "send",
        what: `send as you to "${target.name}"${
          replyToId === undefined ? "" : `, replying to ${yield* describeReply(target, replyToId)}`
        }`,
        detail: outgoing,
        run: Effect.fn("ForkBot.chat.send")(function* ({ askedAt }) {
          if (askedAt !== undefined && (yield* userWroteSince(target, askedAt))) {
            return yield* toolError(
              `Not sent: the user wrote in "${target.name}" after you drafted this. Read it again and draft anew if it still needs saying. Your draft: ${text}`,
            );
          }
          const sent = yield* sendAsUser({
            botId: call.bot.id,
            target,
            text: outgoing,
            ...(replyToId === undefined ? {} : { replyToId }),
          });
          return [
            `Sent as the user to "${target.name}" (message ${sent.messageId}).`,
            ...(sent.unresolvedMentions.length > 0
              ? [
                  `Not notified (mention went out as plain text): ${sent.unresolvedMentions.join(", ")}.`,
                ]
              : []),
          ].join(" ");
        }),
      } satisfies Action;
    }
    default:
      return yield* toolError(`${id} unread | list | read | send`);
  }
});

const ConfigInput = Schema.Struct({
  signature: Schema.optional(Schema.String),
  mentions: Schema.optional(Schema.Boolean),
});

const config: Connector["config"] = Effect.fn("ForkBot.chat.config")(function* (
  input,
  { before, enabled, now },
) {
  const decoded = yield* decode(ConfigInput, input);
  const previous = chatConfig(before);
  const signature = decoded.signature ?? previous.signature;
  if (signature.length > SIGNATURE_CHARS) {
    return yield* new ForkHttpError({
      status: 400,
      code: "bad_request",
      detail: `Keep the signature under ${SIGNATURE_CHARS} characters.`,
      field: "signature",
    });
  }
  const mentions = enabled && (decoded.mentions ?? previous.mentions);
  return {
    signature,
    mentions,
    // Turning mentions on starts from now: earlier ones were the user's to handle.
    mentionsSince: mentions ? (previous.mentions ? previous.mentionsSince : now) : null,
  };
});

const info: NonNullable<Connector["info"]> = Effect.fn("ForkBot.chat.info")(function* (instanceId) {
  const store = (yield* BotRuntime).existingStore();
  const holder = store === null ? null : mentionBotFor(store, instanceId);
  return { mentionBot: holder === null ? null : { id: holder.id, name: holder.name } };
});

/** One bot per channel wakes on mentions: taking a channel takes it from the bot that had it. */
const afterSave: NonNullable<Connector["afterSave"]> = Effect.fn("ForkBot.chat.afterSave")(
  function* (botId, instanceId) {
    const runtime = yield* BotRuntime;
    const store = yield* runtime.store;
    const saved = store.getBot(botId);
    if (saved === null || !chatConfig(connectorSettings(saved.settings, instanceId)).mentions) {
      return;
    }
    for (const other of store.listBots()) {
      const held = connectorSettings(other.settings, instanceId);
      if (other.id === botId || !chatConfig(held).mentions) continue;
      store.setSettings(other.id, {
        ...other.settings,
        connectors: {
          ...other.settings.connectors,
          [instanceId]: {
            ...held,
            config: { ...held.config, mentions: false, mentionsSince: null },
          },
        },
      });
      runtime.publish(other.id);
    }
  },
);

/**
 * Mentions of the user: each channel change reads its (cached) conversation list for new ones,
 * changes arriving together read it once, and a sweep catches what an event missed.
 */
const watchMentions = Effect.gen(function* () {
  const inbox = yield* Effect.serviceOption(InboxRuntime);
  if (Option.isNone(inbox)) return;
  const changed = yield* Queue.unbounded<string>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      inbox.value.subscribe((event) => {
        if (event.type === "inbox") Queue.offerUnsafe(changed, event.channelId);
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  const scan = (channelId: string) =>
    scanMentions(channelId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check a channel for mentions.", { cause }),
      ),
    );
  yield* Effect.all(
    [
      Queue.takeAll(changed).pipe(
        Effect.flatMap((ids) => Effect.forEach(new Set(ids), scan, { discard: true })),
        Effect.forever,
      ),
      configuredChannels().pipe(
        Effect.flatMap((channels) =>
          Effect.forEach(channels, (channel) => scan(channel.id), { discard: true }),
        ),
        Effect.andThen(Effect.sleep("1 minute")),
        Effect.forever,
      ),
      // Due mentions are a store read; checked often so the delay stays close to its length.
      Effect.suspend(() => fireDueMentions()).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Mention wakes failed.", { cause })),
        Effect.andThen(Effect.sleep("5 seconds")),
        Effect.forever,
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
});

export const chatConnector: Connector = {
  kind: "chat",
  instances: Effect.suspend(() => configuredChannels()).pipe(
    Effect.map((channels) => channels.map(toInstance)),
  ),
  flags: {
    list: { values: ["query"] },
    read: { values: ["limit", "before", "root"] },
    send: { values: ["reply-to"] },
  },
  help,
  brief,
  resolve,
  config,
  info,
  afterSave,
  start: Effect.suspend(() => watchMentions),
};
