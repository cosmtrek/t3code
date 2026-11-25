// @effect-diagnostics-next-line extendsNativeError:off -- thrown from plain fetch code and caught by React views, never in an Effect channel.
export class ForkApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** The fork routes answer an error as `{ code, message, field? }`. */
export async function forkApiErrorFrom(response: Response): Promise<ForkApiError> {
  try {
    const body = (await response.json()) as { code?: string; message?: string; field?: string };
    return new ForkApiError(
      response.status,
      body.code ?? "unknown",
      body.message ?? `The server answered ${response.status}.`,
      body.field,
    );
  } catch {
    return new ForkApiError(response.status, "unknown", `The server answered ${response.status}.`);
  }
}
