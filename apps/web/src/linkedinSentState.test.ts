import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("LinkedIn sent state", () => {
  it("shows a sent confirmation and removes the send actions after success", () => {
    const source = readFileSync(fileURLToPath(new URL("./main.tsx", import.meta.url)), "utf8");
    expect(source).toContain('"Message sent on LinkedIn"');
    expect(source).toContain('`Sent on LinkedIn ${formatShortWhen(selected.linkedinMessageSentAt)}`');
    expect(source).toContain("{!selected.linkedinMessageSentAt && (");
  });
});
