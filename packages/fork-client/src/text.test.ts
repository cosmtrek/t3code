import { describe, expect, it } from "vite-plus/test";

import { plainPreview } from "./text.ts";

describe("plainPreview", () => {
  it("drops Markdown marks but keeps underscores inside names", () => {
    expect(plainPreview("### 1. **`plugin_gw` 真实调用**\n> _note_ TRUSTED_CALLERS")).toBe(
      "1. plugin_gw 真实调用\nnote TRUSTED_CALLERS",
    );
    expect(
      plainPreview("结构图：![Bot 结构图](/home/user/a.png) 见 [文档](https://example.com)"),
    ).toBe("结构图：Bot 结构图 见 文档");
  });
});
