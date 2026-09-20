/** Decide what to put in the extension company field. Profile pages never
 *  reuse the last company you typed — that was filling previous employers. */
export function pickExtensionCompanyPrefill(input: {
  pageMode: "profile" | "search" | "other";
  parsedCompany?: string;
  suggestedCompany?: string;
  stickyCompany?: string;
  userEdited?: boolean;
  userValue?: string;
}): string {
  if (input.userEdited) {
    return (input.userValue ?? "").trim();
  }
  if (input.pageMode === "profile") {
    return input.parsedCompany?.trim() || input.suggestedCompany?.trim() || "";
  }
  const suggested = input.suggestedCompany?.trim() || input.parsedCompany?.trim() || "";
  // A company selected on LinkedIn (or present in the live search query) is
  // current-page evidence and must beat the company saved from an older search.
  return suggested || input.stickyCompany?.trim() || "";
}
