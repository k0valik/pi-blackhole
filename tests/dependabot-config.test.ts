import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dependabotConfig = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf-8",
);

describe("Dependabot grouping", () => {
  it("limits the dev-dependencies group to development dependencies", () => {
    expect(dependabotConfig).toContain(
      '      dev-dependencies:\n        dependency-type: "development"\n        patterns:\n          - "*"',
    );
  });
});
