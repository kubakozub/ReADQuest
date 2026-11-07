// Compiler: scope.config.json to declarativeNetRequest rules.
// A pure function with no chrome.* access, so that it can be tested and read.

export const PRIORITY = { block: 300, allow: 200, tag: 10 };

// The production block is ON by default (CLAUDE.md section 8). This is the single
// source of that value: the service worker and the offline simulator both import
// it, so a test never checks a configuration other than the one the product ships in.
export const DEFAULT_TOGGLES = { tagging: true, blockProduction: true };

const ID_BASE = { tag: 1000, allow: 5000, block: 9000 };

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One rule per host. Attributing a match, in the log and in the tester, is
// worth more than economising on the number of rules (the limit is 5000).
export function hostCondition(host, mode) {
  const h = esc(host);
  switch (mode) {
    case "exact":
      return { regexFilter: `^https?://${h}(:\\d+)?/` };
    case "subdomains":
      return { regexFilter: `^https?://([^/:?#@]+\\.)+${h}(:\\d+)?/` };
    case "domainAndSubdomains":
      // requestDomains dopasowuje host i jego subdomeny bez kompilacji regexa,
      // so the 2 KB limit on regexFilter does not apply here.
      return { requestDomains: [host] };
    default:
      throw new Error(`nieznany mode: ${mode} (host ${host})`);
  }
}

export function compile(config, { toggles, userAgent, resourceTypes }) {
  const rules = [];
  const meta = {};
  const warnings = [];

  let tagId = ID_BASE.tag;
  let allowId = ID_BASE.allow;
  let blockId = ID_BASE.block;

  // 1. Hard exclusions. Above tagging, below the production block.
  for (const entry of config.neverTag ?? []) {
    const id = allowId++;
    rules.push({
      id,
      priority: PRIORITY.allow,
      action: { type: "allow" },
      condition: { requestDomains: [entry.host], resourceTypes },
    });
    meta[id] = {
      kind: "allow",
      label: `never-tag ${entry.host} (+subdomeny)`,
      host: entry.host,
      reason: entry.reason ?? "",
    };
  }

  // 2. Oznaczanie ruchu.
  if (toggles.tagging) {
    for (const program of config.programs ?? []) {
      if (program.enabled === false) continue;
      const marker = program.marker ?? config.identity.marker;
      const value = `${userAgent} ${marker}`;

      for (const h of program.hosts) {
        const id = tagId++;
        const condition = { ...hostCondition(h.host, h.mode), resourceTypes };
        if (program.excludedDomains?.length) {
          condition.excludedRequestDomains = program.excludedDomains;
        }
        rules.push({
          id,
          priority: PRIORITY.tag,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "User-Agent", operation: "set", value }],
          },
          condition,
        });
        meta[id] = {
          kind: "tag",
          program: program.id,
          host: h.host,
          mode: h.mode,
          label: `${h.host} [${h.mode}]`,
        };
      }
    }
  }

  // 3. The production block. It wins over everything.
  if (toggles.blockProduction) {
    for (const b of config.blocks ?? []) {
      if (b.enabled === false) continue;
      for (const host of b.hosts) {
        const id = blockId++;
        rules.push({
          id,
          priority: PRIORITY.block,
          action: { type: "block" },
          condition: { requestDomains: [host], resourceTypes },
        });
        meta[id] = {
          kind: "block",
          program: b.id,
          host,
          label: `BLOCK ${host} (and subdomains)`,
        };
      }
    }
  }

  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) warnings.push(`duplicate rule id: ${r.id}`);
    seen.add(r.id);
  }

  return { rules, meta, warnings };
}

// The origins that must appear in manifest.host_permissions for modifyHeaders
// to be permitted to act at all.
export function requiredOrigins(config) {
  const out = new Set();
  for (const program of config.programs ?? []) {
    if (program.enabled === false) continue;
    for (const h of program.hosts) {
      out.add(`*://${h.host}/*`);
      if (h.mode !== "exact") out.add(`*://*.${h.host}/*`);
    }
  }
  return [...out].sort();
}
