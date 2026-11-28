import { describe, expect, it } from "vite-plus/test";
import { botFileLink } from "./botFileLink";

const context = {
  environmentId: "remote",
  workThreadId: "thread",
  workspacePath: "/bots/workspace",
};
describe("bot file navigation", () => {
  it("preserves the environment, absolute path and target line", () => {
    expect(botFileLink("/tmp/report.ts#L12", context)).toEqual({
      screen: "ThreadFile",
      params: {
        environmentId: "remote",
        threadId: "thread",
        path: ["", "tmp", "report.ts"],
        line: "12",
      },
    });
  });
  it("uses the workspace route without a thread", () => {
    expect(botFileLink("notes/report.md", { ...context, workThreadId: null })).toEqual({
      screen: "NewTaskFile",
      params: {
        environmentId: "remote",
        path: ["notes", "report.md"],
        cwd: "/bots/workspace",
        projectName: "/bots/workspace",
      },
    });
  });
  it("keeps old servers with a thread working", () => {
    // @ts-expect-error Exercise a legacy server response missing the now-required workspace path.
    expect(botFileLink("notes/report.md", { ...context, workspacePath: undefined })?.screen).toBe(
      "ThreadFile",
    );
  });
  it("does not invent a workspace or intercept external links", () => {
    expect(
      // @ts-expect-error Exercise a legacy server response missing the now-required workspace path.
      botFileLink("notes/report.md", { ...context, workThreadId: null, workspacePath: undefined }),
    ).toBeNull();
    expect(botFileLink("https://example.com", context)).toBeNull();
  });
});
