import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(sourceDirectory, "main.tsx"), "utf8");
const styles = readFileSync(join(sourceDirectory, "styles.css"), "utf8");

describe("History workspace", () => {
  it("separates the contact directory from the sending queue", () => {
    expect(mainSource).toContain('type HistoryView = "companies" | "queue"');
    expect(mainSource).toContain('role="tablist" aria-label="History view"');
    expect(mainSource).toContain("Companies and people");
    expect(mainSource).toContain("Sending queue");
  });

  it("keeps collapsed cards focused on the company and contact count", () => {
    expect(mainSource).toContain('? "contact" : "contacts"');
    expect(mainSource).not.toContain("history-company-metrics");
    expect(mainSource).not.toContain("formatActivityAt(company.lastActivityAt)");
  });

  it("uses a compact responsive grid with resilient company branding", () => {
    expect(styles).toMatch(/\.history-company-list\.columns-3\s*\{\s*grid-template-columns:\s*repeat\(3,/);
    expect(styles).toMatch(/\.history-company-list\.columns-4\s*\{\s*grid-template-columns:\s*repeat\(4,/);
    expect(styles).toMatch(/@media \(max-width: 680px\)[\s\S]*?\.history-company-list\.columns-3,[\s\S]*?grid-template-columns:\s*1fr;/);
    expect(mainSource).toContain("function CompanyLogo");
    expect(mainSource).toContain("companyLogoDomain(company)");
    expect(mainSource).toContain("https://icon.horse/icon/");
    expect(mainSource).toContain("onError={() => setSourceIndex((current) => current + 1)}");
    expect(mainSource).toContain("applyLogoBrandColor(event.currentTarget)");
    expect(mainSource).not.toContain("POPULAR_COMPANY_DOMAINS");
    expect(mainSource).not.toContain("COMPANY_BRAND_COLORS");
    expect(mainSource).not.toContain("PREFERRED_BRAND_ICON_SLUGS");
    expect(mainSource).toContain('const [historyColumns, setHistoryColumns] = useState<3 | 4>(4)');
    expect(mainSource).toContain("const pageSize = columns * columns");
    expect(styles).toMatch(/\.history-company-details\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
    expect(styles).toMatch(/\.columns-3 \.history-company-details \.history-people-grid\s*\{\s*grid-template-columns:\s*repeat\(3,/);
    expect(styles).toMatch(/\.columns-4 \.history-company-details \.history-people-grid\s*\{\s*grid-template-columns:\s*repeat\(4,/);
    expect(mainSource).toContain("closingHistoryCompanies");
    expect(mainSource).toContain("function HistoryCompanyDetails");
    expect(mainSource).not.toContain("settlingHistoryCompanies");
    expect(styles).toContain('html[data-theme="dark"] .history-company-card');
    expect(mainSource).not.toContain("startViewTransition");
  });

  it("keeps row expansion stable and restrained", () => {
    expect(styles).toContain(".history-company-list");
    expect(styles).not.toContain("grid-column: 1 / -1;\n  border-color: color-mix(in srgb, var(--accent) 30%, var(--line));");
    expect(styles).not.toContain("history-person-pop");
    expect(mainSource).not.toContain("scrollIntoView({ behavior: \"smooth\"");
  });

  it("uses actionable backlog totals for the Queue badge", () => {
    expect(mainSource).toContain("const historyQueueTotal = useMemo(");
    expect(mainSource).toContain("Queue <span>{historyQueueTotal}</span>");
    expect(mainSource).not.toContain("Queue <span>{state?.sendQueue.length ?? 0}</span>");
  });
});
