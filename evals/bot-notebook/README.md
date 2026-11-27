# bot-notebook

Whether a bot files what the user tells it in the right part of its notebook: a standing rule in its role, a fact it learned in memory, a repeatable procedure in a skill. It builds the bot's real turn packet and `t3bot help` from `apps/server/src/fork/bot`, asks the model which commands it would run, and grades where they write.

A rule must reach the role and not memory. A fact or procedure must not reach the role.

## Run

```sh
pnpm bot-notebook --out runs/<name> [--model haiku] [--samples 3] [--case <id>]
```

It drives the local `claude` CLI with no tools, on the account it is signed in to. A full run is 18 short calls on Haiku. A case fails when half or more of its samples fail.

## Add a case

Add it to `cases.ts` with its source and the place it belongs. Run it on the text before your fix first: it must fail there.
