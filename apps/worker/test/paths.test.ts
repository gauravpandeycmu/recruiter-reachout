import { describe, expect, it } from "vitest";
import { resolveWorkerDataDir } from "../src/paths.js";

describe("resolveWorkerDataDir", () => {
  it("resolves relative env paths from monorepo root", () => {
    const path = resolveWorkerDataDir("./apps/worker/data/salesql-profile", "apps/worker/data/salesql-profile");
    expect(path).toMatch(/apps\/worker\/data\/salesql-profile$/);
    expect(path).not.toContain("/apps/worker/apps/worker");
  });
});
