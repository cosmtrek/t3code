import { describe, expect, it } from "vite-plus/test";

import { botStep } from "./botStep";

const base = {
  id: "item-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: "2026-11-27T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-11-27T00:00:00.000Z",
};

describe("botStep", () => {
  it("labels a tool call as the thread timeline's live row does", () => {
    expect(botStep({ ...base, type: "command_execution", input: "rg -n token src" })).toEqual({
      label: "Running rg",
      icon: "terminal",
    });
  });

  it("gives nothing for a step it cannot read, so the line falls back to its text", () => {
    expect(botStep({ type: "command_execution" })).toBeNull();
    expect(botStep(undefined)).toBeNull();
  });
});
