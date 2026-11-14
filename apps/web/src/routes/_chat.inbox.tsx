import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../fork/inbox/InboxPage";

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxPage,
});
