import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { InboxRuntime } from "./inbox/InboxRuntime.ts";
import { BotRuntime } from "./bot/BotRuntime.ts";
import * as Artifacts from "./inbox/artifacts.ts";
import * as BotStore from "./bot/store.ts";
import * as InboxStore from "./inbox/store.ts";

import { attachmentDisposition, okRevalidated, makeRoute } from "./http.ts";

describe("okRevalidated", () => {
  it("answers 304 to the tag it gave, weak or not, and 200 once the value changes", () => {
    const first = okRevalidated({ items: [1] }, undefined);
    const etag = first.headers["etag"]!;
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/".+"$/);
    expect(okRevalidated({ items: [1] }, etag).status).toBe(304);
    expect(okRevalidated({ items: [1] }, `"other", ${etag.slice(2)}`).status).toBe(304);
    expect(okRevalidated({ items: [2] }, etag).status).toBe(200);
  });
});

describe("attachmentDisposition", () => {
  it("keeps a quoted ASCII fallback and the real name in filename*", () => {
    expect(attachmentDisposition("763662624.mp4")).toBe(
      `attachment; filename="763662624.mp4"; filename*=UTF-8''763662624.mp4`,
    );
    expect(attachmentDisposition(`周报 "v2" (it's).pdf`)).toBe(
      `attachment; filename="__ _v2_ (it's).pdf"; filename*=UTF-8''%E5%91%A8%E6%8A%A5%20%22v2%22%20%28it%27s%29.pdf`,
    );
  });
});

// The routes under test never touch the fork runtimes, so empty stand-ins are enough.
const unusedService = <S>() => ({}) as S;

describe("makeRoute", () => {
  it.effect("keeps the legacy defect's HTTP 500 response for a store failure", () =>
    Effect.gen(function* () {
      const store = yield* InboxStore.make(":memory:");
      yield* store.close();
      const botStore = yield* BotStore.make(":memory:");
      yield* botStore.close();
      const route = makeRoute(
        unusedService<InboxRuntime["Service"]>(),
        unusedService<BotRuntime["Service"]>(),
        unusedService<Artifacts.Artifacts["Service"]>(),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        Layer.mergeAll(
          route(
            "GET",
            "/legacy",
            AuthOrchestrationReadScope,
            Effect.sync(() => {
              throw new Error("database is not open");
            }),
          ),
          route("GET", "/store", AuthOrchestrationReadScope, store.listConversationReads("a")),
          route("GET", "/bot-store", AuthOrchestrationReadScope, botStore.listBots()),
        ).pipe(
          Layer.provideMerge(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateWebSocketUpgrade: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationReadScope],
                }),
            }),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
      const read = (path: string) =>
        Effect.promise(async () => {
          const response = await handler(new Request(`http://localhost${path}`));
          return {
            status: response.status,
            headers: [...response.headers],
            body: await response.text(),
          };
        });
      const before = yield* read("/legacy");
      const after = yield* read("/store");
      expect(before.status).toBe(500);
      expect(before.body).toBe("");
      expect(after).toEqual(before);
      expect(yield* read("/bot-store")).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
