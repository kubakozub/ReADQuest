const $ = (sel) => document.querySelector(sel);
const send = (msg) => chrome.runtime.sendMessage(msg);

let state = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ------------------------------------------------------------------ diagnostyka

function renderHealth() {
  const h = state.health;
  const el = $("#tab-health");
  if (!h) { el.innerHTML = `<p class="hint">No data: open "Rules", then reload the extension.</p>`; return; }

  const c = h.counts ?? {};
  const problems = h.problems ?? [];

  el.innerHTML = `
    ${problems.length
      ? problems.map((p) => `<p class="problem">${esc(p)}</p>`).join("")
      : `<p class="good">Every rule confirmed in the engine. None rejected, none orphaned,
         host_permissions complete.</p>`}
    <p class="stats">
      <span>tagging <b>${c.tag ?? 0}</b></span>
      <span>blocked <b>${c.block ?? 0}</b></span>
      <span>exclusions <b>${c.allow ?? 0}</b></span>
      <span>in engine <b>${c.installed ?? 0}</b></span>
    </p>
    <p class="hint">Checked at ${new Date(h.checkedAt).toLocaleTimeString("en-GB")}</p>
    <div class="bar" style="margin-top:10px"><button id="reapply">Recompile and reinstall</button></div>
  `;
  $("#reapply").onclick = async () => { await send({ cmd: "reapply" }); await refresh(); };
}

// ---------------------------------------------------------------------- tester

function renderTests(results) {
  const passed = results.filter((r) => r.pass).length;
  $("#testSummary").innerHTML = passed === results.length
    ? `<span class="good">${passed}/${results.length} OK</span>`
    : `<span style="color:var(--err)">${passed}/${results.length}: ${results.length - passed} niezgodnych</span>`;

  $("#testResults").innerHTML = results.map((r) => `
    <div class="row">
      <span class="tick ${r.pass ? "pass" : "fail"}">${r.pass ? "OK" : "!!"}</span>
      <span class="url">${esc(r.url)}
        <span class="note">${esc(r.note ?? "")}${r.error ? `: ERROR: ${esc(r.error)}` : ""}</span>
        ${r.matched?.length ? `<span class="note">matched: ${r.matched.map((m) => esc(m.label)).join(", ")}</span>` : ""}
      </span>
      <span class="tagpill ${r.outcome}">${r.outcome}</span>
      ${r.pass ? "" : `<span class="tagpill">oczek. ${esc(r.expect)}</span>`}
    </div>
  `).join("");
}

// ------------------------------------------------------------------------- log

function renderLog() {
  const rows = state.log ?? [];
  if (!rows.length) {
    $("#logRows").innerHTML = `<p class="hint">Nothing has matched a rule yet. Visit an in-scope host and refresh.</p>`;
    return;
  }
  $("#logRows").innerHTML = rows.map((e) => {
    const m = state.meta[e.ruleId] ?? { kind: "none", label: `rule ${e.ruleId}` };
    return `<div class="row">
      <span class="t">${new Date(e.t).toLocaleTimeString("pl-PL")}</span>
      <span class="tagpill ${m.kind === "allow" ? "none" : m.kind}">${esc(m.kind)}</span>
      <span class="url">${esc(e.url)}<span class="note">${esc(e.method)} ${esc(e.type)}: ${esc(m.label)}</span></span>
    </div>`;
  }).join("");
}

// ------------------------------------------------------------------------ rules

function renderRules() {
  $("#rulesJson").textContent = JSON.stringify(state.rules ?? [], null, 2);
}

// ------------------------------------------------------------------------ wiring

function showFatal(message) {
  const badge = $("#badge");
  badge.textContent = "ERROR";
  badge.className = "badge err";
  $("#tab-health").innerHTML =
    `<p class="problem">The background did not answer: ${esc(message)}. Reload the extension in chrome://extensions.</p>`;
}

async function refresh() {
  let next;
  try {
    next = await send({ cmd: "state" });
  } catch (e) {
    next = { error: String(e.message ?? e) };
  }
  // A popup that silently hangs would be exactly the silent failure this tool
  // exists to catch: the absence of an answer has to be visible.
  if (!next || next.error) return showFatal(next?.error ?? "brak odpowiedzi");

  state = next;
  const h = state.health;
  const badge = $("#badge");
  badge.textContent = !h ? "?" : !h.ok ? "ERROR" : h.blockProduction ? "BLOCK" : "ACTIVE";
  badge.className = "badge " + (!h ? "" : !h.ok ? "err" : h.blockProduction ? "blk" : "ok");

  $("#tagging").checked = state.toggles.tagging;
  $("#blockProduction").checked = state.toggles.blockProduction;
  $("#uaHint").textContent = "User-Agent sent: " + state.headerValue;

  renderHealth();
  renderLog();
  renderRules();
}

for (const id of ["tagging", "blockProduction"]) {
  $("#" + id).addEventListener("change", async (e) => {
    await send({ cmd: "setToggle", key: id, value: e.target.checked });
    await refresh();
  });
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
  };
});

$("#runTests").onclick = async () => {
  $("#testSummary").textContent = "…";
  let res;
  try {
    res = await send({ cmd: "verify" });
  } catch (e) {
    res = { error: String(e.message ?? e) };
  }
  if (!res || res.error || !res.results) {
    $("#testSummary").innerHTML = `<span style="color:var(--err)">error: ${esc(res?.error ?? "no answer")}</span>`;
    return;
  }
  renderTests(res.results);
};

$("#clearLog").onclick = async () => { await send({ cmd: "clearLog" }); await refresh(); };

$("#copyRules").onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.rules ?? [], null, 2));
  $("#copyState").textContent = "skopiowane";
  setTimeout(() => ($("#copyState").textContent = ""), 1500);
};

refresh();
setInterval(() => { if (document.querySelector("#tab-log").classList.contains("on")) refresh(); }, 2000);
