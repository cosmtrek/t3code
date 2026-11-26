import { describe, expect, it } from "vite-plus/test";

import type { InboxConversation, InboxDelegation, InboxMessage } from "../types";
import {
  anchorOf,
  attentionOf,
  conversationRows,
  delegationPreview,
  draftReplyMode,
  emptyViewTitle,
  inView,
  lastMessageLine,
  mentionablePeople,
  mentionParts,
  mentionSuggestions,
  mentionsIn,
  mergeConversationPages,
  minuteToMs,
  matchesFilter,
  quoteOf,
  quoteOfMessage,
  replyLine,
  replyModes,
  shortLink,
  topFollowUp,
  topicsOf,
  unreadMessageCount,
  withoutMention,
} from "./inboxView";

describe("emptyViewTitle", () => {
  it.each([
    ["unread", "all", "Nothing unread"],
    ["unread", "dm", "No unread DMs"],
    ["following", "groups", "No follow-ups in groups"],
    ["unread", "topics", "No unread topic groups"],
    ["all", "dm", "No DMs"],
  ] as const)("names an empty %s list filtered to %s", (view, filter, title) => {
    expect(emptyViewTitle(view, filter)).toBe(title);
  });
});

describe("inView", () => {
  const conversation = (unread: boolean, mentioned = false, muted = false) =>
    ({ id: "c", kind: "group", unread, mentioned, muted }) as InboxConversation;

  it("lists in Unread what has new messages or a mention", () => {
    expect(inView("unread", "all", conversation(true))).toBe(true);
    expect(inView("unread", "all", conversation(false, true))).toBe(true);
    expect(inView("unread", "all", conversation(false))).toBe(false);
    expect(inView("all", "all", conversation(false))).toBe(true);
  });

  it("lists a muted conversation in Unread only when it mentions you", () => {
    expect(inView("unread", "all", conversation(true, false, true))).toBe(false);
    expect(inView("unread", "all", conversation(true, true, true))).toBe(true);
    expect(inView("all", "all", conversation(true, false, true))).toBe(true);
  });

  it("keeps the held conversation in Unread after it is read, and only that one", () => {
    expect(inView("unread", "all", conversation(false), "c")).toBe(true);
    expect(inView("unread", "all", conversation(false), "other")).toBe(false);
    expect(inView("unread", "dm", conversation(false), "c")).toBe(false);
  });

  it("lists in Unread a follow-up that left you something, and in Following any open one", () => {
    const waiting = [{ agentUnseen: false, hasDraft: true }];
    const working = [{ agentUnseen: false, hasDraft: false }];
    expect(inView("unread", "all", conversation(false), null, waiting)).toBe(true);
    expect(inView("unread", "all", conversation(false), null, working)).toBe(false);
    expect(inView("following", "all", conversation(false), null, working)).toBe(true);
    expect(inView("following", "all", conversation(true), null, [])).toBe(false);
  });
});

describe("attentionOf", () => {
  const conversation = (extra: Partial<InboxConversation>) =>
    ({ kind: "group", unread: false, mentioned: false, ...extra }) as InboxConversation;
  const followUp = (agentUnseen: boolean, hasDraft: boolean) => ({ agentUnseen, hasDraft });

  it("puts what waits on you first, then what is followed up, then the rest", () => {
    expect(attentionOf(conversation({ kind: "dm", unread: true }), [])).toBe(0);
    expect(attentionOf(conversation({ mentioned: true }), [])).toBe(0);
    expect(attentionOf(conversation({}), [followUp(true, false)])).toBe(0);
    expect(attentionOf(conversation({}), [followUp(false, true)])).toBe(0);
    expect(attentionOf(conversation({ unread: true }), [followUp(false, false)])).toBe(1);
    expect(attentionOf(conversation({ unread: true }), [])).toBe(2);
  });
});

describe("topFollowUp", () => {
  const delegation = (id: string, extra: Partial<InboxDelegation> = {}) =>
    ({ id, agentUnseen: false, hasDraft: false, settledAt: null, ...extra }) as InboxDelegation;

  it("shows the open follow-up that needs you, else the newest open one, never a settled one", () => {
    expect(topFollowUp([delegation("new"), delegation("draft", { hasDraft: true })])?.id).toBe(
      "draft",
    );
    expect(topFollowUp([delegation("new"), delegation("old")])?.id).toBe("new");
    expect(topFollowUp([delegation("done", { settledAt: "2026-11-26T00:00:00Z" })])).toBe(
      undefined,
    );
  });
});

describe("unreadMessageCount", () => {
  it("counts unread messages, 1 without a count, and only the mention when muted", () => {
    const conversation = (extra: Partial<InboxConversation>) =>
      ({
        id: "c",
        kind: "group",
        unread: true,
        mentioned: false,
        muted: false,
        ...extra,
      }) as InboxConversation;
    expect(
      unreadMessageCount("all", [
        conversation({ unreadCount: 12 }),
        conversation({ unreadCount: null }),
        conversation({ unreadCount: 0 }),
        conversation({ unreadCount: 30, muted: true }),
        conversation({ unreadCount: 30, muted: true, mentioned: true }),
        conversation({ unread: false, unreadCount: 0 }),
        conversation({ kind: "dm", unreadCount: 5 }),
      ]),
    ).toBe(12 + 1 + 1 + 1 + 5);
    expect(unreadMessageCount("dm", [conversation({ kind: "dm", unreadCount: 5 })])).toBe(5);
  });
});

describe("lastMessageLine", () => {
  const line = (kind: "dm" | "group", name: string, isSelf: boolean) =>
    lastMessageLine({
      kind,
      lastMessage: { id: "m", createdAt: "", author: { id: "u", name, isSelf }, preview: "hi" },
    });
  it.each([
    ["names the author in a group", line("group", "Sam", false), "Sam: hi"],
    ["leaves the other person out of a DM", line("dm", "Sam", false), "hi"],
    ["says when I wrote last", line("dm", "Me", true), "You: hi"],
    ["leaves out a nameless author", line("group", " ", false), "hi"],
  ])("%s", (_case, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("minuteToMs", () => {
  it("reads useNowMinute's zoneless minute as UTC", () => {
    expect(minuteToMs("2026-11-15T14:41")).toBe(Date.UTC(2026, 10, 15, 14, 41));
  });
});

describe("conversationRows", () => {
  const message = (id: string, replyTo: InboxMessage["replyTo"] = null, author = "Sam") =>
    ({
      id,
      replyTo,
      text: `text ${id}`,
      author: { id: author, name: author, isSelf: false },
    }) as InboxMessage;

  it("quotes what a reply answers: the loaded message, else the adapter's preview", () => {
    const rows = conversationRows(
      [
        message("r1"),
        message("a1", { id: "r1", authorName: null, preview: null }, "Kim"),
        message("o2", { id: "o1", authorName: "Lee", preview: "older text" }),
        message("o3", { id: "gone", authorName: null, preview: null }),
      ],
      [{ id: "d1", anchorMessageId: "r1" } as InboxDelegation],
    );
    expect(rows.map((row) => [row.message.id, row.quote, row.delegations.length])).toEqual([
      ["r1", null, 1],
      ["a1", "Sam: text r1", 0],
      ["o2", "Lee: older text", 0],
      ["o3", "An earlier message", 0],
    ]);
  });

  it("keeps a thread's replies under its root, off the timeline", () => {
    const inThread = (id: string, rootId: string) =>
      ({ ...message(id), rootId, inThread: true }) as InboxMessage;
    const rows = conversationRows(
      [
        message("r1"),
        inThread("t1", "r1"),
        // A quoted reply has a root too, and stays on the timeline.
        { ...message("q1"), rootId: "r1" } as InboxMessage,
        inThread("t2", "r1"),
        inThread("orphan", "not-loaded"),
      ],
      [],
    );
    expect(
      rows.map((row) => [row.message.id, row.thread.map((reply) => reply.message.id)]),
    ).toEqual([
      ["r1", ["t1", "t2"]],
      ["q1", []],
      ["orphan", []],
    ]);
  });

  it("orders topics by their newest reply, and gathers replies whose post is not loaded", () => {
    const at = (id: string, minute: number, extra: Partial<InboxMessage> = {}) =>
      ({
        ...message(id),
        createdAt: `2026-11-16T10:${String(minute).padStart(2, "0")}:00Z`,
        ...extra,
      }) as InboxMessage;
    const reply = (id: string, minute: number, rootId: string) =>
      at(id, minute, {
        rootId,
        inThread: true,
        replyTo: { id: rootId, authorName: "Lee", preview: "old post" },
      });
    const topics = topicsOf(
      conversationRows(
        [
          at("old", 1),
          at("new", 2),
          reply("r1", 3, "old"),
          reply("o1", 4, "gone"),
          reply("o2", 5, "gone"),
        ],
        [],
      ),
    );
    expect(
      topics.map((topic) => [
        topic.id,
        topic.post?.message.id ?? null,
        topic.heading,
        topic.replies.map((row) => row.message.id),
      ]),
    ).toEqual([
      ["new", "new", null, []],
      ["old", "old", null, ["r1"]],
      ["gone", null, "Lee: old post", ["o1", "o2"]],
    ]);
  });

  it("writes a folded reply as one line, naming an image or file when it has no text", () => {
    expect(replyLine({ ...message("a"), text: "first\n  second" })).toBe("Sam: first second");
    const image = {
      ...message("b"),
      text: "",
      richSummary: null,
      attachments: [{ key: "k", kind: "image" as const, name: "x.png" }],
    };
    expect(replyLine(image)).toBe("Sam: [Image]");
    expect(quoteOfMessage(image)).toBe("Sam: [Image]");
    const forward = {
      ...message("c"),
      text: "Jordan 12:20: the export failed",
      richSummary: "Forwarded · 2 messages",
    };
    expect(replyLine(forward)).toBe("Sam: Forwarded · 2 messages");
    expect(quoteOfMessage(forward)).toBe("Sam: Forwarded · 2 messages");
  });

  it("cuts a quote at 40 characters", () => {
    expect(quoteOf("Sam", "a".repeat(41))).toBe(`Sam: ${"a".repeat(40)}…`);
  });
});

describe("anchorOf", () => {
  it("delegates a reply thread from its root and a range from the message itself", () => {
    const reply = { id: "m2", rootId: "m1" } as InboxMessage;
    expect(anchorOf(reply, "chain")).toBe("m1");
    expect(anchorOf(reply, "range")).toBe("m2");
    expect(anchorOf({ id: "m1", rootId: null } as InboxMessage, "chain")).toBe("m1");
  });
});

describe("mergeConversationPages", () => {
  const message = (id: string) => ({ id }) as InboxMessage;
  const newest = { messages: [message("m3"), message("m4")], nextCursor: "c3" };

  it("puts older pages above the newest one, once each", () => {
    const older = {
      messages: [message("m1"), message("m2"), message("m3")],
      nextCursor: "c1",
      joinId: "m3",
    };
    expect(mergeConversationPages(newest, older)).toMatchObject({
      messages: ["m1", "m2", "m3", "m4"].map(message),
      nextCursor: "c1",
    });
  });

  it("drops older pages once the newest page no longer reaches them", () => {
    const older = { messages: [message("m1")], nextCursor: null, joinId: "m2" };
    expect(mergeConversationPages(newest, older)).toEqual({ ...newest, older: null });
  });
});

describe("mentions", () => {
  const from = (id: string, name: string, isSelf = false) =>
    ({ author: { id, name, isSelf } }) as InboxMessage;
  const people = mentionablePeople([
    from("u1", "Zhang San"),
    from("u2", "Zhang Sanfeng"),
    from("u3", "Li"),
    from("u4", "Li"),
    from("me", "Me", true),
    from("u1", "Zhang San"),
  ]);

  it("offers everyone else who wrote, except a name two people share", () => {
    expect(people.map((person) => person.userId)).toEqual(["u1", "u2"]);
  });

  it("reads each @ as the longest name after it, once per person", () => {
    const found = mentionsIn("@Zhang Sanfeng, cc@Zhang San @Zhang San @Li @Me @nobody", people);
    expect(found.map((person) => person.userId)).toEqual(["u2", "u1"]);
  });

  it("takes back only the @name a quote reply put in front", () => {
    expect(withoutMention("@Zhang San ", "Zhang San")).toBe("");
    expect(withoutMention("@Zhang San hi", "Zhang San")).toBe("hi");
    expect(withoutMention("@Zhang Sanfeng hi", "Zhang San")).toBe("@Zhang Sanfeng hi");
    expect(withoutMention("hi @Zhang San", "Zhang San")).toBe("hi @Zhang San");
  });

  it("suggests names for the @ at the caret until one is complete", () => {
    const names = (text: string) =>
      mentionSuggestions(text, text.length, people)?.people.map((person) => person.name);
    expect(names("ping @zh")).toEqual(["Zhang San", "Zhang Sanfeng"]);
    expect(names("ping @Zhang San")).toEqual(["Zhang Sanfeng"]);
    expect(names("ping @Zhang Sanfeng")).toBeUndefined();
    expect(names("a@b\nzh")).toBeUndefined();
    expect(mentionSuggestions("ping @zh", 8, people)?.start).toBe(5);
  });
});

describe("replyModes", () => {
  const timeline = { id: "m1", inThread: false } as InboxMessage;
  const inThread = { id: "m2", inThread: true, rootId: "m1" } as InboxMessage;

  it("offers a quote, a thread, or both, as the chat app does", () => {
    expect(replyModes("group", timeline, false)).toBeNull();
    expect(replyModes("dm", timeline, true)).toEqual(["quote"]);
    expect(replyModes("topic_group", timeline, true)).toEqual(["thread"]);
    expect(replyModes("group", inThread, true)).toEqual(["thread"]);
    expect(replyModes("group", timeline, true)).toEqual(["quote", "thread"]);
  });

  it("answers a draft in the thread its message already has, and quotes it otherwise", () => {
    const both = ["quote", "thread"] as const;
    expect(draftReplyMode(both, timeline, [timeline])).toBe("quote");
    expect(draftReplyMode(both, timeline, [timeline, inThread])).toBe("thread");
    expect(draftReplyMode(["thread"], timeline, [timeline])).toBe("thread");
  });
});

describe("shortLink", () => {
  it.each([
    ["https://cloud.example.net/argos/alarm/detail/0/351?zone=CN", "cloud.example.net/argos/…"],
    ["https://go.example.com/approval?id=1", "go.example.com/approval/…"],
    ["https://www.example.com/docs", "example.com/docs"],
    ["https://example.com/", "example.com"],
    ["not a url", "not a url"],
  ])("%s", (link, expected) => {
    expect(shortLink(link)).toBe(expected);
  });
});

describe("matchesFilter", () => {
  it.each([
    ["dm", "dm", true],
    ["groups", "group", true],
    ["groups", "topic_group", false],
    ["topics", "topic_group", true],
    ["all", undefined, true],
    ["dm", undefined, false],
  ] as const)("%s takes a %s conversation: %s", (filter, kind, expected) => {
    expect(matchesFilter(filter, kind)).toBe(expected);
  });
});

describe("delegationPreview", () => {
  it.each([
    ["Jordan Lee", "Jordan Lee: Hey there", null, "Hey there"],
    ["Jordan Lee", null, "Jordan Lee: Hey, the nightly export job", "Hey, the nightly export job"],
    ["Platform team", "Priya Shah: hi", null, "Priya Shah: hi"],
    ["Platform team", null, null, "Delegated messages"],
    ["Platform team", "  ", "  ", "Delegated messages"],
  ])("formats preview for %s", (conversationName, preview, threadTitle, expected) => {
    expect(delegationPreview(conversationName, preview, threadTitle)).toBe(expected);
  });
});

describe("mentionParts", () => {
  const marked = (text: string, mentions?: ReadonlyArray<{ name: string; isSelf: boolean }>) =>
    mentionParts(text, mentions)
      .map((part) =>
        part.mention === null ? part.text : part.mention.self ? `{${part.text}}` : `[${part.text}]`,
      )
      .join("");
  it.each([
    ["@肖凡 解答下呢", "[@肖凡] 解答下呢"],
    ["应该没理解错吧@周帅 前端大佬", "应该没理解错吧[@周帅] 前端大佬"],
    ["@Sam, @Priya: look", "[@Sam], [@Priya]: look"],
    ["mail sam@example.com", "mail sam@example.com"],
    ["just @", "just @"],
  ])("guesses %s", (text, expected) => {
    expect(marked(text)).toBe(expected);
  });

  it("marks the adapter's names exactly, longest first, and only those", () => {
    const mentions = [
      { name: "Zhang San", isSelf: false },
      { name: "Zhang Sanfeng", isSelf: true },
    ];
    expect(marked("@Zhang Sanfeng and @Zhang San, not @Li", mentions)).toBe(
      "{@Zhang Sanfeng} and [@Zhang San], not @Li",
    );
    expect(marked("@Li here", [])).toBe("@Li here");
  });
});
