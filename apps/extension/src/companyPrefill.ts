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
  return input.stickyCompany?.trim() || suggested;
}
