/* Anytype Marks — popup d'ajout rapide. */
"use strict";

const $ = (id) => document.getElementById(id);
let activeTab = null;
let challengeId = null;
let tagsInput = null;

async function init() {
  ABS.util.localizeDocument();
  const settings = await applyTheme();

  activeTab = await rpc("captureActiveTab").catch(() => null);

  const authed = await rpc("anytypeAuthenticated").catch(() => false);
  if (!authed) {
    $("connectPanel").hidden = false;
    const reachable = await rpc("anytypeReachable").catch(() => false);
    if (!reachable) {
      $("connectError").textContent = _("anytypeUnreachable");
      $("connectError").hidden = false;
    }
  }
  // Le formulaire reste utilisable même hors connexion (file d'attente).
  $("addForm").hidden = false;

  if (activeTab) {
    $("title").value = activeTab.title || "";
    $("url").value = activeTab.url || "";
  }

  tagsInput = createTagInput($("tags"), { placeholder: _("tagsPlaceholder") });

  // Règles de tags automatiques : appliquées immédiatement quand le
  // dossier (ou le titre/l'URL) change. Les tags auto précédents qui ne
  // correspondent plus sont retirés, sauf s'ils ont été saisis à la main.
  let autoTags = new Set();
  const ruleSettingsPromise = rpc("getSettings").catch(() => null);
  async function updateRuleTags() {
    const s = await ruleSettingsPromise;
    if (!s || !(s.tagRules || []).length) return;
    const opt = $("folder").selectedOptions[0];
    const computed = ABS.util.applyTagRules(s.tagRules, {
      folderPath: opt ? opt.title : "",
      title: $("title").value,
      url: $("url").value,
    });
    const norm = ABS.util.normalize;
    const computedSet = new Set(computed.map(norm));
    const current = tagsInput.get();
    const next = current.filter((t) => !autoTags.has(norm(t)) || computedSet.has(norm(t)));
    const have = new Set(next.map(norm));
    for (const t of computed) if (!have.has(norm(t))) next.push(t);
    autoTags = computedSet;
    tagsInput.set(next);
  }
  $("folder").addEventListener("change", updateRuleTags);
  $("title").addEventListener("input", ABS.util.debounce(updateRuleTags, 300));
  $("url").addEventListener("input", ABS.util.debounce(updateRuleTags, 300));

  await fillFolders();
  await updateRuleTags(); // règles évaluées avec le dossier par défaut, dès l'ouverture
  applySaveModeDefault(settings);
  checkReaderMode();
  refreshStatus();

  $("connectBtn").addEventListener("click", startConnect);
  $("spaceConfirm").addEventListener("click", async () => {
    const sel = $("spaceSelect");
    if (!sel.value) return;
    await rpc("setSettings", {
      patch: { spaceId: sel.value, spaceName: sel.selectedOptions[0].textContent },
    });
    $("connectPanel").hidden = true;
    toast(_("spaceChosen") + " · " + sel.selectedOptions[0].textContent);
    refreshStatus();
  });
  $("codeSubmit").addEventListener("click", solveConnect);
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); solveConnect(); } });
  $("addForm").addEventListener("submit", submitAdd);
  $("openManagerBtn").addEventListener("click", () => { rpc("openManager"); window.close(); });
  $("syncNowBtn").addEventListener("click", async () => {
    $("syncNowBtn").disabled = true;
    await rpc("syncNow").catch(() => {});
    $("syncNowBtn").disabled = false;
    refreshStatus();
  });
}

function applySaveModeDefault(settings) {
  const mode = settings ? settings.saveMode : "ask";
  if (mode === "ask") return; // l'utilisateur choisit à chaque ajout
  $("saveModeField").hidden = true;
  document.querySelector(`input[name="saveFull"][value="${mode === "full" ? "yes" : "no"}"]`).checked = true;
}

/** Grise l'option « Sauvegarde complète » si la page active n'est pas
 *  compatible avec le mode Lecture (rien d'exploitable à extraire). */
async function checkReaderMode() {
  if (!activeTab || $("saveModeField").hidden) return;
  const ok = await rpc("checkReaderable", { tabId: activeTab.tabId }).catch(() => false);
  if (ok) return;
  const yes = document.querySelector('input[name="saveFull"][value="yes"]');
  const no = document.querySelector('input[name="saveFull"][value="no"]');
  yes.disabled = true;
  no.checked = true;
  yes.closest(".seg-opt").classList.add("disabled");
  $("saveModeField").querySelector("label").textContent =
    _("fieldFullSave") + " — " + _("noReaderMode");
}

async function fillFolders() {
  const folders = await rpc("listFolders").catch(() => []);
  fillFolderSelect($("folder"), folders);
}

async function ensureLocalhostPermission() {
  const origins = ["http://localhost/*", "http://127.0.0.1/*"];
  if (await browser.permissions.contains({ origins })) return true;
  return await browser.permissions.request({ origins });
}

async function startConnect() {
  $("connectError").hidden = true;
  $("connectBtn").disabled = true;
  try {
    if (!(await ensureLocalhostPermission())) {
      $("connectError").textContent = _("permissionDenied");
      $("connectError").hidden = false;
      return;
    }
    challengeId = await rpc("connectStart");
    $("codeStep").hidden = false;
    $("codeInput").focus();
  } catch {
    $("connectError").textContent = _("anytypeUnreachable");
    $("connectError").hidden = false;
  } finally {
    $("connectBtn").disabled = false;
  }
}

async function solveConnect() {
  const code = $("codeInput").value.trim();
  if (code.length !== 4 || !challengeId) return;
  try {
    await rpc("connectSolve", { challengeId, code });
    $("codeStep").hidden = true;
    toast(_("connected"));
    // Étape suivante : choisir l'Espace Anytype où créer les favoris.
    const spaces = await rpc("listSpaces").catch(() => []);
    const sel = $("spaceSelect");
    sel.replaceChildren();
    for (const sp of spaces) {
      const o = document.createElement("option");
      o.value = sp.id;
      o.textContent = sp.name;
      sel.appendChild(o);
    }
    const settings = await rpc("getSettings");
    if (settings.spaceId) sel.value = settings.spaceId;
    $("spaceStep").hidden = false;
    refreshStatus();
  } catch {
    $("connectError").textContent = _("badCode");
    $("connectError").hidden = false;
  }
}

async function submitAdd(e) {
  e.preventDefault();
  const btn = $("submitBtn");
  btn.disabled = true;
  $("addError").hidden = true;
  try {
    const tags = tagsInput.get();
    const saveFull = document.querySelector('input[name="saveFull"]:checked').value === "yes";
    await rpc("addBookmark", {
      data: {
        title: $("title").value.trim(),
        url: $("url").value.trim(),
        folderId: $("folder").value || undefined,
        tags,
        saveFull,
        tabId: activeTab && activeTab.url === $("url").value.trim() ? activeTab.tabId : undefined,
      },
    });
    toast(_("added"));
    setTimeout(() => window.close(), 500);
  } catch (err) {
    $("addError").textContent = _("addFailed") + " — " + err.message;
    $("addError").hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function refreshStatus() {
  const st = await rpc("getStatus").catch(() => null);
  if (!st) return;
  const ribbon = $("statusRibbon");
  ribbon.className = "ribbon " + (st.conflicts ? "conflict" : st.pending ? "pending" : "synced");
  const parts = [];
  parts.push(st.online ? _("statusOnline") : _("statusOffline"));
  if (st.pending) parts.push(_("statusPending", [String(st.pending)]));
  if (st.conflicts) parts.push(_("statusConflicts", [String(st.conflicts)]));
  $("statusText").textContent = parts.join(" · ");
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "abs:status") refreshStatus();
});

init();
