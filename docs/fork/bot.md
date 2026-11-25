# Bots (draft)

Status: steps 1–3 and 5 of the build order are built; chat (step 4) is next.

## Problem

A thread runs one task well, but someone has to drive it: notice that it stopped, decide the next
step, send it, and connect it back to the chat it came from. Today that someone is the user, or a
coordinator thread. A coordinator thread keeps its state in its own conversation, so its plan
drifts and is invisible, every child wakes it, the user cannot get a word in while it waits, and
when it fails or runs out of quota everything stops.

## What a bot is

A bot is a teammate the user talks to. The user creates as many as they like, tells each one in
plain words what it is responsible for, and then asks it how things are going. In between, the bot
works on its own: it checks on things on a schedule, starts threads to do the work, follows them
up, and writes down what it is tracking.

```text
You:  You're "Release Watcher". Each morning, check the fork's open PRs and CI. Fix red CI
      on fork branches yourself. Ask me before touching main.
Bot:  Got it. I'll check at 09:00 every day. I'll fix red CI on r/* branches and ask before
      anything that lands on main. (Saved to my role and routines.)
...next morning...
Bot:  CI on r/inbox-quote failed on a type error; I started a thread to fix it.
You:  What's the status?
Bot:  Fixed and pushed, CI green. Still tracking: Android build for 0.1.11 (waiting on Namespace).
```

Under the hood a bot is **state held by a service, plus short agent turns**:

- **State lives in the bot service**: its notebook (below), its chat with the user, and which
  threads it owns. Nothing important lives only in a model's context.
- **Thinking happens in T3 threads** on the user's own provider subscription. Each wake runs one
  turn in the bot's work thread and the turn ends.
- **Every action goes through the bot service**, which checks it against the bot's permissions,
  ownership, and budget before calling T3 or the chat adapter.

## Belonging

A bot belongs to an environment, not to a project. The environment holds what the bot runs on: its
state, the provider sign-ins, and the chat adapter. Projects are only where it may work and read, zero or more of them.
The bot's own work threads have no project; the threads it starts for work go in the project the
work is in.

Each bot has its own state: role, items, routines, memory, its chat, and its threads.
Nothing is shared between bots.

## Creating a bot

Creating a bot asks only for a name and a model. Everything else comes from talking to it: the bot
turns what the user says into its notebook, and the user can read and edit that notebook directly.

## The notebook

Each bot keeps one notebook, the single source of what it knows and does. The user can open and
edit every part of it on the Bots page.

| Part     | Holds                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------- |
| Role     | Who it is, what it is responsible for, and how to behave, in the user's terms, including its rules  |
| Scope    | Projects it may work in and read                                                                    |
| Routines | Its own scheduled tasks ("09:00 daily: open PRs and CI"), which it creates and edits itself         |
| Items    | Concrete pieces of work, one line each with status, next step, linked threads, and what it waits on |
| Memory   | Lasting notes, one fact per line, at most 4 KB: preferences, project conventions, past mistakes     |
| Notes    | Longer Markdown files in the bot's own folder, read when needed; memory lines can point to them     |
| Skills   | How-tos the bot writes for itself as `SKILL.md` folders, its own or shared with every bot           |

Role, routines, and items are written by the bot from the conversation and corrected by the user
either by telling the bot or by editing the file. An item that waits on someone outside the bot is
a line in it (`waiting: product confirms the copy`), not a separate state.

Each routine has **Run now** on the Bots page, to try a new routine or rerun one without waiting
for its time. It wakes the bot exactly as the timer would.

The notebook stays small, because every turn reads it:

- **Stale items.** The first turn of each day lists the open items nobody has touched for 7 days,
  so the bot can take one step, ask one question, or close them. An item untouched for 14 days is
  set aside: it leaves the notebook's main list and the wake packet, stays readable, and the user
  can reopen it.
- **Memory.** When something changes, the bot rewrites the old note instead of adding a second
  one, and deletes notes that no longer hold. A note that would push memory past 4 KB is refused
  until the bot merges or removes others.

## Talking to a bot

Bots have their own page (sidebar, beside Inbox and Pull requests), not a place in the inbox.
A bot spans projects and works for users with no chat adapter at all; the inbox stays a mirror of
the chat app. Where the user talks to a bot and what the bot can read are separate: any bot can
read any conversation of the chat channel through the service, whatever page the user is on.

- Each bot has one chat with the user. The user asks; the bot answers from its notebook and, when
  needed, by reading its threads or conversations.
- The bot posts there when it finishes something worth knowing or needs a decision. A question
  blocks only that item, not the bot. Unread bot chats are counted on the Bots entry only.
- It stays quiet otherwise. A routine or a thread event that brings nothing new posts nothing:
  no "all good", no repeat of an earlier reminder. Only a message from the user always gets a
  reply.
- The user can write while a turn runs. The message joins that turn instead of waiting for it to
  end.
- The chat is a log, not the bot's memory. A turn sees the recent messages plus the notebook.

Two bridges connect bots and the inbox, so each signal still has one place:

- **Inbox to bot.** Delegating messages offers a bot as a target beside a new thread: the bot gets
  them as a new item, with the messages' link.
- **Bot to inbox.** When a bot cites or answers a chat message, its chat shows a quote that opens
  that conversation in the inbox. What it sends to the chat app shows up in the inbox as the
  user's own message with its signature, if it has one.

## The loop

**Wake.** The service wakes a bot when:

- the user writes in its chat (an edit to its role waits for the next wake);
- one of its routines comes due;
- a thread it owns finishes, fails, or asks for an answer or approval, or a pull request one of
  its threads opened changes;
- someone @-mentions the user in the chat app, only for the bot that handles that channel's mentions (see
  [Chat channels](#chat-channels));
- the user hands a thread back.

Nothing else in a project wakes it: not the user's threads, not another bot's.

One turn runs per bot at a time. A message from the user that arrives while a turn runs is steered
into that turn; every other event that arrives meanwhile is coalesced into the next wake.

**Its own thread events do not all wake it either.** The service queues them; whether one
wakes the bot now is set per item when the bot starts or adopts a thread:

| Follow-up             | Wakes the bot                                                                                    | Fits                         |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------- |
| `now`                 | as soon as the thread stops                                                                      | a step the next one waits on |
| `attention` (default) | only when it fails or asks for an answer or approval; finishes wait for the next routine or chat | long work, batches           |
| `routine`             | never on its own; the next routine reads the queue                                               | background checks            |

A thread that needs an answer always wakes the bot, since it is blocked until someone replies.
Queued events go into the next wake packet as one digest, so ten finished threads cost one turn.

**Think.** The service builds a self-contained wake packet: the notebook, the recent chat, and a
digest of what woke it. Thread transcripts, chat history, and diffs are not pasted in; the bot
fetches what it needs through its tools. A routine that starts late (the server was down or the
bot was busy) says both when it was due and the time now, so the bot does not act as if it were
still 09:00.

**Act.** The bot acts only through the `t3bot` tools, which call the bot service:

| Area     | Tools                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Notebook | read and edit role, routines, items, memory                                                               |
| Threads  | read threads in scope; start a thread; message, interrupt, or settle a thread it owns                     |
| Chat     | reply to or ask the user; list and read any conversation; send to one (the approval card shows the draft) |

## Context length

Compaction and long contexts are safe because no turn depends on an earlier one:

- Every wake packet carries what the turn needs to start, so compaction or a new provider session
  loses nothing.
- Each bot has one work thread. When it grows past a size limit, and at least daily, the service
  starts a fresh provider session in the same thread instead of carrying the old context.
- The packet itself has a hard size cap.
- What the bot must remember, it writes to its notebook before the turn ends.
- Large inputs are read on demand and in pages, because cheap models skim long inputs.

This does not cost prompt caching. Each wake is a new message in the same provider session, so
earlier turns stay a cached prefix and only the packet itself is new input. Two things miss the
cache whatever the design: a wake after the provider's cache lifetime has passed, and the first
turn after a rotation. Rotation therefore happens daily or by size, never per wake.

## Permissions

The role is soft guidance. Permissions are hard: per action allow or ask, set by the user per bot
and enforced by the service; what a bot may never do is not a setting. An `ask` action becomes a question in the bot's chat.

Only actions the bot service performs can be gated. Defaults: reading, notebook edits other than
its role, and work in its own threads are allowed, in the permission mode the user gave the bot,
full access included. Editing its role, sending a chat message, and going over budget are ask.
Messaging threads it does not own and changing its own permissions are denied. The full table is in [bot-architecture.md](./bot-architecture.md#permissions).

A question that would run an action expires 24 hours after it was asked, and the action does not
run: what the bot decided on may no longer hold. The bot sees the expiry on its next turn and can
ask again with fresh facts. A question without an action does not expire.

Limit: a thread the bot starts has the shell access of its runtime mode, so the service cannot stop
a `git push` from inside it. Hard limits on code (no pushes to `main`, no merges, no releases) come
from the thread's runtime mode and branch protection on the forge.

Every bot has a pause switch and a budget (turns per day, concurrent threads, retries per step).
A paused bot keeps its events and runs nothing until resumed.

The settings show only what a user decides: the permission mode, whether it may start and run
threads (allow or ask), the two limits, and its chat channels (below). Editing its role always asks and is not a setting. There is no deny: to stop
a bot, pause it.

## Ownership

- Every thread a bot starts belongs to that bot. The user can also hand one of their threads to a
  bot, which moves it.
- A bot messages, interrupts, or settles only its own threads. It may read other threads in its
  scope, but never sends to them, including another bot's threads.
- When the user sends a message in a bot-owned thread, the thread is the user's until handed back.
  This is derived from the latest message the user typed; messages T3 writes into a thread
  (notifications, subagent results, compaction) do not count.
- Two bots never own the same thread.

## Chat channels

Chat is optional: an environment has a chat channel only when the user configured one in the
inbox, and most have none. Everything below follows the channels configured in that environment,
not a fixed chat app. Without one, bots show no Channels settings, get no chat commands in their
help or wake packet, and the service watches no channel. Configuring a channel changes no bot: each
bot's Channels switch is off until the user turns it on. A removed channel's settings go with it.

To everyone in the chat app there is only the user. Bots stay behind them: nobody can mention a
bot, and nothing a bot sends names it.

- **Channels switch.** One switch per bot turns its chat channels on or off. It is off for a new
  bot and the user turns it on. Off, the bot has no chat tools at all.
- **Per channel.** Under it, each channel configured in the environment has its own settings:
  - **Send messages**: ask (default) or allow. Later, the user can add rules for what goes out
    without asking. Reading any conversation of the channel is always allowed.
  - **Wake on my @-mentions**: on for at most one bot per channel; switching it on for another
    bot moves it there. Other bots are never woken by that channel; they read it when their
    work or the user asks.
- **Waking on a mention.** When someone mentions the user (a mention of everyone does not count),
  the service waits 30 seconds, so the sender can finish and the user can answer first. If the
  user wrote in that conversation since the mention, nothing happens. Otherwise the bot wakes with
  one line per mention (conversation, message, reply thread) and reads the context itself. Mentions
  in that window, or while it runs, join one wake.
- **Signature.** Each bot has an optional signature, set beside its Channels switch and used for
  every channel. It is empty by default, and then messages go out exactly as written. When set,
  the service, not the model, appends it on its own line; `{bot}` in it becomes the bot's name
  when sending.
- **No loops.** Messages sent as the user never wake a bot, so bots cannot answer themselves or
  each other.
- **Stale drafts.** When the user approves a send but has written in that conversation since the
  bot drafted it, it is not sent; the bot hears why and drafts anew if it still needs saying.
- The inbox still shows every mention; a bot handling one does not hide it. When no bot handles
  mentions, or that bot is paused or out of budget, mentions stay in the inbox only.

## Where it lives

In the fork layer of the T3 server, beside the inbox, under the same rules: no contracts, no main
database changes, a few seams.

- Server: `apps/server/src/fork/bot/`. It subscribes to `streamDomainEvents`, starts threads with
  `launchThread`, runs its own timer for routines, and reads and sends chat messages through the inbox's
  operations and `ChannelHub`.
- Web: `apps/web/src/fork/bot/`: the Bots page (bot list, chat, notebook, owned threads) and a
  bot target in the inbox's delegate dialog. The
  chat view reuses the inbox's message list and `ReplyBox`. Permissions, budget, and pause live on
  the same page.
- Tools: the `t3bot` CLI becomes the bot's tool surface, calling `/api/fork/bots/*` with a per-bot
  token; the service checks every call against that bot.
- State: `<stateDir>/bots/` (`bots.sqlite` for chats, owned threads, and sent-message ids; per bot
  a notebook folder).
- The chat adapter stays a separate process and stays only a transport.

## Not in v1

- Replacing T3's execution, queueing, or event sourcing.
- Calling model APIs directly.
- Passing a mention to the bot it fits best; one bot handles them all.
- Triaging the whole inbox: bots are woken only by mentions.
- Bots talking to each other. When it comes, it is bot to bot through the bot service, never one
  bot messaging another bot's threads.
- Bots spanning several environments.
- Talking to a bot from Feishu, and mobile UI (mobile still sees its threads and questions).
