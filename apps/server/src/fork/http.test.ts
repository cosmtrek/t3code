import { describe, expect, it } from "@effect/vitest";

import { okRevalidated } from "./http.ts";

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
