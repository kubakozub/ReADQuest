// An offline replica of DNR matching: it runs the `verification` battery from
// scope.config.json without starting Chrome. It does not replace the tester in
// the popup, which asks the real engine, but it catches configuration errors
// before the extension is loaded at all.
//
//   node tools/selftest.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile, PRIORITY, DEFAULT_TOGGLES } from "../src/compile.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "scope.config.json"), "utf8"));

const RESOURCE_TYPES = ["main_frame", "sub_frame", "script", "xmlhttprequest", "image", "other"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TEST";

const build = (toggles) => compile(config, { toggles, userAgent: UA, resourceTypes: RESOURCE_TYPES });

// requestDomains matches on labels: the host equals the domain, or is a subdomain of it.
function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

function matchRule(rule, url) {
  const { hostname } = new URL(url);
  const c = rule.condition;
  if (c.excludedRequestDomains?.some((d) => domainMatches(hostname, d))) return false;
  if (c.requestDomains) return c.requestDomains.some((d) => domainMatches(hostname, d));
  if (c.regexFilter) return new RegExp(c.regexFilter, "i").test(url);
  return false;
}

const KIND_PRIORITY = { block: PRIORITY.block, allow: PRIORITY.allow, tag: PRIORITY.tag };

function outcomeFor({ rules, meta }, url) {
  const hits = rules.filter((r) => matchRule(r, url)).map((r) => meta[r.id]);
  if (!hits.length) return { outcome: "none", hits };
  const top = hits.reduce((a, b) => (KIND_PRIORITY[b.kind] > KIND_PRIORITY[a.kind] ? b : a));
  return { outcome: top.kind === "allow" ? "none" : top.kind, hits };
}

let failed = 0;

// ---------------------------------------------------------------- przebieg 1
// The runtime default state, the same constant the service worker uses, so that
// a full pass says something about the configuration the product actually starts in.

const base = build(DEFAULT_TOGGLES);
console.log(`runtime default state: ${JSON.stringify(DEFAULT_TOGGLES)}`);
console.log(`rules: ${base.rules.length}  (warnings: ${base.warnings.length ? base.warnings.join("; ") : "none"})\n`);

const baseOutcomes = new Map();
for (const t of config.verification) {
  const { outcome, hits } = outcomeFor(base, t.url);
  baseOutcomes.set(t.url, outcome);
  const pass = outcome === t.expect;
  if (!pass) failed++;
  console.log(`${pass ? "  OK " : "  !! "} ${outcome.padEnd(5)} ${pass ? "" : `(oczek. ${t.expect}) `}${t.url}`);
  if (!pass) console.log(`       matched: ${hits.map((h) => h.label).join(", ") || "nothing"}`);
}

// ---------------------------------------------------------------- przebieg 2
// The block is lifted. The only permitted difference: cases marked
// `expect: "block"` become `none`. Anything else means that lifting the block
// also moves tagging or exclusions, which it has no business doing.

console.log(`\ncontrol pass: blockProduction=false (the exception state)`);
const off = build({ ...DEFAULT_TOGGLES, blockProduction: false });

for (const t of config.verification) {
  const { outcome } = outcomeFor(off, t.url);
  const wanted = t.expect === "block" ? "none" : baseOutcomes.get(t.url);
  if (outcome !== wanted) {
    failed++;
    console.log(`  !!  ${outcome} (oczek. ${wanted}) ${t.url}`);
  }
}
console.log(`  rules without the block: ${off.rules.length} (${base.rules.length - off.rules.length} fewer)`);

// ---------------------------------------------------------------- limit regexa

const longest = base.rules
  .filter((r) => r.condition.regexFilter)
  .sort((a, b) => b.condition.regexFilter.length - a.condition.regexFilter.length)[0];
if (longest) {
  console.log(`\nlongest regexFilter: ${longest.condition.regexFilter.length} characters, ${longest.condition.regexFilter}`);
}
console.log(`rules using a regex: ${base.rules.filter((r) => r.condition.regexFilter).length} / ${base.rules.length}`);

console.log(failed ? `\nMISMATCHES: ${failed}` : `\nAll ${config.verification.length} cases agree across both passes.`);
process.exit(failed ? 1 : 0);
