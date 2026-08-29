import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { CompanyEmailContent, EmailSample } from "@recruiter/shared";
import { validateGeneratedEmail } from "../src/personalization.js";

const databasePath = resolve(process.argv[2] ?? "apps/api/data/recruiter-reachout.sqlite");
const database = new DatabaseSync(databasePath, { readOnly: true });

try {
  const samples = (database.prepare("select data from email_samples order by created_at").all() as Array<{ data: string }>).map(
    (row) => JSON.parse(row.data) as EmailSample,
  );
  const drafts = (
    database.prepare("select data from company_content order by created_at desc").all() as Array<{ data: string }>
  ).map((row) => JSON.parse(row.data) as CompanyEmailContent);

  const results = drafts.map((draft) => {
    const issues = validateGeneratedEmail(draft, samples, draft.generationContext);
    return {
      company: draft.companyDisplayName || draft.company,
      subject: draft.subject,
      issueCount: issues.length,
      issues,
    };
  });

  const issueCounts = new Map<string, number>();
  for (const result of results) {
    for (const issue of result.issues) {
      issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
    }
  }

  console.log(
    JSON.stringify(
      {
        databasePath,
        draftsAudited: results.length,
        draftsPassing: results.filter((result) => result.issueCount === 0).length,
        draftsNeedingRepair: results.filter((result) => result.issueCount > 0).length,
        recurringIssues: [...issueCounts.entries()]
          .map(([issue, count]) => ({ count, issue }))
          .sort((left, right) => right.count - left.count),
        drafts: results,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
