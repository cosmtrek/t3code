import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("keeps development, production, and variant state separate", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();
      const variant = DesktopEnvironment.decodePackagedVariant(
        JSON.stringify({
          name: "t3code",
          t3codeVariant: {
            appId: "dev.example.t3code",
            productName: "Fork",
            dataSlug: "r",
            releaseBaseUrl: "https://github.com/fork/t3code/releases/download",
          },
        }),
      );
      const packagedVariant = yield* makeEnvironment({ isPackaged: true, variant });
      const unpackagedVariant = yield* makeEnvironment({ variant });

      assert.equal(development.stateDir, "/Users/alice/.t3/dev");
      assert.equal(production.stateDir, "/Users/alice/.t3/userdata");
      assert.equal(packagedVariant.stateDir, "/Users/alice/.t3-r/userdata");
      assert.equal(packagedVariant.displayName, "Fork (Beta)");
      assert.equal(packagedVariant.appUserModelId, "dev.example.t3code");
      assert.deepStrictEqual(
        packagedVariant.releaseBaseUrl,
        Option.some("https://github.com/fork/t3code/releases/download"),
      );
      assert.equal(unpackagedVariant.stateDir, "/Users/alice/.t3/userdata");
      assert.isTrue(Option.isNone(production.releaseBaseUrl));
      assert.isTrue(Option.isNone(DesktopEnvironment.decodePackagedVariant('{"name":"t3code"}')));
    }),
  );
});
