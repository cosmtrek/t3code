import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { liveWorkEntryLabel } from "../../components/chat/MessagesTimeline.logic";
import { workEntryIconName } from "../../components/chat/TimelineWorkEntryRow.logic";
import type { WorkEntryIconName } from "../../components/chat/TimelineToolActivityIcon";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";

const decodeStep = Schema.decodeUnknownOption(OrchestrationV2TurnItemJson);

export interface BotStep {
  readonly label: string;
  readonly icon: WorkEntryIconName;
}

const steps = new WeakMap<
  object,
  { readonly root: string | undefined; readonly step: BotStep | null }
>();

/** A bot's tool step, labelled and iconed as the thread timeline shows the same call. */
export function botStep(step: unknown, workspaceRoot?: string): BotStep | null {
  if (step === null || typeof step !== "object") return null;
  const cached = steps.get(step);
  if (cached !== undefined && cached.root === workspaceRoot) return cached.step;
  const item = Option.getOrNull(decodeStep(step));
  const entry =
    item === null
      ? undefined
      : deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            {
              position: 0,
              visibility: "local",
              sourceThreadId: item.threadId,
              sourceItemId: item.id,
              item,
            },
          ],
          optimisticMessages: [],
        }).find((candidate) => candidate.kind === "work");
  const result =
    entry?.kind === "work"
      ? {
          label: liveWorkEntryLabel(entry.entry, workspaceRoot, true),
          icon: workEntryIconName(entry.entry),
        }
      : null;
  steps.set(step, { root: workspaceRoot, step: result });
  return result;
}
