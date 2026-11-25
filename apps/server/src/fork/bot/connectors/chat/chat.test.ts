// @effect-diagnostics globalDate:off - Fixed instants stand in for the mention clock.
import { describe, expect, it } from "@effect/vitest";

import type { Message } from "../../../channels/protocol.ts";
import {
  MENTION_DELAY_MS,
  mentionsIn,
  newMentions,
  trackMentions,
  userWroteAfter,
} from "./chat.ts";

const NOW = new Date("2026-11-25T10:00:00.000Z");
const SINCE = "2026-11-25T08:00:00.000Z";
const DUE = new Date(NOW.getTime() + MENTION_DELAY_MS).toISOString();

const conversation = (lastMentionAt: string | null, lastSelfMessageAt: string | null = null) => ({
  id: "oc_1",
  lastMentionAt,
  lastSelfMessageAt,
});

describe("mentions of the user", () => {
  it.each([
    { name: "none yet", conversations: [conversation(null)], marks: [], steps: [] },
    {
      name: "before the bot took mentions on",
      conversations: [conversation("2026-11-25T07:59:00+00:00")],
      marks: [],
      steps: [],
    },
    {
      name: "a new one waits its delay",
      conversations: [conversation("2026-11-25T17:59:00+08:00")],
      marks: [],
      steps: [
        {
          type: "pending",
          conversationId: "oc_1",
          pendingAt: "2026-11-25T17:59:00+08:00",
          dueAt: DUE,
          handledThrough: SINCE,
        },
      ],
    },
    {
      name: "one the user already answered",
      conversations: [conversation("2026-11-25T09:58:00Z", "2026-11-25T09:59:00Z")],
      marks: [],
      steps: [{ type: "handled", conversationId: "oc_1", through: "2026-11-25T09:58:00Z" }],
    },
    {
      name: "one already handled",
      conversations: [conversation("2026-11-25T09:58:00Z")],
      marks: [
        {
          channelId: "lark",
          conversationId: "oc_1",
          handledThrough: "2026-11-25T09:58:00Z",
          pendingAt: null,
          dueAt: null,
        },
      ],
      steps: [],
    },
    {
      name: "one already waiting",
      conversations: [conversation("2026-11-25T09:58:00Z")],
      marks: [
        {
          channelId: "lark",
          conversationId: "oc_1",
          handledThrough: SINCE,
          pendingAt: "2026-11-25T09:58:00Z",
          dueAt: DUE,
        },
      ],
      steps: [],
    },
  ])("tracks $name", ({ conversations, marks, steps }) => {
    expect(trackMentions({ conversations, marks, since: SINCE, now: NOW })).toEqual(steps);
  });

  it("reports the messages that mention the user since the mark, not the user's own", () => {
    const message = (id: string, createdAt: string, mentionsSelf: boolean, isSelf = false) =>
      ({
        id,
        createdAt,
        mentionsSelf,
        author: { id: isSelf ? "me" : "u1", name: "Zhang San", isSelf },
        text: id,
        attachments: [],
        links: [],
      }) as unknown as Message;
    const messages = [
      message("old", "2026-11-25T09:00:00Z", true),
      message("plain", "2026-11-25T09:58:00Z", false),
      message("mine", "2026-11-25T09:58:30Z", true, true),
      message("new", "2026-11-25T17:59:00+08:00", true),
    ];
    expect(newMentions(messages, "2026-11-25T09:30:00Z").map((m) => m.id)).toEqual(["new"]);
  });

  it("calls a draft stale only for the user's own later messages, not a bot's", () => {
    const own = (id: string, createdAt: string) =>
      ({ id, createdAt, author: { id: "me", name: "Me", isSelf: true } }) as unknown as Message;
    const asked = "2026-11-25T10:00:00.000Z";
    const messages = [
      own("before", "2026-11-25T09:59:00Z"),
      own("bot", "2026-11-25T18:01:00+08:00"),
    ];
    expect(userWroteAfter(messages, asked, new Set(["bot"]))).toBe(false);
    expect(userWroteAfter(messages, asked, new Set())).toBe(true);
  });

  it("mentions people seen in the conversation, the longest name first", () => {
    const from = (id: string, name: string, mentions: Message["mentions"] = []) =>
      ({ id, author: { id: `u-${name}`, name, isSelf: false }, mentions }) as unknown as Message;
    const messages = [
      from("1", "Zhang San"),
      from("2", "Zhang Sanfeng", [
        { userId: "u-li", name: "Li Si", isSelf: false },
        { userId: "u-me", name: "Me", isSelf: true },
      ]),
    ];
    expect(mentionsIn("@Zhang Sanfeng and @Li Si, not @Me or @Nobody", messages)).toEqual([
      { userId: "u-Zhang Sanfeng", name: "Zhang Sanfeng" },
      { userId: "u-li", name: "Li Si" },
    ]);
    expect(mentionsIn("@Zhang San, ping", messages)).toEqual([
      { userId: "u-Zhang San", name: "Zhang San" },
    ]);
  });
});
