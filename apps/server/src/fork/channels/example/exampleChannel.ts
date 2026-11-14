// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off extendsNativeError:off - Runs outside the Effect runtime: adapter sockets, timers, and plain callbacks.
/**
 * The built-in example channel: protocol v1 served in process from made-up data, for
 * development, tests, screenshots, and trying the inbox without a real adapter.
 */
import { CHANNEL_PROTOCOL_VERSION, type ChannelEvent } from "../protocol.ts";
import type { AdapterRequest, AdapterResponse, ChannelTransport } from "../transport.ts";

interface Person {
  readonly id: string;
  readonly name: string;
}

interface ExampleMessage {
  readonly id: string;
  readonly topicId: string;
  readonly createdAt: string;
  readonly author: Person;
  readonly mentionsSelf: boolean;
  readonly text: string;
  readonly richSummary?: string;
  readonly attachments: ReadonlyArray<{ key: string; kind: "image" | "file"; name: string }>;
  readonly links: ReadonlyArray<string>;
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

const EXAMPLE_REPLY_DELAY_MS = 30_000;
const OPEN_URL_BASE = "https://chat.example.com";

function hoursAgo(now: number, hours: number) {
  return new Date(now - hours * 3_600_000).toISOString();
}

function seed(now: number): ExampleConversation[] {
  const message = (
    id: string,
    topicId: string,
    hours: number,
    author: Person,
    text: string,
    extra: Partial<ExampleMessage> = {},
  ): ExampleMessage => ({
    id,
    topicId,
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
          "t-dm-1",
          2.5,
          JORDAN,
          "Hey, the nightly export job failed again. Can you take a look before the 4pm sync?",
        ),
        message(
          "m-2",
          "t-dm-1",
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
      muted: false,
      messages: [
        message(
          "m-10",
          "t-platform-1",
          5,
          PRIYA,
          "@Alex Rivera the cache hit rate dropped after yesterday's deploy, see the chart.",
          {
            mentionsSelf: true,
            attachments: [{ key: "chart", kind: "image", name: "cache-hit-rate.svg" }],
          },
        ),
        message("m-11", "t-platform-1", 4.5, SAM, "I saw the same on the staging cluster."),
        message("m-20", "t-platform-2", 52, PRIYA, "Who owns the retry budget config now?"),
        message(
          "m-21",
          "t-platform-2",
          30,
          SELF,
          "I do. I'll send a proposal for the new limits by Friday.",
        ),
        message("m-30", "t-platform-3", 8, SAM, "Reminder: on-call handover is at 10am tomorrow."),
      ],
    },
    {
      id: "c-release",
      kind: "topic_group",
      name: "Release coordination",
      relevant: true,
      muted: false,
      messages: [
        message("m-40", "t-release-1", 3, BOT, "Release 2.14.0 is ready for sign-off.", {
          richSummary: "[Card] Release 2.14.0 · 37 changes · Approve / Reject",
        }),
        message("m-50", "t-release-2", 26, JORDAN, "Can we move the freeze to Thursday?"),
        message("m-51", "t-release-2", 25, SELF, "Fine by me if QA agrees."),
        message(
          "m-52",
          "t-release-2",
          1,
          PRIYA,
          "QA agrees. @Alex Rivera can you update the calendar?",
          {
            mentionsSelf: true,
          },
        ),
      ],
    },
    {
      id: "c-random",
      kind: "group",
      name: "Random",
      relevant: false,
      muted: true,
      messages: [message("m-60", "t-random-1", 6, SAM, "Lunch at the new place?")],
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

export interface ExampleChannel extends ChannelTransport {
  readonly dispose: () => void;
}

export function createExampleChannel(
  options: { readonly now?: () => number } = {},
): ExampleChannel {
  const now = options.now ?? Date.now;
  const conversations = seed(now());
  const listeners = new Set<(event: ChannelEvent) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let nextId = 1000;

  const emit = (event: ChannelEvent) => {
    for (const listener of listeners) listener(event);
  };

  const topicsOf = (conversation: ExampleConversation) => {
    const byTopic = new Map<string, ExampleMessage[]>();
    for (const item of conversation.messages) {
      const list = byTopic.get(item.topicId) ?? [];
      list.push(item);
      byTopic.set(item.topicId, list);
    }
    return [...byTopic.entries()]
      .map(([topicId, messages]) => {
        const root = messages[0]!;
        const last = lastOf(messages)!;
        return {
          id: topicId,
          rootMessageId: root.id,
          rootPreview: root.text.slice(0, 140),
          replyCount: messages.length - 1,
          lastMessageAt: last.createdAt,
          lastAuthor: { ...last.author, isSelf: last.author.id === SELF.id },
          participatedBySelf: messages.some((item) => item.author.id === SELF.id),
        };
      })
      .toSorted((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  };

  const append = (conversation: ExampleConversation, item: ExampleMessage) => {
    conversation.messages.push(item);
    emit({
      type: "message.created",
      conversationId: conversation.id,
      topicId: item.topicId,
      messageId: item.id,
    });
  };

  const send = (body: unknown): AdapterResponse => {
    const input = body as { conversationId?: unknown; topicId?: unknown; text?: unknown } | null;
    const conversation = conversations.find((item) => item.id === input?.conversationId);
    if (!conversation || typeof input?.text !== "string" || input.text.trim().length === 0) {
      return json(400, {
        error: { code: "rejected", message: "Unknown conversation or empty text." },
      });
    }
    const topicId =
      typeof input.topicId === "string" &&
      conversation.messages.some((item) => item.topicId === input.topicId)
        ? input.topicId
        : `t-new-${nextId}`;
    const messageId = `m-${nextId++}`;
    append(conversation, {
      id: messageId,
      topicId,
      createdAt: new Date(now()).toISOString(),
      author: SELF,
      mentionsSelf: false,
      text: input.text,
      attachments: [],
      links: [],
    });
    const other =
      conversation.messages.findLast((item) => item.author.id !== SELF.id)?.author ?? JORDAN;
    const timer = setTimeout(() => {
      timers.delete(timer);
      append(conversation, {
        id: `m-${nextId++}`,
        topicId,
        createdAt: new Date(now()).toISOString(),
        author: other,
        mentionsSelf: false,
        text: "Thanks, got it. (This is an automatic reply from the example channel.)",
        attachments: [],
        links: [],
      });
    }, EXAMPLE_REPLY_DELAY_MS);
    timer.unref?.();
    timers.add(timer);
    return json(200, { messageId });
  };

  const handle = (request: AdapterRequest): AdapterResponse => {
    const url = new URL(request.path, "http://example.invalid");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST") {
      return segments.length === 1 && segments[0] === "messages"
        ? send(request.body)
        : json(404, { error: { code: "unknown", message: "Not found" } });
    }
    const [head, id, tail] = segments;
    if (head === "health" && segments.length === 1) {
      return json(200, {
        protocol: CHANNEL_PROTOCOL_VERSION,
        adapterVersion: "example-1.0.0",
        online: true,
        loggedIn: true,
        lastSyncAt: new Date(now()).toISOString(),
        self: { id: SELF.id, name: SELF.name },
        logsUrl: null,
        lastError: null,
      });
    }
    if (head === "config" && segments.length === 1) {
      return json(200, {
        displayName: "Example",
        icon: null,
        defaultProjectPaths: ["~/code/example-service"],
        delegateTemplates: [
          {
            id: "investigate",
            name: "Investigate (read only)",
            prompt:
              "A message thread needs a look. Read {contextDir}/context.md for the full conversation and any images.\n\nInvestigate without changing code. Write your findings to {contextDir}/conclusion.md and a short reply I can send to {contextDir}/draft.md.\n\nNote from me: {note}\nOriginal thread: {openUrl}",
          },
          {
            id: "fix",
            name: "Fix it",
            prompt:
              "A message thread reports a problem. Read {contextDir}/context.md first.\n\nFind the cause and fix it in this project. Then write what you changed to {contextDir}/conclusion.md and a short reply I can send to {contextDir}/draft.md.\n\nNote from me: {note}\nOriginal thread: {openUrl}",
          },
        ],
        relevanceSummary:
          "Direct messages, mentions of you, and threads you took part in. Conversations you follow show their new threads too. Muted conversations are left out.",
      });
    }
    if (head === "conversations" && segments.length === 1) {
      const relevantOnly = url.searchParams.get("relevant") === "1";
      const items = conversations
        .filter((item) => !relevantOnly || item.relevant)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          lastActivityAt: lastOf(item.messages)?.createdAt ?? new Date(0).toISOString(),
          relevant: item.relevant,
          muted: item.muted,
        }));
      return json(200, { items, nextCursor: null });
    }
    const conversation =
      head === "conversations" ? conversations.find((item) => item.id === id) : undefined;
    if (conversation && tail === "topics" && segments.length === 3) {
      return json(200, { items: topicsOf(conversation), nextCursor: null });
    }
    if (conversation && tail === "messages" && segments.length === 3) {
      const topic = url.searchParams.get("topic");
      const items = conversation.messages
        .filter((item) => topic === null || item.topicId === topic)
        .map((item) => ({
          ...item,
          author: { ...item.author, isSelf: item.author.id === SELF.id },
          richSummary: item.richSummary ?? null,
          openUrl: `${OPEN_URL_BASE}/${conversation.id}/${item.topicId}/${item.id}`,
        }));
      return json(200, { items, nextCursor: null });
    }
    if (head === "media" && segments.length === 3 && tail === "chart") {
      const owner = conversations.some((item) =>
        item.messages.some((candidate) => candidate.id === id),
      );
      if (owner) {
        return { status: 200, contentType: "image/svg+xml", body: encoder.encode(CHART_SVG) };
      }
    }
    return json(404, { error: { code: "unknown", message: "Not found" } });
  };

  return {
    request: async (request) => handle(request),
    events: (_token, onEvent, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        listeners.add(onEvent);
        signal.addEventListener("abort", () => {
          listeners.delete(onEvent);
          resolve();
        });
      }),
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },
  };
}
