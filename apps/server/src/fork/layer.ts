/**
 * Everything this fork adds to the server, merged into one layer so `server.ts` carries a single
 * line for it. See "Inbox seams" in FORK.md.
 */
import * as Layer from "effect/Layer";

import { routesLayer } from "./http.ts";
import * as InboxRuntime from "./inbox/InboxRuntime.ts";

export const layer = routesLayer.pipe(Layer.provide(InboxRuntime.layer));
