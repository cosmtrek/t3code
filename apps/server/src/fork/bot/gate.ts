/**
 * Whether a bot may take an action now, ask the user first, or not take it at all. Pure: the
 * caller looks up ownership and budget, this decides.
 */
import type { BotSettings, GatedAction, Permission } from "./store.ts";

export interface GateInput {
  readonly settings: BotSettings;
  readonly action: GatedAction;
  /** Taking it would pass the bot's budget. */
  readonly overBudget: boolean;
}

export function decide(input: GateInput): Permission {
  const permission = input.settings.permissions[input.action];
  if (permission === "deny") return "deny";
  return input.overBudget ? "ask" : permission;
}

/** Questions that would run an action stop holding after a day: the facts may have moved. */
export const QUESTION_TTL_MS = 24 * 3_600_000;
