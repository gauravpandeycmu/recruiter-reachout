import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(sourceDirectory, "main.tsx"), "utf8");
const styles = readFileSync(join(sourceDirectory, "styles.css"), "utf8");

describe("Grove analytics layout", () => {
  it("uses a dense, responsive company word cloud", () => {
    expect(mainSource).toContain("function CompanyReachBubbles");
    expect(mainSource).not.toContain('className="bubble-chart"');
    expect(styles).toMatch(/\.company-bubble-cloud\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;/);
    expect(styles).toMatch(/\.company-bubble-cloud\s*\{[\s\S]*?gap:\s*7px 6px;/);
    expect(styles).toMatch(/\.company-reach-bubble\s*\{[\s\S]*?border-radius:\s*999px;/);
    expect(mainSource).not.toContain("company-bubble-rank");
  });

  it("keeps Fun Zone stats in one row and stacks analytics cards responsively", () => {
    expect(styles).toMatch(/\.fun-stats\s*\{[\s\S]*?grid-template-columns:\s*repeat\(10,[\s\S]*?overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.analytics-grid\s*\{[\s\S]*?align-items:\s*stretch;/);
    expect(styles).toMatch(/@media \(max-width: 960px\)[\s\S]*?\.analytics-grid\s*\{\s*grid-template-columns:\s*1fr;/);
  });

  it("shows cumulative sent emails as a minimal graph", () => {
    expect(mainSource).toContain("function CumulativeEmailsChart");
    expect(mainSource).toContain("Cumulative emails sent");
    expect(mainSource).toContain('aria-label="Cumulative emails sent by day"');
    expect(mainSource).toContain('className="svg-endpoint"');
    expect(mainSource).not.toContain("Cumulative companies");
  });
});
