// Offline'owa replika dopasowania DNR: sprawdza baterię `verification`
// ze scope.config.json bez uruchamiania Chrome. Nie zastępuje testera
// w popupie (ten pyta prawdziwy silnik), ale łapie błędy w konfiguracji
// zanim rozszerzenie w ogóle zostanie załadowane.
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

// requestDomains: dopasowanie po etykietach — host równy domenie albo jej subdomena.
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
// Stan domyślny runtime'u. Ta sama stała, której używa service worker —
// dzięki temu "100%" mówi coś o konfiguracji, w której produkt faktycznie startuje.

const base = build(DEFAULT_TOGGLES);
console.log(`Stan domyślny runtime: ${JSON.stringify(DEFAULT_TOGGLES)}`);
console.log(`Reguł: ${base.rules.length}  (ostrzeżenia: ${base.warnings.length ? base.warnings.join("; ") : "brak"})\n`);

const baseOutcomes = new Map();
for (const t of config.verification) {
  const { outcome, hits } = outcomeFor(base, t.url);
  baseOutcomes.set(t.url, outcome);
  const pass = outcome === t.expect;
  if (!pass) failed++;
  console.log(`${pass ? "  OK " : "  !! "} ${outcome.padEnd(5)} ${pass ? "" : `(oczek. ${t.expect}) `}${t.url}`);
  if (!pass) console.log(`       trafiło: ${hits.map((h) => h.label).join(", ") || "nic"}`);
}

// ---------------------------------------------------------------- przebieg 2
// Blokada zdjęta. Jedyna dopuszczalna różnica: przypadki `expect: "block"`
// stają się `none`. Cokolwiek innego znaczy, że zdjęcie blokady rusza
// oznaczanie albo wykluczenia, czego robić nie ma prawa.

console.log(`\nPrzebieg kontrolny: blockProduction=false (stan odstępstwa)`);
const off = build({ ...DEFAULT_TOGGLES, blockProduction: false });

for (const t of config.verification) {
  const { outcome } = outcomeFor(off, t.url);
  const wanted = t.expect === "block" ? "none" : baseOutcomes.get(t.url);
  if (outcome !== wanted) {
    failed++;
    console.log(`  !!  ${outcome} (oczek. ${wanted}) ${t.url}`);
  }
}
console.log(`  reguł bez blokady: ${off.rules.length} (o ${base.rules.length - off.rules.length} mniej)`);

// ---------------------------------------------------------------- limit regexa

const longest = base.rules
  .filter((r) => r.condition.regexFilter)
  .sort((a, b) => b.condition.regexFilter.length - a.condition.regexFilter.length)[0];
if (longest) {
  console.log(`\nNajdłuższy regexFilter: ${longest.condition.regexFilter.length} znaków — ${longest.condition.regexFilter}`);
}
console.log(`Reguł z regexem: ${base.rules.filter((r) => r.condition.regexFilter).length} / ${base.rules.length}`);

console.log(failed ? `\nNIEZGODNOŚCI: ${failed}` : `\nWszystkie ${config.verification.length} przypadków zgodnych w obu przebiegach.`);
process.exit(failed ? 1 : 0);
