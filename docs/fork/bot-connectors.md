# Bot connectors (draft)

Status: design, not built. How a bot reaches systems outside T3 Code. The bot itself is in
[bot.md](./bot.md) and [bot-architecture.md](./bot-architecture.md); the chat channel it uses
first is in [inbox-architecture.md](./inbox-architecture.md).

## Problem

A bot already reaches one outside system, the chat channel, and it is wired through the core:
`tools.ts` has a `chat` branch with its own flags and help, `packet.ts` a chat brief,
`store.ts` the channel settings and the mention tables, `saveSettings` the one-bot-per-channel
loop, `layer.ts` the mention watcher, and the Bots page a hard-coded Channels section. Each
command decides on its own whether to call the gate. A second outside system (a CLI such as `gh`,
an MCP server) would repeat all of that.

The bot's runtime cannot carry those systems for us. Its work thread is an ordinary T3 thread on
whatever provider the bot uses, and T3 has no way to add MCP servers or tools to one thread; the
provider's own configuration is global to every thread and bypasses the bot's permissions.

## The model

- **Core** is what makes a bot a bot: `say`, `ask`, the notebook, routines, skills, and threads.
  These stay in the bot service and are not connectors, T3's own capabilities included.
- **A connector** is an outside system the bot uses through `t3bot`. It has a **kind**, code in
  the fork (`chat` now, `exec` and `mcp` later), and **instances**, which come from configuration:
  each chat channel of the environment is one `chat` instance.
- The bot service is the only way in. A connector runs in the server, holds its own
  credentials, and is reached by the bot through the same `t3bot` CLI and HTTP route as today, so
  it works the same with every provider.
- The core imports no connector. It knows the connector interface and a registry.

## Calling one

The instance's id is its command:

```text
t3bot lark unread
t3bot lark list [--query <name>]
t3bot lark read <conversation> [--limit n] [--before <cursor>] [--root <message>]
t3bot lark send <conversation> [--reply-to <message>] -
```

- A chat instance's id is its channel id: a slug of lowercase letters, digits, and dashes,
  unique in the environment, fixed when the channel is created. Display names are not used; they
  change and may not be Latin text, and a bot's skills and notes name the command.
- One rule for every kind: `t3bot <instance> <operation>`. A later `exec` instance reads
  `t3bot gh pr view 12`, an `mcp` one `t3bot notion call search -`. The kind never appears in a
  command.
- Core command names (`help`, `say`, `notebook`, `role`, `item`, `routine`, `memory`, `thread`)
  are reserved, and so is `chat`. An instance whose id is taken is shown as down with that reason
  and gets no command. `t3bot chat …` answers with the instances to use instead, so a bot with an
  old skill corrects itself.
- `help` is the core help followed by one block per instance the bot has on. The packet gets one
  line per such instance from the connector (what it is, how it sends, whether it wakes the bot).
  With none on, neither mentions connectors.

## Resolve, then gate

A connector never runs a command directly. It resolves the call into an action, and the core
decides whether and when it runs:

```ts
type Action =
  | { readonly effect: "read"; readonly run: () => Effect<string> }
  | {
      readonly effect: "write";
      readonly operation: string; // permission key within the instance: "send"
      readonly what: string; // the approval card's line: send as you to "产品群"
      readonly detail: string; // what goes out, exactly: the draft with its signature
      readonly run: (context: { readonly askedAt?: string }) => Effect<string>;
    };
```

- A read runs at once. Reading is allowed whenever the instance is on; to stop reads, turn the
  instance off.
- A write runs when the bot's permission for `<instance>/<operation>` is `allow`, otherwise it
  becomes a question, `ask` being the default for every write. The question stores the argv, as
  today. Approving resolves the stored argv again and calls `run` with `askedAt`.
- Resolving again on approval re-checks what may have moved since the ask: the conversation still
  exists, the instance is still on. `askedAt` lets a connector refuse a stale action itself: chat
  sends nothing when the user wrote in that conversation after the draft.
- `detail` is built while resolving, so the card shows what will go out, signature included.

The split is the point of the interface. A connector has no path that writes without passing the
gate, so forgetting the gate is not a bug a connector can have.

## Settings

Per bot, per instance, set only by the user:

```ts
connectors: Record<
  instanceId,
  {
    enabled: boolean; // off for a new bot and for a new instance
    permissions: Record<operation, "allow" | "ask">; // missing means ask
    config: unknown; // the kind's own, decoded by its schema
  }
>;
```

- A kind may veto or adjust a save (`onSave`), for rules across bots. Chat uses it for "at most
  one bot wakes on mentions per channel": turning it on for one bot turns it off for the other in
  the same write.
- The signature moves into chat's `config` per instance. Today's single signature is copied to
  every channel when settings migrate.
- Settings of an instance that no longer exists are ignored and dropped on the next save.

## State

A kind keeps what it must remember in `bots.sqlite`, in tables it creates and migrates under its
own prefix. Chat keeps the existing `mentions` and `sent_messages` tables under their names;
only the code that reads them moves into the connector.

## Waking a bot

A kind may run a background task while any bot exists. It turns outside events into lines for
the bots it chooses and calls `notify(botId, line, wakes)`, the same call thread events and
routines use, so queueing, coalescing, and budgets are unchanged. Which bot an event is for is the
kind's rule, not the core's: chat wakes the one bot that handles mentions in that channel.

## Status and output

- Each instance reports `ok`, `degraded`, or `down` with a reason. The Bots page shows it, and the
  packet line says when an instance cannot be used, so the bot does not retry blindly. Chat maps
  the channel's own status ("Sign-in needed" reads but cannot send).
- The core caps what a connector returns: past the cap, the bot gets the head and the path of a
  file in its workspace with the rest. Connectors that page (chat) keep their pages small anyway;
  `exec` and `mcp` output relies on the cap.

## Chat: the first kind

The behavior is today's, moved out of the core:

| Today                                             | In the chat connector                          |
| ------------------------------------------------- | ---------------------------------------------- |
| `t3bot chat …`, conversations as `<channel>/<id>` | `t3bot <channel> …`, conversations by their id |
| Channels switch per bot                           | `enabled` per instance                         |
| Per-channel send permission                       | `permissions.send`                             |
| One signature per bot                             | `config.signature` per instance                |
| Wake on mentions, one bot per channel             | `config.mentions`, enforced in `onSave`        |
| Stale draft check after approval                  | in `run`, from `askedAt`                       |
| `watchMentions` in `layer.ts`                     | the kind's background task                     |

Reads still go through the inbox's operations and `ChannelHub`, and sends through the inbox's
`send` with the user's identity. The channel protocol and adapters do not change.

## Later kinds

Sketches that check the interface holds; neither is built with this change.

- **`exec`**: runs a CLI the user registers in `<stateDir>/bots/connectors.json` (command, env
  from the connector's own secrets, timeout, and which argv prefixes are reads). It runs with
  `execFile`, no shell, stdin closed. An argv that matches no read prefix is a write, and its
  operation is the matched write prefix (`pr merge`) or the subcommand. The approval card shows the
  command line.
- **`mcp`**: the bot service is the MCP client of a stdio or HTTP server registered the same way.
  `tools` lists, `describe <tool>` prints a schema, `call <tool> -` takes JSON arguments. A tool
  annotated `readOnlyHint: true` is a read; any other is a write with the tool's name as its
  operation. One process per instance, shared by bots, started on use. No OAuth, sampling, or
  elicitation at first; MCP results give actions only, never wakes.

## Limits

A connector's gate is real only for credentials the bot's shell does not hold. A bot can run any
CLI its runtime mode allows, and the bot runs as the same OS user as the server, as
[bot-architecture.md](./bot-architecture.md#permissions) already accepts. Connectors make outside
systems visible to the bot, keep their writes behind the user's approval, and keep credentials
out of the bot's way; they do not contain a bot that sets out to get around them. Hard limits
belong to the outside system, such as a read-only token.

## Building it

1. Interface, registry, and dispatch: `t3bot <instance>` resolves through the registry, writes go
   through the core gate, and approval resolves again. Chat moves into `connectors/chat/` with its
   commands renamed to the channel's id, and `t3bot chat` answers with the hint.
2. Settings migrate to `connectors`; the packet and help are built from the instances a bot has
   on; the mention watcher becomes chat's background task.
3. The Bots page: a Connectors group with one section per instance (switch, status, and one
   allow-or-ask row per write operation, rendered from what the kind declares), plus chat's own
   rows for signature and mentions.
4. `bot.md` and `bot-architecture.md` point here for outside systems.

Existing tests for chat, operations, and the packet should pass with commands renamed. New tests
cover that every write passes the gate, that approval resolves again and a vanished target runs
nothing, that a reserved or taken id gets no command, and the settings migration.
