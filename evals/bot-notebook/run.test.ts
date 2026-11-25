import { describe, expect, it } from "@effect/vitest";

import { passes, placesWritten } from "./grade.ts";

describe("bot-notebook grading", () => {
  it("reads where commands wrote", () => {
    expect([...placesWritten("t3bot role add -- Never run bare t3 update.")]).toEqual(["role"]);
    expect([...placesWritten('t3bot memory add "Project id is x"')]).toEqual(["memory"]);
    expect([...placesWritten("cat > skills/release/SKILL.md <<EOF")]).toEqual(["skill"]);
  });

  it("fails a rule also filed as memory, and a fact pushed into the role", () => {
    expect(passes("role", "t3bot role add Ask first.")).toBe(true);
    expect(passes("role", "t3bot role add Ask first.\nt3bot memory add Ask first.")).toBe(false);
    expect(passes("role", "t3bot memory add Ask first.")).toBe(false);
    expect(passes("memory", "t3bot memory add 4 vCPU")).toBe(true);
    expect(passes("memory", "t3bot role edit -")).toBe(false);
    expect(passes("skill", "write skills/x/SKILL.md\nt3bot memory add see skill x")).toBe(true);
  });
});
