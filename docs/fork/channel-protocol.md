# Channel protocol v1

How T3 Code's inbox talks to a chat adapter. The one definition is
[`apps/server/src/fork/channels/protocol.ts`](../../apps/server/src/fork/channels/protocol.ts); this
page explains it, and [`fixtures/`](../../apps/server/src/fork/channels/fixtures) holds a valid
answer for every endpoint. `hub.test.ts` decodes each fixture with the schemas, so they stay in
step with the code. Adapters should check their real answers against the same fixtures.

## Transport

- HTTP on loopback only (`127.0.0.1`, `::1`, or `localhost`, which T3 sends to `127.0.0.1`).
- Every request carries `Authorization: Bearer <token>`, the token the adapter wrote to the file
  the channel names. `401` or `403` marks the channel "Token refused".
- JSON bodies. Keys T3 does not know are ignored. Requests time out after 10 seconds; answers over
  25 MB are refused.
- Times are ISO 8601 with a zone (`2026-11-14T09:30:00.000Z` or `…+08:00`).

## Endpoints

| Endpoint                                                     | Answer                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| `GET /health`                                                | `ChannelHealth` (`health.json`)               |
| `GET /config`                                                | `AdapterConfig` (`config.json`)               |
| `GET /conversations?relevant=1&limit=100`                    | page of `Conversation` (`conversations.json`) |
| `GET /conversations/{id}/topics?limit=200`                   | page of `Topic` (`topics.json`)               |
| `GET /conversations/{id}/messages?topic={topicId}&limit=200` | page of `Message` (`messages.json`)           |
| `GET /media/{messageId}/{key}`                               | the file's bytes, with its `content-type`     |
| `POST /messages`                                             | `{ "messageId" }` (`send-ok.json`)            |
| `GET /events`                                                | `text/event-stream` (`events.sse`)            |

`/health` decides the channel's state, in this order: `protocol` must be `1`; `loggedIn: false`
is "Sign-in needed" (reading works, sending does not); `online: false` is "Collector stopped"
(both work, new messages stop arriving). `self.name` is shown as the signed-in account.

`/config` names the templates a topic can be delegated with. A template is only a prompt with
`{contextDir}`, `{note}`, and `{openUrl}`; the thread runs in the project's default mode.

## Lists

- A page is `{ "items": [...], "nextCursor": string | null }`. T3 asks again with
  `cursor=<nextCursor>` until it is `null`, at most 20 pages of conversations, 20 of topics per
  conversation, and 50 of messages per topic. A cursor seen twice ends the list.
- **Conversations newest first by `lastActivityAt`, topics newest first by `lastMessageAt`.** When
  T3 stops at the page cap, it keeps the newest. Messages may come in any order; T3 sorts them.
- A page whose `items` or `nextCursor` is malformed fails as a whole. An item that does not decode
  (a missing field, a time without a zone) is skipped, counted, and reported in the inbox as
  "N items from the adapter could not be read."
- Direct messages have no topics of their own: the adapter splits them into topics, by time
  window or however it likes. T3 does not.

### Topic summary fields

T3 decides a topic's state from the topic alone, so the adapter computes two fields from all of
the topic's messages:

- `lastOtherMessageAt`: `createdAt` of the newest message whose author is not me; `null` if I wrote
  every message.
- `mentionsSelfSinceOwn`: whether any message after my newest one has `mentionsSelf: true`; if I
  never wrote in the topic, whether any message does.

## Sending

`POST /messages` with `{ "conversationId", "topicId"?, "text" }`. Answer `{ "messageId" }` only
once the chat app accepted the message. An answer without a `messageId` is shown as "delivery
unknown", and T3 does not resend. A refusal is
`{ "error": { "code", "message" } }` (`send-error.json`) with a 4xx or 5xx status, and `code` one
of `not_logged_in`, `rate_limited`, `rejected`, `unknown`.

## Events

`GET /events` streams server-sent events. They only say that something changed; T3 then reads the
lists again.

- `message.created`: a message arrived. Its data may name `conversationId`, `topicId`, and
  `messageId`, but nothing requires them, and data T3 cannot parse still counts. With a
  `conversationId`, T3 reads again only the conversation list and that conversation; without
  one, everything.
- `health.changed`: T3 checks `/health` again.

Other event names are ignored. T3 reads everything again each time the stream (re)connects, so
an adapter keeps no event ids and does not replay missed events.
