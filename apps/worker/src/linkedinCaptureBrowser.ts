/**
 * Capture / profile-enrich only need LinkedIn. Preferring the SalesQL extension
 * Chromium wakes a headed window (blank tab + signup chrome) even when no SalesQL
 * discovery work exists.
 */
export function shouldPreferSalesqlBrowserForLinkedInCapture(): boolean {
  return false;
}
