import "../src/loadEnv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJobPostingHtml, htmlToPlainText } from "../src/jobPosting.js";

const url =
  "https://www.paycomonline.net/v4/ats/web.php/portal/F96D35AF09F8603CFE20EE86A84DE50D/jobs/520488";
const out = resolve("data/paycom-debug");
mkdirSync(out, { recursive: true });

const { html, contentType } = await fetchJobPostingHtml(url);
writeFileSync(resolve(out, "page.html"), html);
const text = htmlToPlainText(html);
writeFileSync(resolve(out, "plain.txt"), text);

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => (m[1] ?? "").trim())
  .filter((s) => s.length > 40);

const hints = {
  contentType,
  htmlLen: html.length,
  textLen: text.length,
  textPreview: text.slice(0, 1200),
  title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim(),
  hasNextData: html.includes("__NEXT_DATA__"),
  hasJsonLd: /application\/ld\+json/i.test(html),
  scriptSrcs: [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 40),
  inlineScriptLens: inlineScripts.map((s) => s.length),
  inlineSnippets: inlineScripts.slice(0, 5).map((s) => s.slice(0, 500)),
  jobIdMentions: [...html.matchAll(/520488/g)].length,
  clientKeyMentions: [...html.matchAll(/F96D35AF09F8603CFE20EE86A84DE50D/gi)].length,
  apiPaths: [...html.matchAll(/\/v4\/ats\/[^"'\\\s]+/g)].map((m) => m[0]).slice(0, 50),
};

writeFileSync(resolve(out, "hints.json"), JSON.stringify(hints, null, 2));
console.log(JSON.stringify(hints, null, 2));
