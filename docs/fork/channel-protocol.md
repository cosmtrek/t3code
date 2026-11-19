# Channel protocol v2

How T3 Code's inbox talks to a chat adapter. The one definition is
[`apps/server/src/fork/channels/protocol.ts`](../../apps/server/src/fork/channels/protocol.ts); this
page explains it, and [`fixtures/`](../../apps/server/src/fork/channels/fixtures) holds a valid
answer for every endpoint. `hub.test.ts` decodes each fixture with the schemas, so they stay in
step with the code. Adapters should check their real answers against the same fixtures.

The inbox mirrors the chat app: one row per conversation, its messages and their reply links, and
whether they were read. It invents nothing the chat app does not have. What the user hands to an
agent (a delegation) is T3 Code's own; the adapter only hears of it as the
[acknowledgement](#acknowledgement) on the delegated message. v2 replaced v1's topics,
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
| `POST /uploads?name={fileName}`                               | `Upload` (`upload-ok.json`)                   |
| `POST /reactions`                                             | any 2xx                                       |
| `GET /events`                                                 | `text/event-stream` (`events.sse`)            |

`/health` decides the channel's state, in this order: `protocol` must be `2`; `loggedIn: false`
is "Sign-in needed" (reading works, sending does not); `online: false` is "Collector stopped"
(both work, new messages stop arriving). `self.name` is shown as the signed-in account.

`/config` names the templates messages can be delegated with. A template is only a prompt with
`{contextDir}`, `{note}`, and `{openUrl}`; the thread runs in the project's default mode. A
template asks for the work, not for a reply: the user reads the findings in the thread itself, and
T3 adds the rule for `draft.md`, which the thread writes only when the user asks for a reply.

`/config` may also list `capabilities`: the optional parts of this page the adapter implements,
`"mentions"`, `"markdown"`, `"attachments"`, and `"quotes"` (see [Sending](#sending)). T3 offers a feature
only when its capability is listed, and sends none of its keys otherwise. Names T3 does not know
are ignored, and an adapter without the key implements none. Message fields such as `inThread`
need no capability.

`/config` may also name `ackReaction`, the reaction key T3 adds when the user delegates a message
(see [Acknowledgement](#acknowledgement)). Without it T3 adds none.

## Lists

- A page is `{ "items": [...], "nextCursor": string | null }`. T3 asks again with
  `cursor=<nextCursor>` until it is `null`, at most 20 pages of conversations and 50 of a reply
  thread. A cursor seen twice ends the list.
- **Conversations newest first by `lastActivityAt`.** When T3 stops at the page cap, it keeps the
  newest. Messages may come in any order; T3 sorts them.
- A page whose `items` or `nextCursor` is malformed fails as a whole. An item that does not decode
  (a missing field, a time without a zone) is skipped, counted, and reported in the inbox as
  "N items from the adapter could not be read."
- A rich-text message's inline images are attachments too, in the order they appear. Its `text`
  may keep a placeholder where each one stood, but an image only in the text never shows in T3.
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

- `unreadCount` (optional): the chat app's unread badge for the conversation, or `null` when the
  adapter is not sure. T3 shows it as the number on an unread conversation and sums it into the
  Unread tab; whether the conversation is unread still comes from the fields above. Once T3 has
  read past `selfReadThroughAt` (and my last message), the badge includes messages read in T3, so
  T3 treats the count as unknown and shows 1.

A conversation is unread when its last message is not mine and `lastOtherMessageAt` is after
`selfReadThroughAt` and T3's own read marks. Reading only goes one way: reading in the chat app
clears the conversation in T3, and reading in T3 leaves the chat app as it was.

### Message fields

- `rootId`: the root of the reply thread or topic the message belongs to; `null` for a root or a
  message nobody replied to. The same rule in every kind of conversation.
- `inThread` (optional, default `false`): the message is kept inside its reply thread or topic and
  the chat app does not show it on the conversation's timeline. Its `rootId` is then the thread's
  root. A root is never `inThread`; a quoted reply the timeline shows is not either, though it has
  a `rootId` and a `replyTo`. This is the same line `lastOtherMessageAt` draws. T3 shows these
  replies folded under their root, and a range delegation takes them only with their thread.
- `replyTo`: the message this one answers, as `{ id, authorName, preview }`, or `null`. Give
  `authorName` and `preview` as `null` when the adapter no longer has that message. When that
  message has no text, `preview` is a placeholder such as `[Image]` or `[File] report.pdf`, never
  an empty string.

The rest are optional, and T3 falls back to what it showed before when one is missing:

- `mentions`: who `text` names, as `[{ userId, name, isSelf }]`, one entry per person in order of
  first appearance. `name` is exactly the text after `@` in `text`; T3 marks every `@name` that
  matches an entry. A mention of everyone has `userId` `"all"`. Without it T3 guesses mentions
  from `@` followed by a run of non-space characters.
- `reactions`: `[{ key, emoji, count, users, includesSelf }]`. `key` is the chat app's own name for
  the reaction, `emoji` its Unicode form or `null` when there is none (T3 then shows `key`),
  `users` display names earliest first, possibly fewer than `count`. A change sends
  `conversation.updated`.
- `editedAt`: when the message was last edited; `null` or absent when it never was. `text` is the
  edited text.
- `replyCount`: for the root of a reply thread or topic, how many replies the chat app counts. A
  page may hold only some of them.
- `format`: `"markdown"` when `text` is Markdown converted from the chat app's rich text (bold,
  lists, code blocks, links as `[text](url)`); `"text"` or absent for plain text. Mentions stay
  `@name` in either.

## Sending

`POST /messages` with `{ "conversationId", "replyToId"?, "text" }`, plus the optional `mentions`,
`format`, and `attachments` below. Answer `{ "messageId" }` only
once the chat app accepted the message. An answer without a `messageId` is shown as "delivery
unknown", and T3 does not resend. A refusal is
`{ "error": { "code", "message" } }` (`send-error.json`) with a 4xx or 5xx status, and `code` one
of `not_logged_in`, `rate_limited`, `rejected`, `unknown`.

With a `replyToId`, the message goes into that message's reply thread or topic. It need not quote
that very message: a chat app that only replies to a thread's root sends it to the root.

An adapter that lists `"quotes"` also takes `inThread` with every `replyToId`. `true` is the reply
above. `false` puts the message on the conversation's timeline, quoting that very message, as a
chat app's plain reply does. T3 sends `false` only where the chat app has such a reply: in a DM,
and in a group for a message on the timeline, never in a topic group or inside a thread.

### Mentions

Without this, an `@Name` in `text` reaches the chat app as plain characters and nobody is
notified. An adapter that lists `"mentions"` in its capabilities also takes a `mentions` array:

```json
{
  "conversationId": "oc_1",
  "replyToId": "om_42",
  "text": "@Zhang San the fix is deployed, please retry. cc @Li Si",
  "mentions": [
    { "userId": "ou_aaa", "name": "Zhang San" },
    { "userId": "ou_bbb", "name": "Li Si" }
  ]
}
```

- `userId` is an `author.id` the adapter gave in a `Message` of this conversation, returned
  unchanged. The adapter accepts every id it reports as `author.id`, and maps it when the chat app
  mentions people by another kind of id.
- `text` stays readable on its own: it holds the literal `@` + `name` wherever a mention belongs.
- T3 sends at most 20 entries, each with a distinct `userId` and a distinct `name` whose `@name`
  occurs in `text`, and never the signed-in account. It sends none to an adapter without the
  capability.

The adapter replaces **every** occurrence of each `@name` with the chat app's real mention of
that `userId`, taking the longest names first so `@Zhang Sanfeng` is not consumed by an entry
named `Zhang San`. Matching is exact; it does not look for word boundaries, since CJK names have
none. Any other `@…` stays plain text, and the rest of the text is escaped so that nothing the
user wrote is read as the chat app's markup. The message later reads back with `@Name` in its
`text`, as mentions written by other people do.

A mention the chat app would refuse (the person left, the id is stale) does not fail the message:
it goes out as plain `@name`, and the answer names it,
`{ "messageId", "unresolvedMentions": ["ou_bbb"] }`. T3 then tells the user who was not notified.
Leave the key out when every mention resolved. T3 reads it apart from `messageId`, so a malformed
list never turns a sent message into "delivery unknown".

Only people who wrote in the conversation can be mentioned; there is no member list and no
mention of everyone.

### Markdown

An adapter with the `"markdown"` capability takes `"format": "markdown"` (the default is
`"text"`) and sends `text` as the chat app's rich text: bold, italics, lists, quotes, links, and
code blocks, and whatever else it can render. What it cannot render goes out as written. T3
sends an agent's draft as Markdown and what the user typed as text, unless the user switches it.
The message reads back as the adapter renders received rich text: plain `text`, or Markdown with
`"format": "markdown"`. A `@name` inside a code block
is not a mention; an entry that occurs only there is reported in `unresolvedMentions`.

### Attachments

An adapter with the `"attachments"` capability takes files in two steps.

`POST /uploads?name={fileName}` carries the file as the raw request body and answers
`{ "uploadId", "kind", "name", "size" }`. The adapter decides `kind` (`image` or `file`) from the
bytes, not from a `content-type`. T3 allows this request 120 seconds and files up to 100 MB. The
adapter keeps an upload for at least an hour, and may lose it when it restarts.

`POST /messages` then names them: `"attachments": [{ "uploadId" }]`, at most 9, none twice. With
attachments `text` may be empty. A chat app that holds one kind of content per message sends the
text first and then one message per file, all into the same reply thread. The answer is

```json
{ "messageId": "om_1", "messageIds": ["om_1", "om_2"], "failedAttachments": ["up_yyy"] }
```

`messageId` is the first message that went out. `failedAttachments` lists files that failed after
it; the rest are still sent, and T3 tells the user which did not go out. When the first message
fails nothing was sent and the answer is a refusal as above. An `uploadId` the adapter no longer
has is `rejected` with a 400 and nothing is sent: the user attaches the file again.

### Acknowledgement

When the user delegates, T3 tells the sender it was taken: it posts `/config`'s `ackReaction` to
the first message of the delegated range or reply thread that is not the user's own.

`POST /reactions` with `{ "conversationId", "messageId", "key" }`. `key` is the chat app's own
name for the reaction, the same `key` a `Message`'s `reactions` report, such as `"OK"`. Any 2xx
answer is success, and its body is ignored. Add the reaction as the signed-in account; adding it
again must not remove it. A refusal is logged and never fails the delegation, and T3 does not
retry. T3 posts nothing when the message's `reactions` already hold that key with
`includesSelf`, nor when the user starts another thread for the same delegation.

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
