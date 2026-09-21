import type { Page } from "playwright";

export interface ScrapedLinkedInProfile {
  fullName: string;
  firstName: string;
  title?: string;
  location?: string;
  linkedinUrl: string;
  profilePhotoUrl?: string;
}

const LINKEDIN_GEO_UNITED_STATES = '["103644278"]';

function buildLinkedInPeopleSearchUrl(input: {
  titleKeyword?: string;
  location?: string;
  page?: number;
}): string {
  const location = (input.location ?? "United States").trim() || "United States";
  const titleKeyword = (input.titleKeyword ?? "recruiter").trim() || "recruiter";
  const linkedinParams = new URLSearchParams({
    keywords: titleKeyword,
    origin: "GLOBAL_SEARCH_HEADER",
  });
  if (/united states|usa|^us$/i.test(location)) {
    linkedinParams.set("geoUrn", LINKEDIN_GEO_UNITED_STATES);
  }
  if (input.page && input.page > 1) {
    linkedinParams.set("page", String(input.page));
  }
  return `https://www.linkedin.com/search/results/people/?${linkedinParams.toString()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PEOPLE_RESULT_SELECTOR =
  "div[role='listitem'] a[href*='/in/'], li.reusable-search__result-container a[href*='/in/']";

export function withLinkedInSearchPage(url: string, pageNumber: number): string {
  const parsed = new URL(url);
  if (pageNumber <= 1) parsed.searchParams.delete("page");
  else parsed.searchParams.set("page", String(pageNumber));
  parsed.hash = "";
  return parsed.toString();
}

function hasCurrentCompanyFilter(url: string): boolean {
  try {
    return new URL(url).searchParams.has("currentCompany");
  } catch {
    return /(?:[?&])currentCompany=/i.test(url);
  }
}

async function waitForPeopleSearchResults(page: Page): Promise<void> {
  await page.waitForSelector(PEOPLE_RESULT_SELECTOR, { timeout: 12_000 }).catch(() => undefined);
}

/**
 * Upgrade the resilient keyword search to LinkedIn's exact current-company
 * facet when its UI is available. Failure is deliberately non-fatal: LinkedIn
 * changes this markup often, while the People + US + recruiter/company URL is
 * still a useful fallback.
 */
export async function tryApplyCurrentCompanyFilter(page: Page, companyName: string): Promise<boolean> {
  try {
    const currentCompany = page.getByRole("button", { name: /^(?:filter by )?current compan(?:y|ies)$/i }).first();
    await currentCompany.waitFor({ state: "visible", timeout: 15000 });
    const trigger = currentCompany;
    await trigger.click();

    const input = page.locator('input[placeholder*="company" i], input[aria-label*="company" i]').last();
    await input.waitFor({ state: "visible", timeout: 3000 });
    await input.fill(companyName);

    // LinkedIn ranks the intended company first. Selecting the first suggestion
    // avoids brittle matching against industry subtitles and localized labels.
    const selected = page.locator('[role="listbox"] button:visible, [role="listbox"] [role="button"]:visible, .basic-typeahead__selectable:visible').first();
    await selected.waitFor({ state: "visible", timeout: 5000 });
    await selected.click();

    const apply = page.getByRole("link", { name: /^(show results|apply)$/i }).first();
    await apply.waitFor({ state: "visible", timeout: 5000 });
    await apply.click();
    await page.waitForURL(/(?:[?&])currentCompany=/i, { timeout: 5000 });
    return /(?:[?&])currentCompany=/i.test(page.url());
  } catch (error) {
    console.warn("LinkedIn company filter failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Browser-side scraper, kept as a string so tsx/esbuild cannot inject `__name`
 * helpers into the Playwright page.evaluate payload.
 *
 * Verified against the 2025 LinkedIn people-search DOM:
 *  - Each result is a `div[role="listitem"]` (one person per card).
 *  - The person's own photo is the FIRST, largest (~48px) <img> in the card;
 *    any 24px images are mutual-connection thumbnails. Image alt is empty,
 *    so we associate by card scope + size, never by alt text.
 *  - The first `a[href*="/in/"]` is the person; later ones are mutual connections.
 *  - Headline and location are the first two `<p>` after the name.
 */
export const SCRAPE_VISIBLE_PEOPLE = `(() => {
  var normalize = function (v) { return String(v || "").replace(/\\s+/g, " ").trim(); };
  var dedupeName = function (value) {
    var n = normalize(value);
    if (!n) return "";
    var exact = n.match(/^(.+?)\\s+\\1$/i);
    if (exact && exact[1] && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(exact[1])) return exact[1];
    var glued = n.match(/^(.+?)\\1$/i);
    if (glued && glued[1] && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(glued[1])) return glued[1];
    var parts = n.split(/\\s+/);
    if (parts.length >= 4 && parts.length % 2 === 0) {
      var half = parts.length / 2;
      var left = parts.slice(0, half).join(" ");
      var right = parts.slice(half).join(" ");
      if (left.toLowerCase() === right.toLowerCase() && /[A-Za-z]{2,}\\s+[A-Za-z]{2,}/.test(left)) return left;
    }
    return n;
  };
  var cleanName = function (text) {
    var n = normalize(text).split(/\\s*[•·|]/)[0];
    n = n.replace(/^View\\s+/i, "").replace(/['\\u2019]s\\s+profile\\b.*$/i, "");
    n = n.replace(/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u{2B00}-\\u{2BFF}\\uFE0F]/gu, "");
    n = normalize(n);
    n = n.replace(/\\s+(?:1st|2nd|3rd)\\b.*$/i, "");
    n = dedupeName(n);
    n = n.replace(/\\s+(?:View|Verified|Connect|Message|Follow|Following)$/i, "").trim();
    return n;
  };
  var firstNameOf = function (fullName) { return fullName.split(/\\s+/)[0] || fullName; };
  var normalizeUrl = function (href) {
    try {
      var url = new URL(href, "https://www.linkedin.com");
      var m = url.pathname.match(/\\/in\\/([^/?#]+)/i);
      if (!m || !m[1]) return undefined;
      var slug = decodeURIComponent(m[1]).replace(/\\/$/, "");
      if (!slug || /^(unavailable|edit|detail)$/i.test(slug) || slug.indexOf(".") !== -1) return undefined;
      return "https://www.linkedin.com/in/" + slug;
    } catch (e) { return undefined; }
  };
  var usablePhoto = function (src) {
    return Boolean(
      src &&
      /^https?:\\/\\//i.test(src) &&
      /profile-displayphoto/i.test(src) &&
      !/ghost|data:image|static\\/img\\/transparent/i.test(src)
    );
  };
  var isGhostImg = function (img) {
    var bits = [img.className || "", (img.parentElement && img.parentElement.className) || "", img.getAttribute("src") || "", img.getAttribute("alt") || ""].join(" ");
    return /ghost_person|ghosts\\/person|ghost-person|\\bghost\\b/i.test(bits);
  };
  var imgSrc = function (img) {
    var delayed = img.getAttribute("data-delayed-url") || "";
    if (isGhostImg(img) && !usablePhoto(delayed)) return "";
    if (usablePhoto(delayed)) return delayed;
    return img.currentSrc || img.src || delayed || "";
  };
  var isLocation = function (t) {
    return /(?:,\\s*(?:United States|USA|Canada|United Kingdom))\\b|,\\s*[A-Z]{2}\\b|\\bArea\\b|\\bGreater\\b|\\bMetropolitan\\b/.test(t);
  };

  // Choose the card container that wraps at least 3 profile links.
  var selectors = ["div[role='listitem']", "li.reusable-search__result-container", ".entity-result", "main li"];
  var cards = [];
  for (var i = 0; i < selectors.length; i++) {
    var els = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
    var withProfile = els.filter(function (e) { return e.querySelector('a[href*="/in/"]'); });
    if (withProfile.length >= 3) { cards = withProfile; break; }
  }

  var byUrl = new Map();
  for (var c = 0; c < cards.length; c++) {
    var card = cards[c];
    var anchors = Array.prototype.slice.call(card.querySelectorAll('a[href*="/in/"]'));
    if (anchors.length === 0) continue;
    var primary = anchors[0];
    var linkedinUrl = normalizeUrl(primary.href);
    if (!linkedinUrl || byUrl.has(linkedinUrl)) continue;

    // Name: shortest clean text among anchors pointing to THIS person.
    var nameCandidates = [];
    for (var a = 0; a < anchors.length; a++) {
      if (normalizeUrl(anchors[a].href) !== linkedinUrl) continue;
      var candidate = cleanName(anchors[a].textContent || "");
      if (candidate && /[A-Za-z]{2,}\\s+[A-Za-z]{1,}/.test(candidate)) nameCandidates.push(candidate);
    }
    nameCandidates.sort(function (x, y) { return x.length - y.length; });
    var fullName = nameCandidates[0] || "";
    if (!fullName || fullName.length < 2 || /linkedin member|linkedin|^recruiter$/i.test(fullName)) continue;

    // Headline + location: the informative <p> elements that are not the name.
    var paras = Array.prototype.slice.call(card.querySelectorAll("p"))
      .map(function (p) { return normalize(p.textContent); })
      .filter(function (t) {
        if (!t || t.length < 2) return false;
        if (t.toLowerCase().indexOf(fullName.toLowerCase()) !== -1) return false;
        if (/^(?:•\\s*)?(?:1st|2nd|3rd)\\b/i.test(t)) return false;
        if (/mutual connection|connections? in common/i.test(t)) return false;
        return true;
      });
    var location = undefined;
    var headline = undefined;
    var currentRole = undefined;
    for (var p = 0; p < paras.length; p++) {
      var text = paras[p];
      if (!location && isLocation(text)) { location = text; continue; }
      var currentMatch = text.match(/^Current:\\s*(.+)$/i);
      if (currentMatch) { if (!currentRole) currentRole = normalize(currentMatch[1]); continue; }
      if (!headline && !isLocation(text)) headline = text;
    }
    if (!headline) headline = currentRole;

    // Photo: only trust an image whose wrapping link points at THIS person's
    // profile (the avatar link and name link always share the href), or whose
    // alt text names them. Never guess by size/position - mutual-connection
    // avatars in the same card are how wrong faces were captured.
    var imgs = Array.prototype.slice.call(card.querySelectorAll("img"));
    var photo = undefined;
    for (var im = 0; im < imgs.length; im++) {
      var img = imgs[im];
      var src = imgSrc(img);
      if (!usablePhoto(src)) continue;
      var wrap = img.closest ? img.closest("a[href*='/in/']") : null;
      var wrapUrl = wrap ? normalizeUrl(wrap.href) : undefined;
      if (wrapUrl === linkedinUrl) { photo = src; break; }
      var alt = normalize(img.alt || "").toLowerCase();
      if (alt && alt.indexOf(fullName.toLowerCase()) !== -1) { photo = src; break; }
    }

    byUrl.set(linkedinUrl, {
      fullName: fullName,
      firstName: firstNameOf(fullName),
      title: headline || undefined,
      location: location || undefined,
      linkedinUrl: linkedinUrl,
      profilePhotoUrl: photo || undefined,
    });
  }

  return Array.from(byUrl.values()).slice(0, 50);
})()`;

/**
 * Scrapes LinkedIn people-search result cards from the current page DOM.
 */
export async function scrapeVisiblePeopleResults(page: Page): Promise<ScrapedLinkedInProfile[]> {
  // People search is ~10 cards, all in the DOM. Scroll the last card into
  // view so lazy avatars load, instead of eight timed wheel ticks.
  const lastCard = page.locator("div[role='listitem'], li.reusable-search__result-container").last();
  await lastCard.scrollIntoViewIfNeeded().catch(() => undefined);
  await delay(400);

  const found = (await page.evaluate(SCRAPE_VISIBLE_PEOPLE)) as ScrapedLinkedInProfile[] | undefined;
  return Array.isArray(found) ? found : [];
}

export async function captureCompanyRecruiters(
  page: Page,
  input: { companyName: string; pages: number; log?: (message: string) => void },
): Promise<ScrapedLinkedInProfile[]> {
  const log = input.log ?? (() => undefined);
  const pages = Math.min(3, Math.max(1, input.pages));
  const byUrl = new Map<string, ScrapedLinkedInProfile>();
  // Apply Current company once. Re-applying it on page 2/3 resets LinkedIn
  // to page 1 of the filtered results, so three "pages" were the same ~10 people.
  let filteredSearchUrl: string | undefined;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    try {
      if (!filteredSearchUrl) {
        const url = buildLinkedInPeopleSearchUrl({ location: "United States" });
        log(`LinkedIn capture page ${pageNumber}/${pages}: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForPeopleSearchResults(page);

        if (/\/login|\/checkpoint|\/authwall/i.test(page.url())) {
          throw new Error("LinkedIn session is not logged in. Open Setup → LinkedIn login, then retry.");
        }

        const exactCompanyFilter = await tryApplyCurrentCompanyFilter(page, input.companyName);
        if (!exactCompanyFilter) {
          throw new Error(`Could not apply LinkedIn's Current company filter for ${input.companyName}. No unfiltered profiles were imported. Please try again once LinkedIn has loaded.`);
        }
        log(`Applied LinkedIn current-company filter for ${input.companyName}.`);
        await waitForPeopleSearchResults(page);
        filteredSearchUrl = page.url();
      } else {
        const nextUrl = withLinkedInSearchPage(filteredSearchUrl, pageNumber);
        log(`LinkedIn capture page ${pageNumber}/${pages}: ${nextUrl}`);
        await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

        if (/\/login|\/checkpoint|\/authwall/i.test(page.url())) {
          throw new Error("LinkedIn session is not logged in. Open Setup → LinkedIn login, then retry.");
        }
        if (!hasCurrentCompanyFilter(page.url())) {
          log(`Current-company filter missing on page ${pageNumber}; re-applying.`);
          const exactCompanyFilter = await tryApplyCurrentCompanyFilter(page, input.companyName);
          if (!exactCompanyFilter) {
            throw new Error(`Could not apply LinkedIn's Current company filter for ${input.companyName}. No unfiltered profiles were imported. Please try again once LinkedIn has loaded.`);
          }
          filteredSearchUrl = page.url();
          if (pageNumber > 1) {
            await page.goto(withLinkedInSearchPage(filteredSearchUrl, pageNumber), {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
          }
        }
        await waitForPeopleSearchResults(page);
      }

      const found = await scrapeVisiblePeopleResults(page);
      log(`Page ${pageNumber}: found ${found.length} profile(s)`);
      for (const profile of found) {
        if (!byUrl.has(profile.linkedinUrl)) {
          byUrl.set(profile.linkedinUrl, profile);
        }
      }
      if (found.length === 0) {
        break;
      }
      if (pageNumber < pages) {
        await delay(700 + Math.floor(Math.random() * 500));
      }
    } catch (error) {
      // A later page failing (LinkedIn checkpoint/rate-limit, a goto timeout)
      // must not discard profiles already scraped from earlier pages. Only
      // surface the error (and save nothing) when NOTHING has been captured
      // yet — e.g. a login wall on page 1 is a real, actionable failure with
      // no partial result to fall back to.
      if (byUrl.size > 0) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          `Page ${pageNumber}/${pages} failed (${message}) — keeping ${byUrl.size} profile(s) captured from earlier pages.`,
        );
        break;
      }
      throw error;
    }
  }

  return [...byUrl.values()];
}
