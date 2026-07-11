import { randomUUID } from "node:crypto";
import type { CompanyEmailPattern, SuppressionEntry } from "@recruiter/shared";

export function createSuppression(input: Pick<SuppressionEntry, "email" | "domain" | "reason">): SuppressionEntry {
  return {
    id: randomUUID(),
    email: input.email?.toLowerCase(),
    domain: input.domain?.toLowerCase(),
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
}

/** Hard bounces downgrade the domain's known pattern confidence; three bounces block it outright. */
export function learnFromBounce(pattern: CompanyEmailPattern): CompanyEmailPattern {
  const bounceCount = pattern.bounceCount + 1;
  return {
    ...pattern,
    bounceCount,
    confidence: bounceCount >= 3 ? "blocked" : bounceCount >= 2 ? "low" : pattern.confidence,
    lastVerifiedAt: new Date().toISOString(),
  };
}
