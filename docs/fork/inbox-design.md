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
state (thread status, drafts, conclusions, the agent conversation) reuses T3 Code's own components
and wording.

## Design the whole, not the patch

A design change starts from the product, not from the element that looks wrong. Before touching a
control, list what the user is trying to do on that screen, every signal and entry point that
serves it, and where each one already lives. Then change the arrangement so each one has one
place. Hiding, recoloring, or adding a state to the one element that drew the complaint usually
moves the problem instead of solving it.

The inbox has two jobs, and each has its own place:

- **People waiting on you.** Unread and All list conversations. A row carries only chat signals:
  one unread mark on the right, a count when the chat app gives one and a dot otherwise.
- **The agent waiting on you.** The Agent view lists delegations with their thread status. Its tab
  counts delegations with an unseen result or a draft to send. Running work is status, not a
  to-do, so it is not counted.

A conversation's delegations open from its header, where the user is already working on that
conversation. They do not repeat on its list row.

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
