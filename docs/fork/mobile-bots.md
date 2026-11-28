# Bots on mobile (draft)

Status: steps 1–4 built and verified on Android. The Notebook sheet, per-bot drafts, and iOS
verification are still pending.

## Problem

Bots work while the user is away from the desk, and that is when the user has only a phone. Today
the phone shows a bot's work threads, but not the bot: not its posts, not its questions, and not
whether it is working, stuck, or paused. A question the bot asks at 09:00 waits until the user is
back at a computer.

## Scope

The mobile app shows bots the way the desktop sidebar does. The user can glance at every bot, open
one, read its chat, answer its questions, write to it, and open the threads it started.

Not in this step:

- **The inbox.** Its UI and the follow-up flow are still changing. It stays web and desktop only
  until that settles, and then gets its own design.
- **A badge on the Threads tab.** Upstream's tab has none, and the bot's row already shows Input.
- **Creating, configuring, or deleting a bot.** These stay on desktop. Editing the role and
  notebook does too.
- **Push notifications for bot questions.** These need the fork server to use the existing push
  registration, which is its own piece of work.

## Where bots show

Bots get a pinned group at the top of the Threads list, as on desktop. They do not get a tab of
their own.

- A bot's work is threads, so bots belong beside threads. Desktop puts them in the same place, so
  there is one model to learn.
- A tab would add a fifth slot, which turns on upstream's tab customization. It would also put a
  second list one switch away from the first.
- The list already has a header slot (`ListHeaderComponent` in `HomeScreen.tsx`), so the mount is
  one line in an upstream file. Tablets get the group too, since their sidebar renders the same
  list.

```text
┌ Threads ──────────────── ⌕ ⋯ ┐
│ BOTS                        ⌄ │
│ R  Release Watcher     Input  │  ← one status, the most pressing
│    Should I fix CI on main?   │
│ T  Triage Bot        Working  │
│    Looking at #infra alerts   │
│ WORKING                     ⌄ │  ← upstream shelves, untouched
│ …                             │
```

## The Bots group

The group follows the desktop group's rules, built from the mobile app's own parts.

- **Header.** "Bots" and a collapse chevron, with no count and no rule: the card below already
  groups the rows, as the grouped lists in Settings do. Tapping it collapses the group, and the
  choice is remembered on the device. The group follows the list's environment filter (a project
  filter narrows it to that project's environments); when no environment in view has a bot, there
  is no group.
- **Card.** The rows sit on a `grouped-card` surface with the Settings group radius, so the threads
  below do not read as part of the group. The list itself is already a raised sheet; the card is
  one step off it in every theme, including Absolutely, whose dark card is darker than its sheet.
  Rows paint the card color rather than the screen color; Android rows are rounded blocks inside
  the card, iOS rows run edge to edge with dividers.
- **Rows.** The bot's initial fills a two-line avatar in the theme's primary tint. Line 1 is the
  name and one status; line 2 is the last message and the bot's provider icon, as on desktop. The
  environment name stays out of the row (host names are long and would hide the message); screen
  readers still hear it. Rows have no swipe actions.

- **Status.** The status is the most pressing of these:
  1. a waiting question (Input);
  2. the work thread blocked on the user (Approval, Input, Request, Failed, Limited);
  3. the unread count;
  4. Working;
  5. Paused;
  6. how long ago the last message was sent.

  Statuses take the form of `STATUS_LABEL_BY_STATUS`: a symbol plus a bold `text-xs` label. The
  blocked work thread uses the mobile thread list's own labels and colors
  (`resolveThreadListV2RowStatus`), so a bot looks the same as its own thread would.

  Mobile thread rows have no count badge, so unread posts show as "2 new" in `text-primary-text`.
  Paused uses `foreground-muted`. A working bot's row recedes as a working thread's does
  (`shouldRecedeThreadRow`), since nothing waits on the user.

- **Search.** The group hides while the user searches the list, as on desktop.
- **Work threads.** A bot's own work thread is left out of the list, since its row stands for it.
  Threads a bot starts in projects stay in the list.

The status order comes from a shared function in the fork package (see [Code](#code)), not
from a copy per client. The desktop sidebar moves to the same function.

## The bot screen

The screen is the desktop bot page's chat, which already reads like a thread. It follows
[Mobile layout](../internals/11_mobile-layout.md) and
[Mobile navigation](../internals/12_mobile-navigation.md), the same as upstream screens:

- **Route.** `Bot` is a `pageRoute`.
- **Selecting.** Tapping a row selects the bot with `selectWorkspaceDetail`, as a thread row does.
  It does not push. This adds `Bot` to `WorkspaceDetail` and its identity keys. The shell then
  places it: pushed on a phone, in the detail column on a tablet.
- **Drilling in.** Opening a thread from the bot screen pushes with `StackActions.push`, so Back
  returns to the bot.
- **No layout decisions.** The screen never checks the platform or the width.

The screen's parts:

- **Header.** One `AppBar`. Its title is the bot's name, and its `subtitle` is the status
  ("Working · 1m", "Paused"), as on the thread screen. The ⋯ menu holds Notebook, Work thread,
  and Pause or Resume.
- **Chat.** The bot's chat. Messages render as Markdown with the thread view's renderer, steps use
  the thread's work-log rows, and the newest message stays in view as messages arrive.
- **Questions.** A waiting question docks above the composer and can be collapsed, the way a
  thread's pending input does on mobile. It does not sit in the feed as it does on desktop. It is
  built from `PendingUserInputCard`'s parts: question text, options, and "Other…". It is not that
  component, which is bound to a thread's runtime request. Answering a question removes its card,
  and the next question takes its place.
- **Working.** While the bot works, a row shows its current step and opens that thread when
  tapped.
- **Paused.** A paused bot shows a notice above the composer with a Resume button.
- **Composer.** Built on `ComposerSurface`, without the model controls. Attachments are planned;
  see [Attachments](#attachments-planned). The user can
  write while a turn runs, as on desktop. Drafts are kept per bot on the device.
- **Seen.** Opening the screen marks the bot's posts seen, the same call the desktop page makes.

Citations and quotes:

- A citation of the bot's own chat scrolls to the cited message.
- A quote of a chat-app message shows its text but does not link anywhere, because the inbox is
  not on mobile yet.
- A link to a thread opens the mobile thread screen.

### Notebook

Notebook is an inspector pane, declared with `<Inspector>` and opened with `showInspector()`. The
shell shows it as a column beside the chat where there is room, which matches the desktop side
panel, and as a sheet on a phone.

It is read-only on mobile. It shows the bot's role, work items, routines, memory, and threads,
each in a `FormSection`. A thread in it opens the thread screen after the sheet closes
(`InspectorSheetContext`). Editing stays on desktop, and the pane says so in one line.

## Live updates

The desktop page refetches on the fork's event stream (`/api/fork/inbox/events`, SSE). React
Native has no `EventSource`, so the mobile client reads the stream with a small reader over
`XMLHttpRequest`, without adding a dependency. It refetches on bot events, on reconnect, and when
the app returns to the foreground, since the stream does not survive the background. A slow poll
keeps the work thread's state current, as on desktop.

### Attachments (planned)

Status: designed, not built. It needs the server step of
[Attachments](./bot-architecture.md#attachments-planned) first.

```text
┌ Release Watcher ─────────────────┐
│  …chat…                           │
│              ┌──────┐ ┌──────┐    │  ← user message: image grid
│              │ img  │ │ img  │    │
│              └──────┘ └──────┘    │
│              📄 crash.log · 12 KB  │  ← file chip, opens AttachmentFileScreen
├───────────────────────────────────┤
│ [img ×][img ×][📄 log ×]           │  ← ComposerAttachmentStrip: progress, failure
│ ＋  Message Release Watcher    ⬆  │
└───────────────────────────────────┘
   ＋ → Photo library / Camera / File / Paste image
```

- **Composer.** The thread composer's attachment parts, not new ones: `ComposerAttachmentStrip`,
  `useComposerAttachmentActions` (library, camera, files, clipboard), and
  `composerAttachmentUploadQueue`. Their state is keyed by draft key; the bot's draft key starts
  with its environment id (`<environmentId>:bot:<botId>`) so `composerDraftEnvironmentId` resolves
  the upload's environment. Check that before building; if the draft store needs more, the change
  belongs in a seam, not a copy.
- **Where the button goes.** `IssueCommentComposer` gets an optional attachment slot (the ＋
  button and the strip), the same kind of seam as its optional `copy`. If the attachment hooks
  turn out to be bound to a thread's composer state, the bot screen composes its own small
  composer from `ComposerSurface` and these parts instead. Decide when building, and record which.
- **Sending.** A message with only attachments can be sent. The send waits for uploads to finish,
  as the thread composer does; a failed upload keeps the draft.
- **Messages.** User messages show the thread feed's image tiles and file chips. Images open the
  shared file preview (`FilePreviewSession`), files open `AttachmentFileScreen`.
- **Share to a bot (optional, after the above).** `IncomingShareProvider` already imports shares
  from other apps. Bots become share targets ("Send to Release Watcher"), so a screenshot or log
  reaches a bot in two taps, the most common reason to message a bot from a phone.

Verify on the Android emulator against dev state: pick from the library, take a photo, attach a
file, send attachments only, a failed upload, open an image and a file from the chat. Screenshot
each, and record one video of the flow.

## Code

Platform-neutral code moves into a new fork package, `packages/fork-client`, so it is not copied
and upstream's `client-runtime` stays untouched:

- the bot types (`BotSummary`, the bot detail, questions, notebook);
- the row status rule (`botRowStatus`, `botAttention`) and the work-thread keys lists leave out;
- the event-stream parser, which mobile needs and web does not.

Request paths stay literal in each client, as on web.

Each client keeps its own transport:

- Web keeps `forkRequest`.
- Mobile gets one built on `resolveDeviceHubAccess`, which mobile already uses for the device hub,
  so remote environments and relay connections work as they do on web.

Screens live in `apps/mobile/src/fork/`.

Two more constraints apply to mobile code:

- **Android renders Home twice**, in the sidebar column and as the root of the content stack. The
  Bots group therefore mounts twice. It shares one event stream per environment, and any
  focus-gated hook in it also accepts `usePaneRole() === "sidebar"`.
- **React Compiler.** Fork files have no manual `useMemo`, `useCallback`, or `memo`, and must
  compile under `reactCompilerCoverage.test.ts`.

### Mobile seams

These are the upstream files touched. They go in one `fork(mobile-bots): wire seams` commit and are
added to the seam check.

| File                                                  | Change                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/mobile/src/features/home/HomeScreen.tsx`        | `<ForkBotsGroup />` in `v2ListHeader`                                                |
| `apps/mobile/src/features/home/HomeRouteScreen.tsx`   | Bot work threads left out of `threads`                                               |
| `apps/mobile/src/Stack.tsx`                           | `Bot` route, `bots/:environmentId/:botId`                                            |
| `.../layout/workspace/workspace-detail-selection.ts`  | `Bot` in `WorkspaceDetail` and `IDENTITY`                                            |
| `.../threads/thread-list-v2-items.tsx`                | Export `ThreadListV2Section`, `STATUS_LABEL_BY_STATUS`                               |
| `.../issues/IssueCommentComposer.tsx`                 | Optional `copy`, so the bot composer reuses it; planned: an optional attachment slot |
| `apps/mobile/src/lib/android-workspace-navigation.ts` | `Bot` swaps the detail pane without a push                                           |
| `vite.config.ts`                                      | Copy lint exception and theme allowance for fork files                               |

## Build order

1. `packages/fork-client`, with the web sidebar and bot page moved onto it, with no visible
   change.
2. The mobile transport and event reader, with tests against the example server.
3. The Bots group and the work-thread filter.
4. The bot screen: chat, questions, working row, pause, and composer.
5. The Notebook sheet.
6. An Android pass in a real app against dev state, then the iOS tab bar and header check.
7. Attachments (planned): the composer and message display, then sharing to a bot.

## Copy

Mobile fork screens are in English, like web fork code, with the same lint exception
(`apps/mobile/src/fork/**`). Adding their strings to the ten mobile catalogs would conflict on every
upstream sync.
