import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
/**
 * The built-in example channel: protocol v2 served in process from made-up data, for
 * development, tests, screenshots, and trying the inbox without a real adapter.
 */
import { CHANNEL_PROTOCOL_VERSION, type ChannelEvent } from "../protocol.ts";
import {
  AdapterUnreachableError,
  type AdapterRequest,
  type AdapterResponse,
  type ChannelTransport,
} from "../transport.ts";

/** States the example can pretend to be in, so each banner and settings hint can be seen. */
export const EXAMPLE_SIMULATIONS = [
  "online",
  "needs_login",
  "collector_stopped",
  "unreachable",
  "incompatible",
] as const;
export type ExampleSimulation = (typeof EXAMPLE_SIMULATIONS)[number];

interface Person {
  readonly id: string;
  readonly name: string;
}

interface ExampleMessage {
  readonly id: string;
  /** The message this one answers; its reply thread is that message's thread. */
  readonly replyToId: string | null;
  /** Kept inside its thread, off the conversation's timeline. */
  readonly inThread?: boolean;
  readonly createdAt: string;
  readonly author: Person;
  readonly mentionsSelf: boolean;
  readonly text: string;
  readonly richSummary?: string;
  readonly attachments: ReadonlyArray<{ key: string; kind: "image" | "file"; name: string }>;
  readonly links: ReadonlyArray<string>;
  readonly reactions?: ReadonlyArray<{
    key: string;
    emoji: string | null;
    users: ReadonlyArray<Person>;
  }>;
  readonly editedAt?: string;
}

interface ExampleConversation {
  readonly id: string;
  readonly kind: "dm" | "group" | "topic_group";
  readonly name: string;
  readonly relevant: boolean;
  readonly muted: boolean;
  readonly messages: ExampleMessage[];
}

const SELF: Person = { id: "u-self", name: "Alex Rivera" };
const JORDAN: Person = { id: "u-jordan", name: "Jordan Lee" };
const PRIYA: Person = { id: "u-priya", name: "Priya Shah" };
const SAM: Person = { id: "u-sam", name: "Sam Okafor" };
const BOT: Person = { id: "u-bot", name: "Deploy Bot" };
const PEOPLE = [SELF, JORDAN, PRIYA, SAM, BOT];

const REACTION_EMOJI: Readonly<Record<string, string>> = { OK: "👌", THUMBSUP: "👍" };

const EXAMPLE_REPLY_DELAY_MS = 30_000;
/** Small pages, so the inbox's paging runs against the example too. */
const EXAMPLE_PAGE_SIZE = 2;
const OPEN_URL_BASE = "https://chat.example.com";

function hoursAgo(now: number, hours: number) {
  return DateTime.formatIso(DateTime.makeUnsafe(now - hours * 3_600_000));
}

function seed(now: number): ExampleConversation[] {
  const message = (
    id: string,
    replyToId: string | null,
    hours: number,
    author: Person,
    text: string,
    extra: Partial<ExampleMessage> = {},
  ): ExampleMessage => ({
    id,
    replyToId,
    createdAt: hoursAgo(now, hours),
    author,
    mentionsSelf: false,
    text,
    attachments: [],
    links: [],
    ...extra,
  });
  return [
    {
      id: "c-dm-jordan",
      kind: "dm",
      name: JORDAN.name,
      relevant: true,
      muted: false,
      messages: [
        message(
          "m-1",
          null,
          2.5,
          JORDAN,
          "Hey, the nightly export job failed again. Can you take a look before the 4pm sync?",
        ),
        message(
          "m-2",
          null,
          2.4,
          JORDAN,
          "Logs are in the dashboard: https://dashboard.example.com/jobs/export-nightly",
          { links: ["https://dashboard.example.com/jobs/export-nightly"] },
        ),
      ],
    },
    {
      id: "c-platform",
      kind: "group",
      name: "Platform team",
      relevant: true,
      muted: true,
      messages: [
        message(
          "m-10",
          null,
          5,
          PRIYA,
          "@Alex Rivera the cache hit rate dropped after yesterday's deploy, see the chart.",
          {
            mentionsSelf: true,
            attachments: [{ key: "chart", kind: "image", name: "cache-hit-rate.svg" }],
          },
        ),
        message("m-11", "m-10", 4.5, SAM, "I saw the same on the staging cluster.", {
          inThread: true,
        }),
        message("m-20", null, 52, PRIYA, "Who owns the retry budget config now?"),
        message(
          "m-21",
          "m-20",
          30,
          SELF,
          "I do. I'll send a proposal for the new limits by Friday.",
        ),
        message(
          "m-22",
          "m-20",
          6.5,
          SAM,
          "@Alex Rivera same drop here, chart below. cc @Priya Shah",
          {
            mentionsSelf: true,
            attachments: [{ key: "chart", kind: "image", name: "cache-hit-rate.svg" }],
          },
        ),
        message("m-30", null, 8, SAM, "Reminder: on-call handover is at 10am tomorrow.", {
          reactions: [
            { key: "THUMBSUP", emoji: "👍", users: [PRIYA, JORDAN, SELF] },
            { key: "OK", emoji: "👌", users: [JORDAN] },
          ],
          editedAt: hoursAgo(now, 7.9),
        }),
        message(
          "m-31",
          null,
          7,
          SAM,
          "Jordan: [Image] The export job retries are exhausted before the upstream recovers, so every nightly run after an incident fails the same way. We either raise the retry budget or move the job after the upstream maintenance window, and I don't think we have a full picture of the upstream schedule yet.\nPriya: I'll ask the upstream team for their maintenance calendar.",
          { richSummary: "Forwarded · Chat between Jordan and Priya · 2 messages" },
        ),
        message("m-32", null, 6.8, JORDAN, "", {
          attachments: [{ key: "chart", kind: "image", name: "cache-hit-rate.svg" }],
          reactions: [{ key: "THUMBSUP", emoji: "👍", users: [SAM] }],
        }),
      ],
    },
    {
      id: "c-release",
      kind: "topic_group",
      name: "Release coordination",
      relevant: true,
      muted: false,
      messages: [
        message("m-40", null, 3, BOT, "Release 2.14.0 is ready for sign-off.", {
          richSummary: "[Card] Release 2.14.0 · 37 changes · Approve / Reject",
          links: ["https://ci.example.com/releases/2.14.0/changes?view=summary&group=team"],
        }),
        message(
          "m-45",
          null,
          2,
          SAM,
          [
            "### 1. Deploy plan has its own route",
            "- Preview moves from `POST /deployments?dry_run=true` to `POST /apps/:app_id/deployment-plan`.",
            "- `POST /deployments` only starts a deploy and rejects `dry_run`.",
            "",
            "### 2. Live versions",
            "- The release panel shows the **live** version per lane.",
            "",
            "@Alex Rivera @Priya Shah please review before Thursday.",
          ].join("\n"),
          { mentionsSelf: true },
        ),
        message("m-50", null, 26, JORDAN, "Can we move the freeze to Thursday?"),
        message("m-51", "m-50", 25, SELF, "Fine by me if QA agrees.", { inThread: true }),
        message("m-52", "m-51", 1, PRIYA, "QA agrees. @Alex Rivera can you update the calendar?", {
          mentionsSelf: true,
          inThread: true,
        }),
        message("m-53", "m-50", 0.8, SAM, "Infra is fine with Thursday too.", { inThread: true }),
        message("m-54", "m-50", 0.5, JORDAN, "Great, I'll post the new date in #releases.", {
          inThread: true,
        }),
      ],
    },
    {
      id: "c-random",
      kind: "group",
      name: "Random",
      relevant: false,
      muted: true,
      messages: [message("m-60", null, 6, SAM, "Lunch at the new place?")],
    },
  ];
}

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">
<rect width="480" height="240" fill="#f8fafc"/>
<text x="16" y="28" font-family="sans-serif" font-size="16" fill="#0f172a">Cache hit rate (example)</text>
<polyline fill="none" stroke="#2563eb" stroke-width="3" points="16,80 96,76 176,82 256,78 336,170 416,176 464,172"/>
<line x1="336" y1="40" x2="336" y2="220" stroke="#dc2626" stroke-dasharray="4 4"/>
<text x="342" y="56" font-family="sans-serif" font-size="12" fill="#dc2626">deploy</text>
</svg>`;

const encoder = new TextEncoder();

function json(status: number, value: unknown): AdapterResponse {
  return {
    status,
    contentType: "application/json",
    body: encoder.encode(JSON.stringify(value)),
  };
}

function lastOf<T>(items: ReadonlyArray<T>): T | undefined {
  return items[items.length - 1];
}

function paginate<T>(items: ReadonlyArray<T>, url: URL) {
  const requested = Number(url.searchParams.get("limit"));
  const limit = Math.min(
    EXAMPLE_PAGE_SIZE,
    Number.isInteger(requested) && requested > 0 ? requested : EXAMPLE_PAGE_SIZE,
  );
  const offset = Number(url.searchParams.get("cursor") ?? "0");
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const end = start + limit;
  return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
}

export interface ExampleChannel extends ChannelTransport {
  readonly simulation: () => ExampleSimulation;
  readonly setSimulation: (simulation: ExampleSimulation) => Effect.Effect<void>;
}

export const createExampleChannel = Effect.fn("ExampleChannel.make")(function* (
  options: { readonly now?: () => number } = {},
) {
  const clock = yield* Clock.Clock;
  const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
  const conversations = seed(now());
  const listeners = new Set<(event: ChannelEvent) => void>();
  let reply: Effect.Effect<void> | null = null;
  /** Uploaded files, kept so a sent attachment can be shown again. */
  const uploads = new Map<string, { name: string; contentType: string; bytes: Uint8Array }>();
  let nextId = 1000;
  let simulation: ExampleSimulation = "online";

  const emit = (event: ChannelEvent) => {
    for (const listener of listeners) listener(event);
  };

  const isSelf = (person: Person) => person.id === SELF.id;
  const preview = (item: ExampleMessage) =>
    (item.text || item.richSummary || item.attachments[0]?.name || "").slice(0, 140);
  const byTime = (items: ReadonlyArray<ExampleMessage>) =>
    items.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  /** The thread's root: a reply's root is the root of the message it answers. */
  const rootOf = (conversation: ExampleConversation, item: ExampleMessage): ExampleMessage => {
    const parent =
      item.replyToId === null
        ? undefined
        : conversation.messages.find((candidate) => candidate.id === item.replyToId);
    return parent ? rootOf(conversation, parent) : item;
  };

  const toWire = (conversation: ExampleConversation, item: ExampleMessage) => {
    const parent = conversation.messages.find((candidate) => candidate.id === item.replyToId);
    const root = rootOf(conversation, item);
    // A quote reply stays on the timeline; only what sits in the thread counts.
    const replyCount = conversation.messages.filter(
      (candidate) =>
        candidate.id !== item.id &&
        candidate.inThread === true &&
        rootOf(conversation, candidate).id === item.id,
    ).length;
    return {
      id: item.id,
      createdAt: item.createdAt,
      rootId: root.id === item.id ? null : root.id,
      replyTo:
        item.replyToId === null
          ? null
          : {
              id: item.replyToId,
              authorName: parent?.author.name ?? null,
              preview: parent ? preview(parent) : null,
            },
      author: { ...item.author, isSelf: isSelf(item.author) },
      inThread: item.inThread ?? false,
      mentionsSelf: item.mentionsSelf,
      text: item.text,
      richSummary: item.richSummary ?? null,
      attachments: item.attachments,
      links: item.links,
      openUrl: `${OPEN_URL_BASE}/${conversation.id}/${item.id}`,
      mentions: PEOPLE.filter((person) => item.text.includes(`@${person.name}`)).map((person) => ({
        userId: person.id,
        name: person.name,
        isSelf: isSelf(person),
      })),
      reactions: (item.reactions ?? []).map((reaction) => ({
        key: reaction.key,
        emoji: reaction.emoji,
        count: reaction.users.length,
        users: reaction.users.map((person) => person.name),
        includesSelf: reaction.users.some(isSelf),
      })),
      editedAt: item.editedAt ?? null,
      replyCount: replyCount > 0 ? replyCount : null,
    };
  };

  const summaryOf = (conversation: ExampleConversation) => {
    const messages = byTime(conversation.messages);
    const last = lastOf(messages);
    return {
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      lastActivityAt: last?.createdAt ?? DateTime.formatIso(DateTime.makeUnsafe(0)),
      relevant: conversation.relevant,
      muted: conversation.muted,
      lastMessage: last
        ? {
            id: last.id,
            createdAt: last.createdAt,
            author: { ...last.author, isSelf: isSelf(last.author) },
            preview: preview(last),
          }
        : null,
      lastOtherMessageAt: messages.findLast((item) => !isSelf(item.author))?.createdAt ?? null,
      lastSelfMessageAt: messages.findLast((item) => isSelf(item.author))?.createdAt ?? null,
      lastMentionAt: messages.findLast((item) => item.mentionsSelf)?.createdAt ?? null,
      selfReadThroughAt: null,
      unreadCount: messages.length - 1 - messages.findLastIndex((item) => isSelf(item.author)),
    };
  };

  const append = (conversation: ExampleConversation, item: ExampleMessage) => {
    conversation.messages.push(item);
    emit({ type: "message.created", conversationId: conversation.id });
  };

  const send = (body: unknown): AdapterResponse => {
    const input = body as {
      conversationId?: unknown;
      replyToId?: unknown;
      inThread?: unknown;
      text?: unknown;
      mentions?: ReadonlyArray<{ userId?: unknown }>;
      attachments?: ReadonlyArray<{ uploadId?: unknown }>;
    } | null;
    const conversation = conversations.find((item) => item.id === input?.conversationId);
    const files = (Array.isArray(input?.attachments) ? input.attachments : []).map((attachment) =>
      String(attachment.uploadId),
    );
    const text = typeof input?.text === "string" ? input.text : "";
    if (!conversation || (text.trim().length === 0 && files.length === 0)) {
      return json(400, {
        error: { code: "rejected", message: "Unknown conversation or empty message." },
      });
    }
    if (files.some((uploadId) => !uploads.has(uploadId))) {
      return json(400, {
        error: { code: "rejected", message: "An attachment expired; attach it again." },
      });
    }
    const target = conversation.messages.find((item) => item.id === input?.replyToId);
    // A quote stays on the timeline and answers exactly the message it quotes.
    const quoted = target !== undefined && input?.inThread === false;
    // Like Feishu, a thread reply lands under its thread's root, whichever message it answered.
    const replyToId = target ? (quoted ? target.id : rootOf(conversation, target).id) : null;
    // Without a choice, a reply stays in the thread where the chat app keeps threads off the timeline.
    const inThread =
      replyToId !== null &&
      !quoted &&
      (input?.inThread === true ||
        conversation.kind === "topic_group" ||
        conversation.messages.some(
          (item) => item.inThread === true && rootOf(conversation, item).id === replyToId,
        ));
    const own = (attachments: ExampleMessage["attachments"], body: string) => {
      const id = `m-${nextId++}`;
      append(conversation, {
        id,
        replyToId,
        inThread,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
        author: SELF,
        mentionsSelf: false,
        text: body,
        attachments,
        links: [],
      });
      return id;
    };
    // One message holds one kind of content: the text first, then a message per file.
    const messageIds = [
      ...(text.trim().length > 0 ? [own([], text)] : []),
      ...files.map((uploadId) => {
        const file = uploads.get(uploadId)!;
        const kind = file.contentType.startsWith("image/") ? "image" : "file";
        return own([{ key: uploadId, kind, name: file.name }], "");
      }),
    ];
    const messageId = messageIds[0]!;
    const other =
      conversation.messages.findLast((item) => item.author.id !== SELF.id)?.author ?? JORDAN;
    reply = Effect.sleep(EXAMPLE_REPLY_DELAY_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          append(conversation, {
            id: `m-${nextId++}`,
            replyToId,
            inThread,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
            author: other,
            mentionsSelf: false,
            text: "Thanks, got it. (This is an automatic reply from the example channel.)",
            attachments: [],
            links: [],
          });
        }),
      ),
    );
    // Only someone who wrote here can be mentioned; anyone else went out as plain text.
    const unresolvedMentions = (Array.isArray(input?.mentions) ? input.mentions : [])
      .map((mention) => mention.userId)
      .filter((userId) => !conversation.messages.some((item) => item.author.id === userId));
    return json(200, { messageId, messageIds, unresolvedMentions });
  };

  const react = (body: unknown): AdapterResponse => {
    const input = body as { conversationId?: unknown; messageId?: unknown; key?: unknown } | null;
    const conversation = conversations.find((item) => item.id === input?.conversationId);
    const index = conversation?.messages.findIndex((item) => item.id === input?.messageId) ?? -1;
    const key = typeof input?.key === "string" ? input.key : "";
    if (!conversation || index === -1 || key.length === 0) {
      return json(400, { error: { code: "rejected", message: "Unknown message or reaction." } });
    }
    const target = conversation.messages[index]!;
    const reactions = target.reactions ?? [];
    const existing = reactions.find((reaction) => reaction.key === key);
    conversation.messages[index] = {
      ...target,
      reactions: existing
        ? reactions.map((reaction) =>
            reaction === existing && !reaction.users.some(isSelf)
              ? { ...reaction, users: [...reaction.users, SELF] }
              : reaction,
          )
        : [...reactions, { key, emoji: REACTION_EMOJI[key] ?? null, users: [SELF] }],
    };
    emit({ type: "conversation.updated", conversationId: conversation.id });
    return json(200, {});
  };

  const IMAGE_TYPES: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };

  const upload = (url: URL, bytes: Uint8Array | undefined): AdapterResponse => {
    const name = url.searchParams.get("name") ?? "";
    if (name.length === 0 || bytes === undefined || bytes.byteLength === 0) {
      return json(400, { error: { code: "rejected", message: "Name a file that is not empty." } });
    }
    const contentType =
      IMAGE_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
    const uploadId = `up-${nextId++}`;
    uploads.set(uploadId, { name, contentType, bytes });
    return json(200, {
      uploadId,
      kind: contentType.startsWith("image/") ? "image" : "file",
      name,
      size: bytes.byteLength,
    });
  };

  const handle = (request: AdapterRequest): AdapterResponse => {
    const url = new URL(request.path, "http://example.invalid");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST") {
      if (segments.length === 1 && segments[0] === "messages") return send(request.body);
      if (segments.length === 1 && segments[0] === "uploads") return upload(url, request.bytes);
      if (segments.length === 1 && segments[0] === "reactions") return react(request.body);
      return json(404, { error: { code: "unknown", message: "Not found" } });
    }
    const [head, id, tail] = segments;
    if (head === "health" && segments.length === 1) {
      return json(200, {
        protocol:
          simulation === "incompatible" ? CHANNEL_PROTOCOL_VERSION + 1 : CHANNEL_PROTOCOL_VERSION,
        adapterVersion: "example-1.0.0",
        online: simulation !== "collector_stopped",
        loggedIn: simulation !== "needs_login",
        lastSyncAt: DateTime.formatIso(DateTime.makeUnsafe(now())),
        self: { name: SELF.name },
        logsUrl: null,
        lastError:
          simulation === "needs_login"
            ? "Simulated: the session expired."
            : simulation === "collector_stopped"
              ? "Simulated: the collector stopped."
              : null,
      });
    }
    if (head === "config" && segments.length === 1) {
      return json(200, {
        displayName: "Example",
        defaultProjectPaths: ["~/code/example-service"],
        relevanceSummary:
          "Direct messages, mentions of you, and threads you took part in. Conversations you follow show their new threads too. Muted conversations are left out.",
        capabilities: ["mentions", "markdown", "attachments", "quotes"],
        ackReaction: "OK",
      });
    }
    if (head === "conversations" && segments.length === 1) {
      const relevantOnly = url.searchParams.get("relevant") === "1";
      const items = conversations
        .filter((item) => !relevantOnly || item.relevant)
        .map(summaryOf)
        // Newest first, as the protocol requires: a capped read keeps the latest.
        .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      return json(200, paginate(items, url));
    }
    const conversation =
      head === "conversations" ? conversations.find((item) => item.id === id) : undefined;
    if (conversation && tail === "messages" && segments.length === 3) {
      const root = url.searchParams.get("root");
      const items = conversation.messages
        .filter((item) => root === null || rootOf(conversation, item).id === root)
        .map((item) => toWire(conversation, item));
      // Seed messages are not stored in time order.
      const ordered =
        url.searchParams.get("order") === "desc"
          ? items.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
          : items;
      return json(200, paginate(ordered, url));
    }
    if (head === "media" && segments.length === 3 && tail === "chart") {
      const owner = conversations.some((item) =>
        item.messages.some((candidate) => candidate.id === id),
      );
      if (owner) {
        return { status: 200, contentType: "image/svg+xml", body: encoder.encode(CHART_SVG) };
      }
    }
    const uploaded = head === "media" && tail !== undefined ? uploads.get(tail) : undefined;
    if (uploaded && segments.length === 3) {
      return { status: 200, contentType: uploaded.contentType, body: uploaded.bytes };
    }
    return json(404, { error: { code: "unknown", message: "Not found" } });
  };

  return {
    request: Effect.fn("ExampleChannel.request")(function* (input: AdapterRequest) {
      if (simulation === "unreachable")
        return yield* new AdapterUnreachableError({ message: "Simulated: connection refused." });
      const scope = yield* Scope.Scope;
      const response = handle(input);
      if (reply !== null) {
        const pending = reply;
        reply = null;
        yield* pending.pipe(Effect.forkIn(scope));
      }
      return response;
    }),
    events: () =>
      Stream.callback<ChannelEvent, AdapterUnreachableError>((events) =>
        Effect.gen(function* () {
          if (simulation === "unreachable")
            return yield* new AdapterUnreachableError({
              message: "Simulated: connection refused.",
            });
          const emit = (event: ChannelEvent) => {
            Queue.offerUnsafe(events, event);
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              listeners.add(emit);
            }),
            () =>
              Effect.sync(() => {
                listeners.delete(emit);
              }),
          );
          yield* Queue.offer(events, { type: "connected" });
        }),
      ),
    simulation: () => simulation,
    setSimulation: Effect.fn("ExampleChannel.setSimulation")((next: ExampleSimulation) =>
      Effect.sync(() => {
        simulation = next;
        emit({ type: "health.changed" });
      }),
    ),
  } satisfies ExampleChannel;
});
