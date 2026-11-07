import { compile, requiredOrigins, DEFAULT_TOGGLES } from "./compile.js";

const LOG_MAX = 500;

// ---------------------------------------------------------------- stan

async function loadConfig() {
  const res = await fetch(chrome.runtime.getURL("scope.config.json"));
  if (!res.ok) throw new Error(`cannot load scope.config.json (${res.status})`);
  return res.json();
}

async function getToggles() {
  const { toggles } = await chrome.storage.local.get("toggles");
  return { ...DEFAULT_TOGGLES, ...(toggles ?? {}) };
}

async function setHealth(health) {
  await chrome.storage.local.set({ health });
  const bad = !health.ok;
  await chrome.action.setBadgeText({ text: bad ? "ERR" : health.blockProduction ? "BLK" : "ON" });
  await chrome.action.setBadgeBackgroundColor({
    color: bad ? "#c0392b" : health.blockProduction ? "#8e44ad" : "#1e8449",
  });
}

async function getHealth() {
  const { health } = await chrome.storage.local.get("health");
  return health ?? null;
}

// -------------------------------------------------------- installing the rules

async function applyRules() {
  const startedAt = Date.now();
  const problems = [];
  try {
    await runApply(startedAt, problems);
  } catch (e) {
    // The badge is set BEFORE writing to storage: if storage itself were the cause
    // of the failure, the signal still reaches the user.
    try {
      await chrome.action.setBadgeText({ text: "ERR" });
      await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    } catch {}
    try {
      await chrome.storage.local.set({
        health: {
          ok: false,
          checkedAt: startedAt,
          problems: [...problems, `applyRules przerwane: ${String(e.message ?? e)}`],
          counts: {},
        },
      });
    } catch {}
  }
}

// The actual installation. Beyond the explicit try blocks there are many chrome.*
// calls here; applyRules catches every rejection and turns it into a visible error
// state. A silent failure is a critical defect (CLAUDE.md section 11, point 5).
async function runApply(startedAt, problems) {
  let config, toggles, meta = {}, rules = [];

  try {
    config = await loadConfig();
    toggles = await getToggles();
  } catch (e) {
    await setHealth({ ok: false, checkedAt: startedAt, problems: [String(e.message ?? e)], counts: {} });
    return;
  }

  const userAgent = config.identity.userAgentOverride || navigator.userAgent;
  const resourceTypes = Object.values(chrome.declarativeNetRequest.ResourceType);

  try {
    ({ rules, meta } = compile(config, { toggles, userAgent, resourceTypes }));
  } catch (e) {
    await setHealth({ ok: false, checkedAt: startedAt, problems: [`kompilacja: ${e.message}`], counts: {} });
    return;
  }

  // Step 0, automated: every generated regex passes through Chrome's own native RE2
  // validator. `memoryLimitExceeded` is exactly the condition that surfaces in other
  // tools as "was skipped ... 2KB memory limit".
  for (const r of rules) {
    const regex = r.condition.regexFilter;
    if (!regex) continue;
    const check = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
      isCaseSensitive: false,
      requireCapturing: false,
    });
    if (!check.isSupported) {
      problems.push(`regex for rule ${r.id} (${meta[r.id]?.label}) rejected: ${check.reason}`);
    }
  }

  // A partial set is never installed. All of it, or none of it.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: problems.length ? [] : rules,
    });
  } catch (e) {
    problems.push(`updateDynamicRules odrzucone: ${String(e.message ?? e)}`);
  }

  // Confirmation from the other side: read back what the engine actually holds.
  // "Active" w UI nie jest dowodem: to jest.
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  const installedIds = new Set(installed.map((r) => r.id));
  const intendedIds = problems.length ? new Set() : new Set(rules.map((r) => r.id));

  for (const r of rules) {
    if (!problems.length && !installedIds.has(r.id)) {
      problems.push(`rule ${r.id} (${meta[r.id]?.label}) was not installed`);
    }
  }
  for (const id of installedIds) {
    if (!intendedIds.has(id)) problems.push(`orphaned rule in the engine: ${id}`);
  }

  // Without a host permission modifyHeaders will not fire, though the rule reads "active".
  const origins = requiredOrigins(config);
  const missingOrigins = [];
  for (const o of origins) {
    const has = await chrome.permissions.contains({ origins: [o] });
    if (!has) missingOrigins.push(o);
  }
  if (missingOrigins.length) {
    problems.push(
      `host_permissions missing for ${missingOrigins.length} origins: the header will NOT be added. Run: node tools/sync-manifest.mjs`
    );
  }

  await chrome.storage.local.set({
    meta,
    compiledRules: rules,
    headerValue: `${userAgent} ${config.identity.marker}`,
    missingOrigins,
  });
  await setHealth({
    ok: problems.length === 0,
    checkedAt: startedAt,
    problems,
    blockProduction: toggles.blockProduction,
    tagging: toggles.tagging,
    counts: {
      tag: rules.filter((r) => r.action.type === "modifyHeaders").length,
      block: rules.filter((r) => r.action.type === "block").length,
      allow: rules.filter((r) => r.action.type === "allow").length,
      installed: installed.length,
    },
  });
}

// ------------------------------------------------------------------ the match log

let buffer = [];
let flushTimer = null;

function record(entry) {
  buffer.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flushLog, 800);
}

async function flushLog() {
  flushTimer = null;
  if (!buffer.length) return;
  const { log = [] } = await chrome.storage.session.get("log");
  const next = [...log, ...buffer].slice(-LOG_MAX);
  buffer = [];
  await chrome.storage.session.set({ log: next });
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    record({
      t: Date.now(),
      ruleId: info.rule.ruleId,
      url: info.request.url,
      method: info.request.method,
      type: info.request.type,
    });
  });
}

// ------------------------------------------------------------------- tester

const CLASS_ORDER = { block: 3, allow: 2, tag: 1 };

async function runVerification() {
  const config = await loadConfig();
  const { meta = {} } = await chrome.storage.local.get("meta");
  const results = [];

  for (const t of config.verification ?? []) {
    let outcome = "none";
    let matched = [];
    let error = null;
    try {
      // testMatchOutcome asks the engine "what would you do", sending no request.
      const res = await chrome.declarativeNetRequest.testMatchOutcome({
        url: t.url,
        type: t.type ?? "main_frame",
        method: t.method ?? "get",
        tabId: -1,
      });
      matched = res.matchedRules.map((m) => ({ id: m.ruleId, ...(meta[m.ruleId] ?? { kind: "?", label: "?" }) }));
      let best = 0;
      for (const m of matched) {
        const rank = CLASS_ORDER[m.kind] ?? 0;
        if (rank > best) {
          best = rank;
          outcome = m.kind === "allow" ? "none" : m.kind;
        }
      }
    } catch (e) {
      error = String(e.message ?? e);
    }
    results.push({ ...t, outcome, matched, error, pass: !error && outcome === t.expect });
  }
  return results;
}

// ------------------------------------------------------------------- wiring

const kick = () => applyRules().catch((e) => console.error("applyRules:", e));

chrome.runtime.onInstalled.addListener(kick);
chrome.runtime.onStartup.addListener(kick);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.cmd) {
        case "state": {
          const [{ log = [] }, toggles, health, local] = await Promise.all([
            chrome.storage.session.get("log"),
            getToggles(),
            getHealth(),
            chrome.storage.local.get(["meta", "compiledRules", "headerValue"]),
          ]);
          sendResponse({
            log: log.slice(-120).reverse(),
            toggles,
            health,
            meta: local.meta ?? {},
            rules: local.compiledRules ?? [],
            headerValue: local.headerValue ?? navigator.userAgent,
          });
          break;
        }
        case "setToggle": {
          const toggles = await getToggles();
          toggles[msg.key] = msg.value;
          await chrome.storage.local.set({ toggles });
          await applyRules();
          sendResponse({ ok: true });
          break;
        }
        case "reapply":
          await applyRules();
          sendResponse({ ok: true });
          break;
        case "verify":
          sendResponse({ results: await runVerification() });
          break;
        case "clearLog":
          buffer = [];
          await chrome.storage.session.set({ log: [] });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ error: `nieznana komenda ${msg.cmd}` });
      }
    } catch (e) {
      // Bez tego odrzucenie gubi sendResponse i popup wisi bez komunikatu.
      sendResponse({ error: String(e.message ?? e) });
    }
  })();
  return true;
});

kick();
