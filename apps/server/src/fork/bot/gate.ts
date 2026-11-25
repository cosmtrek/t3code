/**
 * Whether a bot may take an action now or must ask the user first. Pure: the caller looks up the
 * permission and the budget, this decides.
 */
import type { Permission } from "./store.ts";

export interface GateInput {
  readonly permission: Permission;
  /** Taking it would pass the bot's budget. */
  readonly overBudget: boolean;
}

export function decide(input: GateInput): Permission {
  return input.overBudget ? "ask" : input.permission;
}

/** Questions that would run an action stop holding after a day: the facts may have moved. */
export const QUESTION_TTL_MS = 24 * 3_600_000;
