import { describe, expect, it } from "vite-plus/test";

import { botStepLabel } from "./botStep";

const step = (status: "running" | "completed") => ({
  id: `turn-item:${status}`,
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "node-1",
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status,
  title: null,
  startedAt: "2026-11-28T10:51:04.000Z",
  completedAt: null,
  updatedAt: "2026-11-28T10:51:04.000Z",
  type: "dynamic_tool",
  toolName: "t3-code.t3_thread_list",
  input: { limit: 15, settled: false },
});

describe("botStepLabel", () => {
  it("labels a tool step as the thread feed does, not by its item type", () => {
    expect(botStepLabel(step("running"))).toBe("Listing T3 threads");
  });

  it("has no label for a line without a step", () => {
    expect(botStepLabel(undefined)).toBeNull();
    expect(botStepLabel({ type: "dynamic_tool" })).toBeNull();
  });
});
