import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { m, type MessageResolver } from "../../i18n/messages";
import { buildThreadFeed, workEntryRowLabel } from "../../lib/threadActivity";

const decodeStep = Schema.decodeUnknownOption(OrchestrationV2TurnItemJson);

const labels = new WeakMap<
  object,
  { readonly resolve: MessageResolver; readonly label: string | null }
>();

/** A bot's tool step, labelled as the thread feed shows the same call. */
export function botStepLabel(step: unknown, resolve: MessageResolver = m): string | null {
  if (step === null || typeof step !== "object") return null;
  const cached = labels.get(step);
  if (cached !== undefined && cached.resolve === resolve) return cached.label;
  const item = Option.getOrNull(decodeStep(step));
  const entry =
    item === null
      ? undefined
      : buildThreadFeed(
          [
            {
              position: 0,
              visibility: "local",
              sourceThreadId: item.threadId,
              sourceItemId: item.id,
              item,
            },
          ],
          { resolve },
        )
          .flatMap((feedEntry) => (feedEntry.type === "activity-group" ? feedEntry.activities : []))
          .at(0)?.workEntry;
  const label = entry === undefined ? null : workEntryRowLabel(entry, false, resolve);
  labels.set(step, { resolve, label });
  return label;
}
