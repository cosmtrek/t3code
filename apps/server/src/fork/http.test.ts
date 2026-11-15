import { describe, expect, it } from "@effect/vitest";

import { attachmentDisposition, okRevalidated } from "./http.ts";

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
