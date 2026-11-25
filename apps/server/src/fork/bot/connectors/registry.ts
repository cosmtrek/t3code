/**
 * The connector kinds this build has, and their instances in this environment. The core reaches
 * connectors only through here.
 */
import * as Effect from "effect/Effect";

import type { Bot } from "../store.ts";
import { connectorSettings } from "../store.ts";
import { chatConnector } from "./chat/connector.ts";
import type { Connector, Instance } from "./types.ts";

const CONNECTORS: ReadonlyArray<Connector> = [chatConnector];

/** Core commands, and `chat`, which named every channel before channels were connectors. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "say",
  "notebook",
  "role",
  "item",
  "routine",
  "memory",
  "thread",
  "chat",
]);

export interface Entry {
  readonly connector: Connector;
  readonly instance: Instance;
  /** False when its id is reserved or another instance has it: it gets no command. */
  readonly callable: boolean;
}

export const listInstances = Effect.fn("ForkBot.listInstances")(function* () {
  const entries: Array<Entry> = [];
  const taken = new Set<string>();
  for (const connector of CONNECTORS) {
    for (const found of yield* connector.instances) {
      const clash = RESERVED_COMMANDS.has(found.id)
        ? `"${found.id}" is a t3bot command`
        : taken.has(found.id)
          ? `another connector is named "${found.id}"`
          : null;
      taken.add(found.id);
      entries.push({
        connector,
        callable: clash === null,
        instance: {
          ...found,
          kind: connector.kind,
          ...(clash === null
            ? {}
            : { status: "down" as const, reason: `${clash}; rename it to use it here` }),
        },
      });
    }
  }
  return entries as ReadonlyArray<Entry>;
});

/** The instances this bot has on, in registry order. */
export const enabledFor = Effect.fn("ForkBot.enabledFor")(function* (bot: Bot) {
  return (yield* listInstances()).filter(
    (entry) => entry.callable && connectorSettings(bot.settings, entry.instance.id).enabled,
  );
});

export const briefFor = Effect.fn("ForkBot.briefFor")(function* (bot: Bot) {
  return (yield* enabledFor(bot)).flatMap(({ connector, instance }) => [
    ...connector.brief(instance, connectorSettings(bot.settings, instance.id)),
    ...(instance.status === "ok" ? [] : [`  Now: ${instance.reason ?? instance.status}.`]),
  ]);
});

export const helpFor = Effect.fn("ForkBot.helpFor")(function* (bot: Bot) {
  const enabled = yield* enabledFor(bot);
  return enabled.length === 0
    ? ""
    : ["", ...enabled.map(({ connector, instance }) => connector.help(instance))].join("\n");
});

export const startConnectors = Effect.all(
  CONNECTORS.flatMap((connector) => (connector.start === undefined ? [] : [connector.start])),
  { concurrency: "unbounded", discard: true },
);
