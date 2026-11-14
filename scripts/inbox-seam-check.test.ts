// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway copies of the seam files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { runSeamCheck } from "./inbox-seam-check.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const CHECKED_FILES = [
  "apps/server/src/server.ts",
  "apps/server/src/orchestration-v2/ThreadMessageIntake.ts",
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "apps/server/src/orchestration-v2/ThreadManagementService.ts",
  "apps/web/src/components/Sidebar.logic.ts",
  "apps/web/src/state/entities.ts",
  "apps/web/src/timestampFormat.ts",
  "apps/server/src/auth/http.ts",
  "packages/contracts/src/orchestrationV2.ts",
  "packages/client-runtime/src/state/deviceHubAccess.ts",
  "packages/client-runtime/src/state/session.ts",
  "apps/web/src/components/settings/SettingsScopeContext.tsx",
  "apps/web/src/components/settings/settingsSearch.ts",
  "apps/web/src/components/settings/SettingsSidebarNav.tsx",
  "apps/web/src/components/settings/SettingsScopeSentence.tsx",
  "apps/web/src/components/sidebar/SidebarChrome.tsx",
  "apps/web/src/routeTree.gen.ts",
  "apps/web/src/routes/_chat.inbox.tsx",
  "apps/web/src/routes/_chat.settings.channels.tsx",
  "package.json",
];

/** A copy of just the files the check reads, with `change` applied. */
function fixture(change: (root: string) => void = () => undefined): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seams-"));
  for (const file of CHECKED_FILES) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(repoRoot, file), NodePath.join(root, file));
  }
  change(root);
  return root;
}

const edit = (root: string, file: string, update: (text: string) => string) => {
  const target = NodePath.join(root, file);
  NodeFS.writeFileSync(target, update(NodeFS.readFileSync(target, "utf8")));
};

const failures = (root: string, args: ReadonlyArray<string> = []) => {
  const lines: string[] = [];
  const count = runSeamCheck(root, args, (line) => lines.push(line));
  return { count, output: lines.join("\n") };
};

const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";

describe("inbox seam check", () => {
  it("passes on an intact copy", () => {
    expect(failures(fixture())).toMatchObject({ count: 0 });
  });

  it.each([
    [
      "a missing thin route file",
      (root: string) => NodeFS.rmSync(NodePath.join(root, "apps/web/src/routes/_chat.inbox.tsx")),
      "The /inbox route file renders the inbox",
    ],
    [
      "a route tree without the inbox node",
      (root: string) =>
        edit(root, ROUTE_TREE, (text) =>
          text.replace(/fullPath: '\/inbox'\s*preLoaderRoute: typeof ChatInboxRouteImport/, ""),
        ),
      "routeTree.gen.ts has the /inbox route",
    ],
    [
      "an upstream route on /settings/channels",
      (root: string) =>
        edit(
          root,
          ROUTE_TREE,
          (text) =>
            `${text}\n    '/_chat/settings/channels-upstream': {\n      fullPath: '/settings/channels'\n      preLoaderRoute: typeof UpstreamChannelsRouteImport\n    }\n`,
        ),
      "Only the fork's route serves /settings/channels",
    ],
    [
      "a device-only path in single quotes",
      (root: string) =>
        edit(root, "apps/web/src/components/settings/SettingsScopeSentence.tsx", (text) =>
          text.replace(
            "SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([",
            "$&\n  '/settings/channels',",
          ),
        ),
      "/settings/channels is not device-only upstream",
    ],
    [
      "a domain event stream that replays history",
      (root: string) =>
        edit(root, "apps/server/src/orchestration-v2/Orchestrator.ts", (text) =>
          text.replace(/streamDomainEvents: Stream\.unwrap\([\s\S]*?latestSequence\(\)/, (match) =>
            match.replace("latestSequence()", "earliestSequence()"),
          ),
        ),
      "ThreadManagementService.streamDomainEvents starts at the latest event",
    ],
    [
      "a dropped package script",
      (root: string) =>
        edit(root, "package.json", (text) => text.replace('"fork:inbox-seam-check"', '"other"')),
      "package.json keeps the fork:inbox-seam-check script",
    ],
  ])("fails on %s", (_name, change, check) => {
    const result = failures(fixture(change));
    expect(result.count).toBeGreaterThan(0);
    expect(result.output).toContain(`FAIL ${check}`);
  });

  it.each([
    [["--since", "HEAD"], "Pass both --since"],
    [["--to", "HEAD"], "Pass both --since"],
    [["--since", "no-such-tag-t3", "--to", "HEAD"], "Unknown git ref: no-such-tag-t3"],
  ])("fails on refs %j", (args, message) => {
    const result = failures(repoRoot, args);
    expect(result.count).toBeGreaterThan(0);
    expect(result.output).toContain(message);
  });
});
