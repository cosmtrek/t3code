# Channel protocol v2

How T3 Code's inbox talks to a chat adapter. The one definition is
[`apps/server/src/fork/channels/protocol.ts`](../../apps/server/src/fork/channels/protocol.ts); this
page explains it, and [`fixtures/`](../../apps/server/src/fork/channels/fixtures) holds a valid
answer for every endpoint. `hub.test.ts` decodes each fixture with the schemas, so they stay in
step with the code. Adapters should check their real answers against the same fixtures.

The inbox mirrors the chat app: one row per conversation, its messages and their reply links, and
whether they were read. It invents nothing the chat app does not have. What the user hands to an
agent (a delegation) is T3 Code's own and never reaches the adapter. v2 replaced v1's topics,
which split conversations into units the chat app does not show; T3 Code speaks only v2.

## Transport

- HTTP on loopback only (`127.0.0.1`, `::1`, or `localhost`, which T3 sends to `127.0.0.1`).
- Every request carries `Authorization: Bearer <token>`, the token the adapter wrote to the file
  the channel names. `401` or `403` marks the channel "Token refused".
- JSON bodies. Keys T3 does not know are ignored. Requests time out after 10 seconds; answers over
  25 MB are refused.
- Times are ISO 8601 with a zone (`2026-11-14T09:30:00.000Z` or `…+08:00`).

## Endpoints

| Endpoint                                                      | Answer                                        |
| ------------------------------------------------------------- | --------------------------------------------- |
| `GET /health`                                                 | `ChannelHealth` (`health.json`)               |
| `GET /config`                                                 | `AdapterConfig` (`config.json`)               |
| `GET /conversations?relevant=1&limit=100`                     | page of `Conversation` (`conversations.json`) |
| `GET /conversations/{id}/messages?order=desc&limit=100`       | page of `Message` (`messages.json`)           |
| `GET /conversations/{id}/messages?root={messageId}&limit=200` | page of `Message`: one reply thread           |
| `GET /media/{messageId}/{key}`                                | the file's bytes, with its `content-type`     |
| `POST /messages`                                              | `{ "messageId" }` (`send-ok.json`)            |
| `GET /events`                                                 | `text/event-stream` (`events.sse`)            |

`/health` decides the channel's state, in this order: `protocol` must be `2`; `loggedIn: false`
is "Sign-in needed" (reading works, sending does not); `online: false` is "Collector stopped"
(both work, new messages stop arriving). `self.name` is shown as the signed-in account.

`/config` names the templates messages can be delegated with. A template is only a prompt with
`{contextDir}`, `{note}`, and `{openUrl}`; the thread runs in the project's default mode.

## Lists

- A page is `{ "items": [...], "nextCursor": string | null }`. T3 asks again with
  `cursor=<nextCursor>` until it is `null`, at most 20 pages of conversations and 50 of a reply
  thread. A cursor seen twice ends the list.
- **Conversations newest first by `lastActivityAt`.** When T3 stops at the page cap, it keeps the
  newest. Messages may come in any order; T3 sorts them.
- A page whose `items` or `nextCursor` is malformed fails as a whole. An item that does not decode
  (a missing field, a time without a zone) is skipped, counted, and reported in the inbox as
  "N items from the adapter could not be read."
- An attachment `kind` other than `image` (`audio`, `video`, `sticker`, …) is read as `file`,
  so a new kind in the chat app does not drop the message.
- `order=desc` holds every message of the conversation, replies kept inside a thread included; the
  first page is the newest and `nextCursor` pages back in time. The chat view reads it one page at
  a time, and a range delegation reads back until it reaches its first message.
- `root={messageId}` holds that message and every message whose `rootId` is it. The root may be
  missing when the adapter no longer stores it; answer with the replies alone. T3 delegates a
  reply thread from its root, so a `root` that is itself a reply may answer with just itself.

### Conversation fields

T3 decides a conversation's state from the conversation alone:

- `lastMessage`: the newest message, as `{ id, createdAt, author, preview }`, or `null`. `preview`
  is one line of plain text, with a placeholder for a message without text.
- `lastOtherMessageAt`: `createdAt` of the newest message on the conversation's timeline whose
  author is not me. A reply the chat app keeps inside a thread, and does not show on the
  timeline, does not count: its read state is not the conversation's.
- `lastSelfMessageAt`: `createdAt` of my newest message, thread replies included. A mention before
  it counts as answered.
- `lastMentionAt`: `createdAt` of the newest message that mentions me, thread replies included.
  A mention of everyone does not count.
- `selfReadThroughAt` (optional): `createdAt` of the newest message not from me that the chat app
  shows I have read. It is a message time, not the time I read it, so reading the latest message
  makes it equal `lastOtherMessageAt`. Give `null`, or leave it out, whenever the adapter is not
  sure: a wrong value hides a message the user never saw.

A conversation is unread when its last message is not mine and `lastOtherMessageAt` is after
`selfReadThroughAt` and T3's own read marks. Reading only goes one way: reading in the chat app
clears the conversation in T3, and reading in T3 leaves the chat app as it was.

### Message fields

- `rootId`: the root of the reply thread or topic the message belongs to; `null` for a root or a
  message nobody replied to. The same rule in every kind of conversation.
- `replyTo`: the message this one answers, as `{ id, authorName, preview }`, or `null`. Give
  `authorName` and `preview` as `null` when the adapter no longer has that message.

## Sending

`POST /messages` with `{ "conversationId", "replyToId"?, "text" }`. Answer `{ "messageId" }` only
once the chat app accepted the message. An answer without a `messageId` is shown as "delivery
unknown", and T3 does not resend. A refusal is
`{ "error": { "code", "message" } }` (`send-error.json`) with a 4xx or 5xx status, and `code` one
of `not_logged_in`, `rate_limited`, `rejected`, `unknown`.

With a `replyToId`, the message goes into that message's reply thread or topic. It need not quote
that very message: a chat app that only replies to a thread's root sends it to the root.

## Events

`GET /events` streams server-sent events. They only say that something changed; T3 then reads the
lists again.

- `message.created`: a message arrived. Its data may name `conversationId` and `messageId`, but
  nothing requires them, and data T3 cannot parse still counts. With a `conversationId`, T3 reads
  again only the conversation list and that conversation; without one, everything.
- `conversation.updated`: a conversation changed without a new message, such as its
  `selfReadThroughAt`. Its data is read as `message.created`'s. Send it only when a value changed,
  and only once the conversation list answers with the new value. A change to more than a few
  conversations at once can be one event without a `conversationId`.
- `health.changed`: T3 checks `/health` again.

Other event names are ignored. T3 reads everything again each time the stream (re)connects, so
an adapter keeps no event ids and does not replay missed events.
