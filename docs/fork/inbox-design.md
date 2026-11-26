# Inbox design

The inbox is a chat client inside T3 Code. Users already know how to read a chat from the chat
apps they use every day (Feishu/Lark, Slack), and they already know how T3 Code looks. The inbox
should feel familiar on both counts:

- **Behavior comes from the chat apps.** How messages group, how reply threads open, how unread and
  mentions surface: copy the convention people already know, Feishu first. Don't invent a new way
  to read a chat.
- **The look comes from T3 Code.** Build every control from T3 Code's primitives, and take every
  color from its theme tokens. The inbox should read as another T3 Code page, not as an embedded
  Feishu.

This follows the [two layers](./inbox-architecture.md#two-layers): conversations and messages are
the chat app's, so their interaction follows the chat app. Delegations are T3 Code's, so agent
state (thread status, drafts, the agent conversation) reuses T3 Code's own components
and wording.

## Design the whole, not the patch

A design change starts from the product, not from the element that looks wrong. Before touching a
control, list what the user is trying to do on that screen, every signal and entry point that
serves it, and where each one already lives. Then change the arrangement so each one has one
place. Hiding, recoloring, or adding a state to the one element that drew the complaint usually
moves the problem instead of solving it.

## The conversation is the unit of attention

The user attends to conversations: "what in this group needs me". Agents and bots help with a
conversation; they are not a second place to go. So the inbox has one list, ordered by one rule,
and every way into a conversation lands in the same place.

An earlier design gave delegations their own Agent view. The same group then had two entries, each
opening at a different position, and the user bounced between them. Do not bring back a list of
follow-ups beside the conversation list.

### Follow-ups

A follow-up (code: delegation) is a set of messages someone handles for the user. The handler is
an agent (a new thread, which sees the messages and the project) or a bot (which also has its
notebook: items, memory, earlier threads). The handler can change: an agent's follow-up can be
handed to a bot, with its thread.

```text
following up ──► needs you (result, draft, question) ──► settled
      ▲                                                     │
      └──────────────────── un-settle ◄─────────────────────┘
```

- Done is T3 Code's **Settle**, the same word and icons as a thread's. Only the user settles a
  follow-up; sending a reply does not, since "looking into it" ends nothing. The draft offers
  **Send and settle** beside Send. A bot may propose settling; the panel shows the proposal and
  the user confirms it.
- Settling also settles the follow-up's thread. Un-settling, or following up the same message
  again, reopens the follow-up and leaves the thread alone.
- A settled follow-up leaves every signal and the listing's thread reads, and stays as history in
  its conversation.
- A bot that takes an @-mention on its own opens a follow-up on that message, so its work is
  visible and closable like any other.

### One list, one order

Each conversation row has one state, and the list sorts by state, then by time:

| State     | When                                                                       | Counted |
| --------- | -------------------------------------------------------------------------- | ------- |
| Needs you | unread DM, a mention of you, or an open follow-up with a result or a draft | yes     |
| Following | an open follow-up, nothing waiting on you                                  | no      |
| Other     | group messages                                                             | no      |

Unread and Following sort by state and head each group once there is more than one; All keeps the
chat app's order. A row shows its top follow-up's status beside the unread mark, in the words and
colors the sidebar uses for a thread (Draft, Input, Working). Following filters conversations with
an open follow-up; it is not another list of objects.

### Where things open

- Opening a conversation from anywhere lands at the reading position: the first unread message,
  else the bottom. It never jumps to an old follow-up's first message.
- A follow-up shows twice in the chat, each with its own job: a marker in its first message's
  footer, beside the reply count and built the same way (a `ghost-muted` button carrying the
  status), and a side panel that holds its draft, questions, and agent chat. The panel is not
  permanent: it opens with the conversation when a follow-up needs you and there is room for
  both, from the marker, or from the header, and the user can close it. Without room for both,
  the chat opens first and the panel takes its place when asked for.
- Only an explicit "Show the message" in the panel scrolls the chat back to the follow-up's
  messages. Each conversation keeps one reading position.

Replies to the chat app leave from one place: the reply box. A draft from an agent or a bot lands
in its follow-up's reply box, and the user sends it there.

The same goes for menus: each one offers what fits the moment, not the same set everywhere. A list
row's menu triages (mark read or unread, copy the chat ID); the open conversation's header menu acts
on what is open (copy the chat ID, discard drafts). Marking unread a conversation you are reading
belongs to the list, not the header.

Every reply the user edits, typed or drafted by the agent, goes through one reply box
(`ReplyBox`), shaped like T3 Code's composer. Enter sends, as in the chat app, unless the user's
**Send shortcut** setting asks for Cmd/Ctrl+Enter: one setting decides the send key everywhere.

## Before building a control

1. Find how T3 Code already does this kind of control: a `components/ui` primitive and its variant,
   or an existing pattern elsewhere in `apps/web`. Follow [Web UI](../internals/web-ui.md).
2. Find how Feishu does it: what it shows, where it is, and what clicking it does.
3. Build (2)'s behavior with (1)'s parts. When they disagree on how something looks, T3 Code wins.
   When they disagree on how something behaves, the chat app wins unless it breaks a T3 Code rule
   (performance, no continuous animation, every surface).

## Color roles

Use theme tokens only, never fixed colors or arbitrary values. Each token has one job, so a color
always means the same thing across the app:

| Token                                       | Means                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `primary`                                   | Selected, focused, or about you: the open message, mentions of you, the new-messages line, Send                        |
| `muted-foreground` (`ghost-muted` buttons)  | Secondary actions and metadata: expand and collapse, load earlier, times, counts                                       |
| `info`, `success`, `warning`, `destructive` | Status: a draft waiting to send (`success`), needs attention (`warning`), failed (`destructive`). Use `Badge` variants |
| `border`                                    | Structure: cards, thread lines, separators                                                                             |

Chat apps color many things in their brand blue. Translate by role, not by hue: Feishu's blue
"5 replies" link is a secondary action, so in the inbox it is muted, and it gains emphasis only
when the thread mentions you. Emphasis that is everywhere is emphasis nowhere.

## Icons

Icons follow T3 Code too, so a glyph means the same thing on every page:

- Use `lucide-react`, as the rest of the app does. Product and machine marks come from T3 Code's
  own components (`components/Icons.tsx`, `ProviderInstanceIcon`, `EnvironmentMachineIcon`), not
  from new SVGs.
- One concept, one icon. Before picking one, search `apps/web/src/components` for how T3 Code
  already draws that concept (copy, open externally, expand, more, status, agent) and use the same
  icon. Don't pick a lookalike, and don't copy a chat app's own glyph for something T3 Code
  already draws.
- Agent-side things use the icons T3 Code uses for threads and providers, so a delegation looks
  like the thread it is.
- Let the primitive size the icon. `Button` and `Badge` size and color their icons per `size` and
  `variant`, so an icon inside them takes no `size-*` class, and a color class only when the color
  is a state (a new result). In plain text rows, size it yourself: `size-3.5` next to `text-xs`.

## Example: reply threads

Feishu shows a reply count under a message and opens the replies inline. The inbox keeps that
behavior and builds it from T3 Code parts:

- The toggle is a `Button` with `variant="ghost-muted"` and `size="xs"`: `MessageSquareIcon`,
  "5 replies" or "Hide replies", and a chevron that flips. Both states stay muted, in group chats
  and topic groups alike.
- A thread that mentions you adds `<Badge size="sm">@you</Badge>`, so the one thing worth noticing
  stands out. Every "about you" mark (`[@you]` in the list, `@you` on a message, a mention of you
  in the text) is `primary`.
- Open replies hang off a `border` line, not a `primary` one, which would read as a selection.
