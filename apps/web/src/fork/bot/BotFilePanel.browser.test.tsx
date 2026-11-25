import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import ChatMarkdown from "../../components/ChatMarkdown";
import { useRightPanelStore } from "../../rightPanelStore";
import { BotFilePanel, useBotFiles } from "./BotFilePanel";

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => noConfig },
  };
});

vi.mock("../../components/files/FilePreviewPanel", () => ({
  default: (props: {
    relativePath: string;
    revealLine: number;
    revealRequestId: number;
    composerDraftTarget: unknown;
  }) => (
    <div role="tabpanel">
      {props.relativePath}:{props.revealLine}:{props.revealRequestId}:
      {typeof props.composerDraftTarget === "string" ? "workspace" : "thread"}
    </div>
  ),
}));

function Harness({ threadId }: { threadId: string | null }) {
  const files = useBotFiles(EnvironmentId.make("test"), "bot", threadId, "/workspace");
  const [open, setOpen] = useState(true);
  return (
    <>
      <ChatMarkdown
        text="[first](/workspace/a.ts#L4)"
        cwd="/workspace"
        environmentId={EnvironmentId.make("test")}
        onOpenFileInPanel={(path, line) => {
          files.open(path, line);
          setOpen(true);
        }}
      />
      <button
        onClick={() => {
          files.open("/workspace/a.ts", 12);
          setOpen(true);
        }}
      >
        Reopen at line 12
      </button>
      <button onClick={() => files.open("/workspace/b.ts", 2)}>Second file</button>
      <button onClick={() => setOpen(true)}>Show panel</button>
      {open && (
        <BotFilePanel
          files={files}
          cwd="/workspace"
          name="Bot"
          hasThread={threadId !== null}
          overlay={false}
          onHide={() => setOpen(false)}
          onCloseFile={files.close}
        >
          <p>Profile content</p>
        </BotFilePanel>
      )}
    </>
  );
}

it.each([null, "work-thread"])(
  "opens files, reuses tabs and preserves them across profile and hide: %s",
  async (threadId) => {
    const previous = useRightPanelStore.getState().byThreadKey;
    using _store = {
      [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: previous }),
    };
    useRightPanelStore.setState({ byThreadKey: {} });
    await using _screen = await render(<Harness threadId={threadId} />);
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
    await page.getByRole("link").filter({ hasText: "a.ts" }).click();
    await expect
      .element(page.getByRole("tabpanel"))
      .toHaveTextContent(`/workspace/a.ts:4:1:${threadId ? "thread" : "workspace"}`);
    await page.getByRole("button", { name: "Second file", exact: true }).click();
    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    await expect.element(page.getByText("Profile content")).toBeVisible();
    await page.getByRole("button", { name: "Hide panel", exact: true }).click();
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Reopen at line 12", exact: true }).click();
    const targetKind = threadId ? "thread" : "workspace";
    await expect
      .element(page.getByRole("tabpanel"))
      .toHaveTextContent(`/workspace/a.ts:12:2:${targetKind}`);
    await expect.element(page.getByRole("tab", { name: "a.ts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close /workspace/a.ts", exact: true }).click();
    await expect
      .element(page.getByRole("tabpanel"))
      .toHaveTextContent(`/workspace/b.ts:2:1:${targetKind}`);
    await page.getByRole("button", { name: "Close /workspace/b.ts", exact: true }).click();
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
    await expect.element(page.getByText("Profile content")).toBeVisible();
  },
);

it("keeps the selected file when draft tabs migrate to a work thread", async () => {
  const previous = useRightPanelStore.getState().byThreadKey;
  using _store = {
    [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: previous }),
  };
  useRightPanelStore.setState({ byThreadKey: {} });
  await using screen = await render(<Harness threadId={null} />);
  await page.getByRole("button", { name: "Reopen at line 12", exact: true }).click();
  await page.getByRole("button", { name: "Second file", exact: true }).click();
  await page.getByRole("tab", { name: "a.ts", exact: true }).click();
  // A restored surface can have an id from the previous store key.
  useRightPanelStore.setState((state) => ({
    byThreadKey: Object.fromEntries(
      Object.entries(state.byThreadKey).map(([key, panel]) => [
        key,
        {
          ...panel,
          activeSurfaceId: "file:legacy-a" as const,
          surfaces: panel.surfaces.map((surface) =>
            surface.kind === "file" && surface.relativePath === "/workspace/a.ts"
              ? { ...surface, id: "file:legacy-a" as const }
              : surface,
          ),
        },
      ]),
    ),
  }));
  await screen.rerender(<Harness threadId="work-thread" />);
  await expect.element(page.getByRole("tabpanel")).toHaveTextContent("/workspace/a.ts:12:1:thread");
  await screen.rerender(<Harness threadId="work-thread" />);
  await expect.element(page.getByRole("tabpanel")).toHaveTextContent("/workspace/a.ts:12:1:thread");
});
