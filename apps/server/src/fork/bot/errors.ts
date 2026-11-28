import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class BotRejection extends Schema.TaggedError<
  BotRejection,
  { readonly brand: unique symbol }
>()("BotRejection", {
  code: Schema.Literals([
    "bad_request",
    "not_found",
    "scratch_unavailable",
    "work_thread_no_run",
    "unauthorized",
    "tool_error",
    "question_closed",
  ]),
  message: Schema.String,
  field: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class BotOperationError extends Schema.TaggedError<
  BotOperationError,
  { readonly brand: unique symbol }
>()("BotOperationError", {
  stage: Schema.Literals([
    "create-workspace",
    "write-token",
    "save-role",
    "move-memory-to-role",
    "set-runtime-mode",
    "launch-owned-thread",
    "send-to-owned-thread",
    "read-owned-thread",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Bot operation failed during ${this.stage}.`;
  }
}

const causeText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const describeBotError = (error: BotOperationError | BotRejection): string => {
  if (error._tag === "BotRejection") return error.message;
  switch (error.stage) {
    case "launch-owned-thread":
      return `The thread did not start: ${causeText(error.cause)}`;
    case "send-to-owned-thread":
      return `Not sent: ${causeText(error.cause)}`;
    case "read-owned-thread":
      return `Cannot read it: ${causeText(error.cause)}`;
    case "set-runtime-mode":
      return causeText(error.cause);
    default: {
      const cause = PlatformError.isPlatformError(error.cause)
        ? error.cause.reason.cause
        : error.cause;
      return causeText(cause);
    }
  }
};
