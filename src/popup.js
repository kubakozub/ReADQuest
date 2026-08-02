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
  if (!h) { el.innerHTML = `<p class="hint">Brak danych — kliknij „Reguły” → przeładuj rozszerzenie.</p>`; return; }

  const c = h.counts ?? {};
  const problems = h.problems ?? [];

  el.innerHTML = `
    ${problems.length
      ? problems.map((p) => `<p class="problem">${esc(p)}</p>`).join("")
      : `<p class="good">Wszystkie reguły potwierdzone w silniku. Zero odrzuconych, zero osieroconych,
         host_permissions kompletne.</p>`}
    <p class="stats">
      <span>oznaczanie <b>${c.tag ?? 0}</b></span>
      <span>blok <b>${c.block ?? 0}</b></span>
      <span>wykluczenia <b>${c.allow ?? 0}</b></span>
      <span>w silniku <b>${c.installed ?? 0}</b></span>
    </p>
    <p class="hint">Sprawdzone: ${new Date(h.checkedAt).toLocaleTimeString("pl-PL")}</p>
    <div class="bar" style="margin-top:10px"><button id="reapply">Przelicz i zainstaluj ponownie</button></div>
  `;
  $("#reapply").onclick = async () => { await send({ cmd: "reapply" }); await refresh(); };
}

// ---------------------------------------------------------------------- tester

function renderTests(results) {
  const passed = results.filter((r) => r.pass).length;
  $("#testSummary").innerHTML = passed === results.length
    ? `<span class="good">${passed}/${results.length} OK</span>`
    : `<span style="color:var(--err)">${passed}/${results.length} — ${results.length - passed} niezgodnych</span>`;

  $("#testResults").innerHTML = results.map((r) => `
    <div class="row">
      <span class="tick ${r.pass ? "pass" : "fail"}">${r.pass ? "OK" : "!!"}</span>
      <span class="url">${esc(r.url)}
        <span class="note">${esc(r.note ?? "")}${r.error ? ` — BŁĄD: ${esc(r.error)}` : ""}</span>
        ${r.matched?.length ? `<span class="note">trafiło: ${r.matched.map((m) => esc(m.label)).join(", ")}</span>` : ""}
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
    $("#logRows").innerHTML = `<p class="hint">Nic jeszcze nie trafiło w regułę. Wejdź na host w scope i odśwież.</p>`;
    return;
  }
  $("#logRows").innerHTML = rows.map((e) => {
    const m = state.meta[e.ruleId] ?? { kind: "none", label: `reguła ${e.ruleId}` };
    return `<div class="row">
      <span class="t">${new Date(e.t).toLocaleTimeString("pl-PL")}</span>
      <span class="tagpill ${m.kind === "allow" ? "none" : m.kind}">${esc(m.kind)}</span>
      <span class="url">${esc(e.url)}<span class="note">${esc(e.method)} ${esc(e.type)} — ${esc(m.label)}</span></span>
    </div>`;
  }).join("");
}

// ----------------------------------------------------------------------- reguły

function renderRules() {
  $("#rulesJson").textContent = JSON.stringify(state.rules ?? [], null, 2);
}

// ------------------------------------------------------------------------ wiring

function showFatal(message) {
  const badge = $("#badge");
  badge.textContent = "BŁĄD";
  badge.className = "badge err";
  $("#tab-health").innerHTML =
    `<p class="problem">Tło nie odpowiedziało: ${esc(message)}. Przeładuj rozszerzenie w chrome://extensions.</p>`;
}

async function refresh() {
  let next;
  try {
    next = await send({ cmd: "state" });
  } catch (e) {
    next = { error: String(e.message ?? e) };
  }
  // Milczące zawieszenie popupu byłoby dokładnie tą cichą awarią, którą
  // narzędzie ma tępić — brak odpowiedzi musi być widoczny.
  if (!next || next.error) return showFatal(next?.error ?? "brak odpowiedzi");

  state = next;
  const h = state.health;
  const badge = $("#badge");
  badge.textContent = !h ? "?" : !h.ok ? "BŁĄD" : h.blockProduction ? "BLOK" : "AKTYWNE";
  badge.className = "badge " + (!h ? "" : !h.ok ? "err" : h.blockProduction ? "blk" : "ok");

  $("#tagging").checked = state.toggles.tagging;
  $("#blockProduction").checked = state.toggles.blockProduction;
  $("#uaHint").textContent = "Wysyłany User-Agent: " + state.headerValue;

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
    $("#testSummary").innerHTML = `<span style="color:var(--err)">błąd: ${esc(res?.error ?? "brak odpowiedzi")}</span>`;
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
