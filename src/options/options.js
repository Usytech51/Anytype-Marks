/* Anytype Marks — page des paramètres. */
"use strict";

const $ = (id) => document.getElementById(id);
let challengeId = null;

async function init() {
  ABS.util.localizeDocument();
  const s = await applyTheme();
  await refreshConnection();
  await fillSpaces(s);
  const settings = s || (await rpc("getSettings"));
  fillForm(settings);
  await initRules(settings);
  await refreshCache();

  // Sauvegarde immédiate à chaque changement.
  const bind = (id, key, transform = (v) => v) => {
    $(id).addEventListener("change", async () => {
      const el = $(id);
      const value = el.type === "checkbox" ? el.checked : transform(el.value);
      const next = await rpc("setSettings", { patch: { [key]: value } });
      if (key === "theme") document.documentElement.dataset.theme = next.theme;
      toast(_("saved"));
    });
  };
  bind("autoSync", "autoSync");
  bind("syncInterval", "syncIntervalMin", (v) => Math.max(1, parseInt(v, 10) || 5));
  bind("conflictPolicy", "conflictPolicy");
  bind("saveMode", "saveMode");
  bind("saveImages", "saveImages");
  bind("maxCache", "maxCacheMB", (v) => Math.max(10, parseInt(v, 10) || 200));
  bind("autoPrune", "autoPruneCache");
  bind("theme", "theme");
  bind("notifications", "notifications");

  $("space").addEventListener("change", async () => {
    const opt = $("space").selectedOptions[0];
    await rpc("setSettings", { patch: { spaceId: $("space").value, spaceName: opt ? opt.textContent : "" } });
    toast(_("saved"));
  });

  $("connectBtn").addEventListener("click", startConnect);
  $("codeSubmit").addEventListener("click", solveConnect);
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); solveConnect(); } });
  $("disconnectBtn").addEventListener("click", async () => {
    if (!confirm(_("disconnectConfirm"))) return;
    await rpc("disconnect");
    await refreshConnection();
  });

  $("importBtn").addEventListener("click", async () => {
    $("importBtn").disabled = true;
    const n = await rpc("importAll").catch(() => 0);
    $("importResult").textContent = _("importDone", [String(n)]);
    $("importBtn").disabled = false;
  });

  $("grantFetch").addEventListener("click", async () => {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    toast(granted ? _("granted") : _("notGranted"), granted ? "info" : "error");
  });

  $("clearCache").addEventListener("click", async () => {
    if (!confirm(_("clearCacheConfirm"))) return;
    await rpc("clearCache");
    await refreshCache();
    toast(_("cacheCleared"));
  });
}

function fillForm(s) {
  $("autoSync").checked = s.autoSync;
  $("syncInterval").value = s.syncIntervalMin;
  $("conflictPolicy").value = s.conflictPolicy;
  $("saveMode").value = s.saveMode;
  $("saveImages").checked = s.saveImages;
  $("maxCache").value = s.maxCacheMB;
  $("autoPrune").checked = s.autoPruneCache;
  $("theme").value = s.theme;
  $("notifications").checked = s.notifications;
}

async function refreshConnection() {
  const reachable = await rpc("anytypeReachable").catch(() => false);
  const authed = reachable && (await rpc("anytypeAuthenticated").catch(() => false));
  $("connRibbon").className = "ribbon " + (authed ? "synced" : reachable ? "pending" : "conflict");
  $("connText").textContent = authed ? _("connStateOk") : reachable ? _("connStateNoAuth") : _("connStateOffline");
  $("connectBtn").hidden = authed;
  $("disconnectBtn").hidden = !authed;
  $("codeStep").hidden = true;
}

async function fillSpaces(s) {
  const sel = $("space");
  sel.replaceChildren();
  try {
    const spaces = await rpc("listSpaces");
    for (const sp of spaces) {
      const o = document.createElement("option");
      o.value = sp.id;
      o.textContent = sp.name;
      sel.appendChild(o);
    }
    const settings = s || (await rpc("getSettings"));
    if (settings.spaceId) sel.value = settings.spaceId;
  } catch {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = _("offlineSpace");
    sel.appendChild(o);
  }
}

async function ensureLocalhostPermission() {
  const origins = ["http://localhost/*", "http://127.0.0.1/*"];
  if (await browser.permissions.contains({ origins })) return true;
  return await browser.permissions.request({ origins });
}

async function startConnect() {
  $("connError").hidden = true;
  try {
    if (!(await ensureLocalhostPermission())) {
      $("connError").textContent = _("permissionDenied");
      $("connError").hidden = false;
      return;
    }
    challengeId = await rpc("connectStart");
    $("codeStep").hidden = false;
    $("codeInput").focus();
  } catch {
    $("connError").textContent = _("anytypeUnreachable");
    $("connError").hidden = false;
  }
}

async function solveConnect() {
  const code = $("codeInput").value.trim();
  if (code.length !== 4 || !challengeId) return;
  try {
    await rpc("connectSolve", { challengeId, code });
    toast(_("connected"));
    await refreshConnection();
    await fillSpaces();
  } catch {
    $("connError").textContent = _("badCode");
    $("connError").hidden = false;
  }
}

async function refreshCache() {
  const st = await rpc("cacheStats").catch(() => ({ count: 0, bytes: 0 }));
  const mb = (st.bytes / (1024 * 1024)).toFixed(1);
  $("cacheStats").textContent = _("cacheStats", [String(st.count), mb]);
}

/* ================= règles de tags automatiques =================
 * Modèle : { id, name, enabled, match: "all"|"any",
 *            conditions: [{field, op, value}], tags: [] } */

let rules = [];
const saveRules = ABS.util.debounce(async () => {
  await rpc("setSettings", { patch: { tagRules: rules } });
  toast(_("saved"));
}, 600);

const FIELD_OPTS = [["folder", "condFolder"], ["title", "condTitle"], ["url", "condUrl"]];
const OP_OPTS = [
  ["equals", "opEquals"], ["startsWith", "opStartsWith"],
  ["contains", "opContains"], ["notContains", "opNotContains"], ["regex", "opRegex"],
];

function makeSelect(opts, value, onChange) {
  const sel = document.createElement("select");
  for (const [v, key] of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = _(key);
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => { onChange(sel.value); saveRules(); });
  return sel;
}

function renderRules() {
  const host = $("rulesList");
  host.replaceChildren();
  rules.forEach((rule, ri) => {
    const box = document.createElement("div");
    box.className = "rule";

    // en-tête : actif, nom, mode de correspondance
    const head = document.createElement("div");
    head.className = "rule-head";
    const en = document.createElement("input");
    en.type = "checkbox";
    en.checked = rule.enabled !== false;
    en.title = _("ruleEnabled");
    en.addEventListener("change", () => { rule.enabled = en.checked; saveRules(); });
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = _("ruleName");
    name.value = rule.name || "";
    name.addEventListener("input", () => { rule.name = name.value; saveRules(); });
    const match = makeSelect([["all", "matchAll"], ["any", "matchAny"]], rule.match || "all",
      (v) => { rule.match = v; });
    head.append(en, name, match);
    box.appendChild(head);

    // conditions
    for (let ci = 0; ci < rule.conditions.length; ci++) {
      const c = rule.conditions[ci];
      const row = document.createElement("div");
      row.className = "cond";
      row.append(
        makeSelect(FIELD_OPTS, c.field || "folder", (v) => { c.field = v; }),
        makeSelect(OP_OPTS, c.op || "equals", (v) => { c.op = v; })
      );
      const val = document.createElement("input");
      val.type = "text";
      val.placeholder = _("condValuePlaceholder");
      val.value = c.value || "";
      val.addEventListener("input", () => { c.value = val.value; saveRules(); });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-x";
      del.textContent = "✕";
      del.title = _("cancel");
      del.addEventListener("click", () => { rule.conditions.splice(ci, 1); renderRules(); saveRules(); });
      row.append(val, del);
      box.appendChild(row);
    }
    const addCond = document.createElement("button");
    addCond.type = "button";
    addCond.className = "btn btn-ghost";
    addCond.textContent = "＋ " + _("addCondition");
    addCond.addEventListener("click", () => {
      rule.conditions.push({ field: "folder", op: "equals", value: "" });
      renderRules(); saveRules();
    });
    box.appendChild(addCond);

    // tags à ajouter (avec autocomplétion)
    const tagsWrap = document.createElement("div");
    tagsWrap.className = "rule-tags";
    const lbl = document.createElement("label");
    lbl.textContent = _("ruleTags");
    tagsWrap.appendChild(lbl);
    const tagsHost = document.createElement("div");
    tagsWrap.appendChild(tagsHost);
    box.appendChild(tagsWrap);
    // onChange : appelé uniquement quand un tag est réellement ajouté ou
    // retiré (Entrée, virgule, clic sur une suggestion, croix, retour
    // arrière, ou blur). Surtout PAS de get() à chaque frappe : get()
    // valide le texte en cours, ce qui transformait chaque lettre en tag.
    const ti = createTagInput(tagsHost, {
      placeholder: _("tagsPlaceholder"),
      onChange: (t) => { rule.tags = t; saveRules(); },
    });
    ti.set(rule.tags || []);

    // pied : suppression
    const foot = document.createElement("div");
    foot.className = "rule-foot";
    const spacer = document.createElement("span");
    const delRule = document.createElement("button");
    delRule.type = "button";
    delRule.className = "btn btn-danger";
    delRule.textContent = _("deleteRule");
    delRule.addEventListener("click", () => { rules.splice(ri, 1); renderRules(); saveRules(); });
    foot.append(spacer, delRule);
    box.appendChild(foot);

    host.appendChild(box);
  });
}

async function initRules(settings) {
  rules = (settings && settings.tagRules ? settings.tagRules : []).map((r) => ({
    id: r.id || ABS.util.uid(),
    name: r.name || "",
    enabled: r.enabled !== false,
    match: r.match || "all",
    conditions: Array.isArray(r.conditions) ? r.conditions : [],
    tags: Array.isArray(r.tags) ? r.tags : [],
  }));
  renderRules();
  $("rulesHelpBtn").addEventListener("click", () => $("rulesHelpDialog").showModal());
  $("rulesHelpClose").addEventListener("click", () => $("rulesHelpDialog").close());
  $("addRuleBtn").addEventListener("click", () => {
    rules.push({
      id: ABS.util.uid(),
      name: "",
      enabled: true,
      match: "all",
      conditions: [{ field: "folder", op: "equals", value: "" }],
      tags: [],
    });
    renderRules(); saveRules();
  });
}

init();
