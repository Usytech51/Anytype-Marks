/* Anytype Marks — gestionnaire de favoris.
 * Liste virtualisée (fluide au-delà de 20 000 entrées), recherche floue
 * instantanée, filtres combinables, glisser-déposer, menu contextuel,
 * résolution de conflits, visionneuse de pages sauvegardées. */
"use strict";

const $ = (id) => document.getElementById(id);
const ROW_H = 62;

const state = {
  entries: [],
  folders: [],
  visible: [],
  filters: { folderId: null, tag: null, sync: "", query: "" },
  sort: "dateAddedDesc",
  contentMatches: null, // Set d'IDs quand la recherche de contenu est active
  dragEntryId: null,
};

/* ================= chargement ================= */

async function loadData() {
  const [entries, folders] = await Promise.all([rpc("listEntries"), rpc("listFolders")]);
  state.entries = entries;
  state.folders = folders;
  renderSidebar();
  applyFilters();
}

async function init() {
  ABS.util.localizeDocument();
  const settings = await applyTheme();
  if (settings && settings.managerSort) {
    state.sort = settings.managerSort;
    $("sort").value = settings.managerSort;
  }
  await loadData();
  refreshStatus();

  $("search").addEventListener("input", ABS.util.debounce(onSearch, 120));
  $("sort").addEventListener("change", () => {
    state.sort = $("sort").value;
    applyFilters();
    rpc("setSettings", { patch: { managerSort: state.sort } }).catch(() => {}); // choix mémorisé
  });
  $("filterSync").addEventListener("change", () => { state.filters.sync = $("filterSync").value; applyFilters(); });
  $("navAll").addEventListener("click", () => {
    state.filters.folderId = null; state.filters.tag = null;
    renderSidebar(); applyFilters();
  });
  $("newFolderBtn").addEventListener("click", () => openFolderDialog(state.filters.folderId));
  $("folderCancel").addEventListener("click", () => $("folderDialog").close());
  $("folderForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = $("fName").value.trim();
    if (!title) return;
    await rpc("createFolder", { title, parentId: $("fParent").value || undefined })
      .catch((err) => toast(err.message, "error"));
    $("folderDialog").close();
    await loadData();
  });
  $("syncNowBtn").addEventListener("click", async () => {
    $("syncNowBtn").disabled = true;
    await rpc("syncNow").catch(() => {});
    $("syncNowBtn").disabled = false;
    await loadData();
    refreshStatus();
  });
  $("optionsBtn").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("listViewport").addEventListener("scroll", renderList);
  window.addEventListener("resize", renderList);
  document.addEventListener("click", () => hideCtx());
  window.addEventListener("blur", () => hideCtx());
  $("editCancel").addEventListener("click", () => $("editDialog").close());
  $("editForm").addEventListener("submit", saveEdit);
  $("conflictClose").addEventListener("click", () => $("conflictDialog").close());

  // clavier dans la liste
  $("listViewport").addEventListener("keydown", (e) => {
    if (e.key === "Delete" && focusedEntryId) doDelete(focusedEntryId);
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "abs:status") { refreshStatus(); refreshDataSoon(); }
  });
}

const refreshDataSoon = ABS.util.debounce(loadData, 800);

/* ================= recherche & filtres ================= */

async function onSearch() {
  state.filters.query = $("search").value;
  state.contentMatches = null;
  applyFilters();
  // La recherche porte aussi, automatiquement, sur le contenu des pages
  // sauvegardées (dès 3 caractères, fusionnée en arrière-plan).
  if (state.filters.query.trim().length >= 3) {
    // Recherche dans le contenu sauvegardé, en tâche de fond.
    const q = state.filters.query;
    const matches = new Set();
    const fullEntries = state.entries.filter((e) => e.saved === "full");
    for (const e of fullEntries) {
      const page = await rpc("getPage", { entryId: e.id }).catch(() => null);
      if (q !== $("search").value) return; // requête obsolète
      if (page && page.text && ABS.util.fuzzyScore(q, page.text.slice(0, 100000)) > 0) matches.add(e.id);
    }
    state.contentMatches = matches;
    applyFilters();
  }
}

function applyFilters() {
  const f = state.filters;
  const q = f.query.trim();
  let list = state.entries.filter((e) => {
    if (f.folderId && e.folderId !== f.folderId) return false; // contenu direct du dossier uniquement
    if (f.tag && !(e.tags || []).some((t) => ABS.util.normalize(t) === ABS.util.normalize(f.tag))) return false;
    if (f.sync === "synced" && e.syncState !== "synced") return false;
    if (f.sync === "pending" && e.syncState === "synced") return false;
    return true;
  });

  if (q) {
    const scored = [];
    for (const e of list) {
      const s = Math.max(
        ABS.util.fuzzyScore(q, e.title) * 3,
        ABS.util.fuzzyScore(q, e.url) * 2,
        ABS.util.fuzzyScore(q, (e.tags || []).join(" ")) * 2,
        ABS.util.fuzzyScore(q, e.folderPath || "")
      );
      const inContent = state.contentMatches && state.contentMatches.has(e.id);
      if (s > 0 || inContent) scored.push([s + (inContent ? 50 : 0), e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    list = scored.map((x) => x[1]);
  } else {
    const cmp = {
      titleAsc: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      titleDesc: (a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }),
      dateAddedDesc: (a, b) => b.createdAt - a.createdAt,
      dateAddedAsc: (a, b) => a.createdAt - b.createdAt,
      dateModifiedDesc: (a, b) => b.updatedAt - a.updatedAt,
      manual: (a, b) => (a.folderPath || "").localeCompare(b.folderPath || "") || a.order - b.order,
    }[state.sort];
    list.sort(cmp);
  }

  state.visible = list;
  renderActiveFilters();
  renderList(true);
  $("countText").textContent = _("countBookmarks", [String(list.length), String(state.entries.length)]);
}

function folderPathOf(id) {
  const f = state.folders.find((x) => x.id === id);
  return f ? f.path : "";
}

function renderActiveFilters() {
  const host = $("activeFilters");
  host.replaceChildren();
  const chips = [];
  const f = state.filters;
  if (f.folderId) chips.push([`📁 ${folderPathOf(f.folderId)}`, () => { f.folderId = null; }]);
  if (f.tag) chips.push([`# ${f.tag}`, () => { f.tag = null; }]);
  for (const [label, clear] of chips) {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = label + " ✕";
    c.addEventListener("click", () => { clear(); renderSidebar(); applyFilters(); });
    host.appendChild(c);
  }
  host.hidden = chips.length === 0;
}

function openFolderDialog(parentId) {
  $("fName").value = "";
  fillFolderSelect($("fParent"), state.folders, parentId || (state.folders[0] && state.folders[0].id));
  $("folderDialog").showModal();
  $("fName").focus();
}

/* ================= barre latérale ================= */

function renderSidebar() {
  $("navAll").classList.toggle("active", !state.filters.folderId && !state.filters.tag);

  // dossiers
  const counts = new Map();
  for (const e of state.entries) counts.set(e.folderId, (counts.get(e.folderId) || 0) + 1);
  const fl = $("folderList");
  fl.replaceChildren();
  for (const f of state.folders) {
    const li = document.createElement("li");
    li.dataset.folderId = f.id;
    const depth = (f.path.match(/\//g) || []).length;
    li.style.paddingLeft = 10 + depth * 12 + "px";
    li.classList.toggle("active", state.filters.folderId === f.id);
    const ico = document.createElement("span");
    ico.textContent = "📁";
    const fname = document.createElement("span");
    fname.className = "fname";
    fname.textContent = f.title || f.path;
    const cnt = document.createElement("span");
    cnt.className = "item-count";
    cnt.textContent = counts.get(f.id) ? String(counts.get(f.id)) : "";
    li.append(ico, fname, cnt);
    li.title = f.path;
    li.addEventListener("click", () => {
      state.filters.folderId = state.filters.folderId === f.id ? null : f.id;
      renderSidebar(); applyFilters();
    });
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); showFolderCtx(e, f); });
    // cible de dépôt
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drop-target"); });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      li.classList.remove("drop-target");
      if (!state.dragEntryId) return;
      await rpc("updateEntry", { entryId: state.dragEntryId, patch: { folderId: f.id } }).catch((err) => toast(err.message, "error"));
      await loadData();
    });
    fl.appendChild(li);
  }

  // tags
  const tagCounts = new Map();
  for (const e of state.entries)
    for (const t of e.tags || []) {
      const k = t.trim();
      if (k) tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
    }
  const tl = $("tagList");
  tl.replaceChildren();
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    const li = document.createElement("li");
    li.classList.toggle("active", state.filters.tag === tag);
    const hash = document.createElement("span");
    hash.textContent = "#";
    const tname = document.createElement("span");
    tname.className = "tname";
    tname.textContent = tag;
    const cnt = document.createElement("span");
    cnt.className = "item-count";
    cnt.textContent = String(count);
    li.append(hash, tname, cnt);
    li.addEventListener("click", () => {
      state.filters.tag = state.filters.tag === tag ? null : tag;
      renderSidebar(); applyFilters();
    });
    tl.appendChild(li);
  }
}

function showFolderCtx(ev, folder) {
  showCtx(ev.clientX, ev.clientY, [
    [_("renameFolder"), async () => {
      const name = prompt(_("renameFolder"), folder.title);
      if (name && name.trim()) { await rpc("renameFolder", { id: folder.id, title: name.trim() }); await loadData(); }
    }],
    [_("newSubfolder"), () => openFolderDialog(folder.id)],
    null,
    [_("deleteFolder"), async () => {
      if (confirm(_("deleteFolderConfirm", [folder.title]))) {
        await rpc("deleteFolder", { id: folder.id });
        await loadData();
      }
    }, "danger"],
  ]);
}

/* ================= liste virtuelle ================= */

let focusedEntryId = null;

function renderList(reset) {
  const vp = $("listViewport");
  const total = state.visible.length;
  $("listSpacer").style.height = total * ROW_H + "px";
  if (reset === true) vp.scrollTop = Math.min(vp.scrollTop, Math.max(0, total * ROW_H - vp.clientHeight));

  const start = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - 5);
  const end = Math.min(total, Math.ceil((vp.scrollTop + vp.clientHeight) / ROW_H) + 5);
  const win = $("listWindow");
  win.style.transform = `translateY(${start * ROW_H}px)`;
  win.replaceChildren();

  const df = document.createDocumentFragment();
  for (let i = start; i < end; i++) df.appendChild(buildRow(state.visible[i]));
  win.appendChild(df);
}

function buildRow(e) {
  const row = document.createElement("div");
  row.className = "row";
  row.draggable = true;
  row.dataset.id = e.id;

  const date = new Date(e.createdAt || e.updatedAt).toLocaleDateString();
  const syncCls = e.syncState === "conflict" ? "conflict" : e.syncState === "synced" ? "synced" : "pending";
  const syncTitle = _(e.syncState === "conflict" ? "stateConflict" : e.syncState === "synced" ? "stateSynced" : "statePending");

  const ribbon = document.createElement("span");
  ribbon.className = `ribbon ${syncCls}`;
  ribbon.title = syncTitle;
  const fav = document.createElement("img");
  fav.className = "favicon";
  fav.loading = "lazy";
  fav.alt = "";
  const main = document.createElement("div");
  main.className = "main";
  const titleDiv = document.createElement("div");
  titleDiv.className = "title";
  const a = document.createElement("a");
  a.href = e.url;
  main.appendChild(titleDiv);
  titleDiv.appendChild(a);
  const tagsCell = document.createElement("div");
  tagsCell.className = "tags-cell";
  const dateDiv = document.createElement("div");
  dateDiv.className = "date";
  dateDiv.textContent = date;
  row.append(ribbon, fav, main, tagsCell, dateDiv);

  fav.src = ABS.util.faviconFor(e.url);
  fav.addEventListener("error", (ev) => (ev.target.style.visibility = "hidden"));
  a.textContent = e.title || e.url;
  a.title = e.url + (e.folderPath ? `\n📁 ${e.folderPath}` : ""); // URL et dossier en infobulle
  a.addEventListener("click", (ev) => { ev.preventDefault(); openEntry(e, ev.ctrlKey || ev.metaKey); });
  for (const t of (e.tags || []).slice(0, 5)) {
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = t;
    tagsCell.appendChild(s);
  }

  row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showEntryCtx(ev, e); });
  row.addEventListener("dblclick", () => openEntry(e, true));
  row.addEventListener("mousedown", () => (focusedEntryId = e.id));
  if (e.syncState === "conflict") row.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    openConflict(e);
  });

  // drag & drop : réorganisation + dépôt sur dossier
  row.addEventListener("dragstart", (ev) => {
    state.dragEntryId = e.id;
    row.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", e.id);
  });
  row.addEventListener("dragend", () => { row.classList.remove("dragging"); state.dragEntryId = null; });
  row.addEventListener("dragover", (ev) => { ev.preventDefault(); row.classList.add("drop-before"); });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before"));
  row.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    row.classList.remove("drop-before");
    const dragged = state.dragEntryId;
    if (!dragged || dragged === e.id) return;
    // Insertion AVANT `e`. bookmarks.move interprète l'index comme la
    // position finale APRÈS retrait de l'élément : en descendant dans le
    // même dossier, la cible se décale de 1 (sinon le dépôt « en haut » ou
    // adjacent ne bougeait pas).
    const d = state.entries.find((x) => x.id === dragged);
    let index = e.order;
    if (d && d.folderId === e.folderId && d.order < e.order) index = Math.max(0, e.order - 1);
    await rpc("updateEntry", { entryId: dragged, patch: { folderId: e.folderId, order: index } })
      .catch((err) => toast(err.message, "error"));
    await loadData();
  });

  return row;
}

function openEntry(e, newTab) {
  if (newTab) browser.tabs.create({ url: e.url });
  else browser.tabs.update({ url: e.url });
}

/* ================= menu contextuel ================= */

function showCtx(x, y, items) {
  const menu = $("ctxMenu");
  menu.replaceChildren();
  for (const item of items) {
    if (item === null) { menu.appendChild(document.createElement("hr")); continue; }
    const [label, fn, cls] = item;
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); hideCtx(); fn(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}

function hideCtx() { $("ctxMenu").hidden = true; }

function showEntryCtx(ev, e) {
  // Renommer / Changer les tags / Déplacer sont couverts par « Modifier » ;
  // la page sauvegardée se consulte depuis Anytype.
  const items = [
    [_("ctxOpen"), () => openEntry(e, false)],
    [_("ctxOpenNewTab"), () => openEntry(e, true)],
    null,
    [_("ctxEdit"), () => openEdit(e)],
    [_("ctxDuplicate"), async () => { await rpc("duplicateEntry", { entryId: e.id }); await loadData(); }],
    [_("ctxCopyLink"), async () => { await navigator.clipboard.writeText(e.url); toast(_("linkCopied")); }],
  ];
  items.push(
    null,
    [_("ctxForceSync"), async () => { await rpc("forceSyncEntry", { entryId: e.id }); toast(_("syncQueued")); refreshDataSoon(); }],
    [_("ctxOpenAnytype"), async () => {
      const ok = await rpc("openInAnytype", { entryId: e.id }).catch(() => false);
      if (!ok) toast(_("notSyncedYet"), "error");
    }],
    null,
    [_("ctxDelete"), () => doDelete(e.id), "danger"]
  );
  if (e.syncState === "conflict") items.unshift([_("resolveConflict"), () => openConflict(e)], null);
  showCtx(ev.clientX, ev.clientY, items);
}

async function doDelete(entryId) {
  await rpc("deleteEntry", { entryId }).catch((err) => toast(err.message, "error"));
  await loadData();
}

/* ================= édition ================= */

let editingId = null;
let eTagsInput = null;

function openEdit(e, focusField) {
  editingId = e.id;
  $("eTitle").value = e.title;
  $("eUrl").value = e.url;
  if (!eTagsInput) eTagsInput = createTagInput($("eTags"), { placeholder: _("tagsPlaceholder") });
  eTagsInput.set(e.tags || []);
  $("eDesc").value = e.description || "";
  $("eSaved").value = e.saved || "link";
  fillFolderSelect($("eFolder"), state.folders, e.folderId);
  $("editDialog").showModal();
  if (focusField) $(focusField).focus();
}

async function saveEdit(ev) {
  ev.preventDefault();
  const patch = {
    title: $("eTitle").value.trim(),
    url: $("eUrl").value.trim(),
    folderId: $("eFolder").value || undefined,
    tags: eTagsInput.get(),
    description: $("eDesc").value.trim(),
    saved: $("eSaved").value,
  };
  const before = state.entries.find((x) => x.id === editingId);
  try {
    await rpc("updateEntry", { entryId: editingId, patch });
    if (patch.saved === "full" && before && before.saved !== "full") {
      rpc("savePage", { entryId: editingId, url: patch.url }).then((ok) => {
        if (!ok) toast(_("savePermissionHint"), "error");
      });
    }
    if (patch.saved === "link" && before && before.saved === "full") {
      await rpc("deletePage", { entryId: editingId });
    }
    $("editDialog").close();
    await loadData();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ================= conflits ================= */

function fillSide(host, d) {
  host.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = d.title || "";
  const urlSpan = document.createElement("span");
  urlSpan.className = "muted";
  urlSpan.textContent = d.url || "";
  host.append(strong, document.createElement("br"), urlSpan, document.createElement("br"));
  for (const t of d.tags || []) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = t;
    host.append(tag, " ");
  }
  if (d.description) {
    const em = document.createElement("em");
    em.textContent = d.description;
    host.append(document.createElement("br"), em);
  }
}

function openConflict(e) {
  fillSide($("cLocal"), e);
  fillSide($("cRemote"), e.conflictRemote || {});
  const done = async (winner) => {
    await rpc("resolveConflict", { entryId: e.id, winner });
    $("conflictDialog").close();
    await loadData();
  };
  $("keepLocal").onclick = () => done("firefox");
  $("keepRemote").onclick = () => done("anytype");
  $("conflictDialog").showModal();
}

/* ================= statut ================= */

async function refreshStatus() {
  const st = await rpc("getStatus").catch(() => null);
  if (!st) return;
  $("statusRibbon").className = "ribbon " + (st.conflicts ? "conflict" : st.pending ? "pending" : "synced");
  const parts = [st.online ? _("statusOnline") : _("statusOffline")];
  if (st.pending) parts.push(_("statusPending", [String(st.pending)]));
  $("statusText").textContent = parts.join(" · ");
}

init();
