import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render.tsx";
import { forkRequest } from "../forkApiAccess";
import { CreateBotDialog } from "./BotsPage";

vi.mock("../forkApiAccess", () => ({ forkRequest: vi.fn() }));

const environmentId = EnvironmentId.make("test");

it.each([false, true])("creates a bot with a brief supplied: %s", async (withBrief) => {
  vi.mocked(forkRequest).mockReset().mockResolvedValue({ botId: "bot-created" });
  const onCreated = vi.fn();
  await using _screen = await render(
    <CreateBotDialog environmentId={environmentId} onClose={vi.fn()} onCreated={onCreated} />,
  );

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Release Watcher");
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await expect.element(create).toBeEnabled();

  if (withBrief) {
    const brief = dialog.getByRole("textbox", { name: "What should it do?" });
    await brief.fill("Watch for releases.");
    await userEvent.keyboard("{Enter}Ask before merging.");
    await expect.element(brief).toHaveValue("Watch for releases.\nAsk before merging.");
    expect(forkRequest).not.toHaveBeenCalled();
  }

  await create.click();

  expect(forkRequest).toHaveBeenCalledExactlyOnceWith(environmentId, "/bots/create", {
    method: "POST",
    body: {
      name: "Release Watcher",
      modelSelection: null,
      runtimeMode: "auto",
      ...(withBrief ? { brief: "Watch for releases.\nAsk before merging." } : {}),
    },
  });
  expect(onCreated).toHaveBeenCalledExactlyOnceWith("bot-created");
});
