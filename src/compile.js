// Kompilator: scope.config.json -> reguły declarativeNetRequest.
// Czysta funkcja, bez dostępu do chrome.*: żeby dało się ją testować i czytać.

export const PRIORITY = { block: 300, allow: 200, tag: 10 };

// Blok produkcji jest domyślnie WŁĄCZONY (CLAUDE.md §8). Jedyne źródło tej
// wartości: importują ją i service worker, i symulator offline, żeby test
// nigdy nie sprawdzał konfiguracji innej niż ta, w której produkt startuje.
export const DEFAULT_TOGGLES = { tagging: true, blockProduction: true };

const ID_BASE = { tag: 1000, allow: 5000, block: 9000 };

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Jedna reguła = jeden host. Atrybucja trafienia w logu i w testerze jest
// warta więcej niż oszczędność na liczbie reguł (limit to 5000).
export function hostCondition(host, mode) {
  const h = esc(host);
  switch (mode) {
    case "exact":
      return { regexFilter: `^https?://${h}(:\\d+)?/` };
    case "subdomains":
      return { regexFilter: `^https?://([^/:?#@]+\\.)+${h}(:\\d+)?/` };
    case "domainAndSubdomains":
      // requestDomains dopasowuje host i jego subdomeny bez kompilacji regexa,
      // więc limit 2 KB na regexFilter tu nie obowiązuje.
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

  // 1. Twarde wykluczenia. Wyżej niż tagowanie, niżej niż blok produkcji.
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

  // 3. Blok produkcji. Wygrywa ze wszystkim.
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
          label: `BLOK ${host} (+subdomeny)`,
        };
      }
    }
  }

  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) warnings.push(`zduplikowane id reguły: ${r.id}`);
    seen.add(r.id);
  }

  return { rules, meta, warnings };
}

// Lista originów, jakie muszą być w manifest.host_permissions, żeby
// modifyHeaders w ogóle miało prawo zadziałać.
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
