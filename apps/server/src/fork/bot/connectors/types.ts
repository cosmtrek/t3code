/**
 * Connectors: outside systems a bot uses through `t3bot <instance> <operation>`. A connector only
 * resolves a call into an action; the core gates every write before it runs. See
 * docs/fork/bot-connectors.md.
 */
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  type InboxOperations,
  type InboxOperationError,
  type InboxRejection,
} from "../../inbox/operations.ts";
import type { Artifacts } from "../../inbox/artifacts.ts";
import type { BotRuntime, BotRuntimeError } from "../BotRuntime.ts";
import type { BotCore, BotOperations } from "../operations.ts";
import { BotRejection } from "../errors.ts";
import type { InboxStoreError } from "../../inbox/store.ts";
import type { Bot, BotStoreError, ConnectorSettings } from "../store.ts";

/** What a connector may use: the bot's own services, its threads, and waking bots. */
type BotServices =
  | Artifacts
  | InboxOperations
  | BotRuntime
  | ThreadManagement.ThreadManagementService;

export type InstanceStatus = "ok" | "degraded" | "down";

export interface Operation {
  readonly id: string;
  readonly label: string;
}

/** One instance of a connector kind, such as one chat channel. Its id is its command. */
export interface Instance {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly status: InstanceStatus;
  readonly reason: string | null;
  /** Its writes, each allow or ask per bot. */
  readonly operations: ReadonlyArray<Operation>;
}

export interface FlagSpec {
  readonly values?: ReadonlyArray<string>;
  readonly booleans?: ReadonlyArray<string>;
}

export interface ConnectorCall {
  readonly bot: Bot;
  readonly instance: Instance;
  readonly settings: ConnectorSettings;
  readonly operation: string | undefined;
  /** The words after the operation, flags taken out. */
  readonly args: ReadonlyArray<string>;
  readonly flags: ReadonlyMap<string, string>;
  readonly stdin: string;
}

type Run = Effect.Effect<
  string,
  | BotRejection
  | BotRuntimeError
  | BotStoreError
  | InboxOperationError
  | InboxRejection
  | InboxStoreError,
  BotServices
>;

export type Action =
  | { readonly effect: "read"; readonly run: Run }
  | {
      readonly effect: "write";
      /** Its permission key within the instance. */
      readonly operation: string;
      /** The approval card's line. */
      readonly what: string;
      /** What goes out, exactly as it will. */
      readonly detail: string;
      /** `askedAt` is set when the user approved a question asked then. */
      readonly run: (context: { readonly askedAt?: string }) => Run;
    };

export interface Connector {
  readonly kind: string;
  readonly instances: Effect.Effect<ReadonlyArray<Omit<Instance, "kind">>>;
  /** The flags each operation takes; any other `--word` is text. */
  readonly flags: Readonly<Record<string, FlagSpec>>;
  readonly help: (instance: Instance) => string;
  /** Lines for the wake packet's brief, for a bot that has the instance on. */
  readonly brief: (instance: Instance, settings: ConnectorSettings) => ReadonlyArray<string>;
  readonly resolve: (
    call: ConnectorCall,
  ) => Effect.Effect<
    Action,
    BotRejection | InboxOperationError | InboxRejection | InboxStoreError,
    BotServices
  >;
  /** The kind's own settings from what the user saved. */
  readonly config: (
    input: unknown,
    context: {
      readonly before: ConnectorSettings;
      readonly enabled: boolean;
      readonly now: string;
    },
  ) => Effect.Effect<Readonly<Record<string, unknown>>, BotRejection>;
  /** Facts the settings dialog shows for an instance, beside the bot's own settings. */
  readonly info?: (
    instanceId: string,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, BotStoreError, BotRuntime>;
  /** Rules across bots, after one bot's settings for the instance were saved. */
  readonly afterSave?: (
    botId: string,
    instanceId: string,
  ) => Effect.Effect<
    void,
    Effect.Error<BotRuntime["Service"]["store"]> | BotStoreError,
    BotRuntime
  >;
  /** Runs while any bot exists; wakes bots with `notify`. */
  readonly start?: Effect.Effect<
    void,
    never,
    BotServices | BotOperations | Effect.Services<ReturnType<BotCore["notify"]>> | Scope.Scope
  >;
}

export const toolError = (detail: string) =>
  new BotRejection({ code: "tool_error", message: detail });

/** The words after the operation, or stdin for `-`. */
export const textOf = (words: ReadonlyArray<string>, stdin: string) =>
  (words.length === 1 && words[0] === "-" ? stdin : words.join(" ")).trim();
