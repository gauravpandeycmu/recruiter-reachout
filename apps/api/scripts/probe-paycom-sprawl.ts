import { writeFileSync } from "node:fs";

const sprawlMeta = (await fetch(
  "https://portal-applicant-tracking.us-cent.paycomonline.net/career-portal/sprawl.json",
).then((r) => r.json())) as { main: { js: string } };
const jsPath = sprawlMeta.main.js.replace(/^\.\//, "");
const jsUrl = `https://portal-applicant-tracking.us-cent.paycomonline.net/career-portal/${jsPath}`;
console.log("jsUrl", jsUrl);
const js = await fetch(jsUrl).then((r) => r.text());
writeFileSync("data/paycom-debug/sprawl.js", js);
console.log("js len", js.length);

const pathHits = new Set<string>();
for (const match of js.matchAll(/["'`](\/[a-zA-Z0-9_\-/\{\}:.]{4,120})["'`]/g)) {
  pathHits.add(match[1]!);
}
const urlHits = new Set<string>();
for (const match of js.matchAll(/["'`](https?:\/\/[^"'`]{10,160})["'`]/g)) {
  urlHits.add(match[1]!);
}

const interestingPaths = [...pathHits].filter((value) => /job|api|portal|mantle|career|req|posting/i.test(value));
const interestingUrls = [...urlHits].filter((value) => /paycom|job|api|portal|mantle|career/i.test(value));
console.log("paths", interestingPaths.length);
console.log(interestingPaths.slice(0, 100).join("\n"));
console.log("urls", interestingUrls.length);
console.log(interestingUrls.slice(0, 50).join("\n"));

for (const needle of ["jobDetails", "JobDetail", "getJob", "requisition", "clientkey", "sessionJWT", "mantle"]) {
  const index = js.indexOf(needle);
  console.log(needle, index);
  if (index >= 0) console.log(js.slice(Math.max(0, index - 80), index + 160).replace(/\s+/g, " "));
}
