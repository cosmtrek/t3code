/**
 * Everything this fork adds to the server, merged into one layer so `server.ts` carries a single
 * line for it. See "Inbox seams" in FORK.md.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { routesLayer } from "./http.ts";
import * as InboxRuntime from "./inbox/InboxRuntime.ts";
import { followLinkedThreads } from "./inbox/linkedThreads.ts";

const linkedThreadsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    // From the latest event on: the inbox reads current state on every fetch.
    yield* followLinkedThreads(threads.streamDomainEvents).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The inbox stopped following linked threads.", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layer = Layer.mergeAll(routesLayer, linkedThreadsLayer).pipe(
  Layer.provide(InboxRuntime.layer),
);
