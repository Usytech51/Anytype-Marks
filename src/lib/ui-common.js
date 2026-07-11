/* Anytype Marks — utilitaires des pages d'interface. */
"use strict";

async function rpc(type, payload = {}) {
  const res = await browser.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error("no_response");
  if (!res.ok) {
    const e = new Error(res.error || "error");
    e.status = res.status;
    throw e;
  }
  return res.result;
}

async function applyTheme() {
  try {
    const s = await rpc("getSettings");
    document.documentElement.dataset.theme = s.theme || "auto";
    return s;
  } catch {
    document.documentElement.dataset.theme = "auto";
    return null;
  }
}

function toast(message, kind = "info") {
  let host = document.getElementById("abs-toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "abs-toasts";
    host.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = `padding:8px 16px;border-radius:8px;box-shadow:var(--shadow);font-size:13px;background:var(--bg-raise);border:1px solid var(--line);color:${
    kind === "error" ? "var(--danger)" : "var(--ink)"
  };animation:fadein .15s ease`;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const _ = (key, subs) => ABS.util.i18n(key, subs);

/**
 * Champ de saisie de tags : puces + autocomplétion sur les tags existants
 * (Anytype + locaux). `container` reçoit le composant.
 * Retourne { get(): string[], set(tags), focus() }.
 */
function createTagInput(container, { placeholder = "", onChange = null } = {}) {
  container.classList.add("tag-input");
  container.innerHTML = `
    <div class="ti-chips"></div>
    <input type="text" class="ti-field" autocomplete="off" />
    <div class="ti-suggest" hidden></div>`;
  const chipsEl = container.querySelector(".ti-chips");
  const field = container.querySelector(".ti-field");
  const suggestEl = container.querySelector(".ti-suggest");
  field.placeholder = placeholder;

  let tags = [];
  let all = [];
  let hi = -1; // suggestion surlignée
  const emit = () => { if (onChange) onChange([...tags]); };

  rpc("listTags").then((names) => (all = names)).catch(() => {});

  const norm = ABS.util.normalize;

  function renderChips() {
    chipsEl.replaceChildren();
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "tag ti-chip";
      chip.textContent = t;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ti-x";
      x.textContent = "×";
      x.setAttribute("aria-label", "remove " + t);
      x.addEventListener("click", () => { tags = tags.filter((v) => v !== t); renderChips(); emit(); });
      chip.appendChild(x);
      chipsEl.appendChild(chip);
    }
  }

  function add(raw) {
    const t = raw.trim().replace(/,+$/, "");
    if (!t) return;
    if (!tags.some((v) => norm(v) === norm(t))) { tags.push(t); emit(); }
    field.value = "";
    renderChips();
    hideSuggest();
  }

  function currentSuggestions() {
    const q = field.value.trim();
    const pool = all.filter((n) => !tags.some((t) => norm(t) === norm(n)));
    if (!q) return pool.slice(0, 8);
    return pool
      .map((n) => [ABS.util.fuzzyScore(q, n), n])
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 8)
      .map(([, n]) => n);
  }

  function showSuggest() {
    const items = currentSuggestions();
    suggestEl.replaceChildren();
    hi = -1;
    if (!items.length) { suggestEl.hidden = true; return; }
    items.forEach((name, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.addEventListener("mousedown", (e) => { e.preventDefault(); add(name); field.focus(); });
      b.dataset.i = i;
      suggestEl.appendChild(b);
    });
    suggestEl.hidden = false;
  }

  function hideSuggest() { suggestEl.hidden = true; hi = -1; }

  function highlight(delta) {
    const items = [...suggestEl.querySelectorAll("button")];
    if (!items.length) return;
    hi = (hi + delta + items.length) % items.length;
    items.forEach((b, i) => b.classList.toggle("hi", i === hi));
  }

  field.addEventListener("input", showSuggest);
  field.addEventListener("focus", showSuggest);
  field.addEventListener("blur", () => {
    setTimeout(hideSuggest, 120);
    // Texte laissé dans le champ sans appuyer sur Entrée : on le valide,
    // sinon le tag serait silencieusement perdu à l'envoi du formulaire.
    if (field.value.trim()) add(field.value);
  });
  field.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(-1); }
    else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const items = [...suggestEl.querySelectorAll("button")];
      if (hi >= 0 && items[hi]) add(items[hi].textContent);
      else if (field.value.trim()) add(field.value);
    } else if (e.key === "Backspace" && !field.value && tags.length) {
      tags.pop();
      renderChips();
      emit();
    } else if (e.key === "Escape") hideSuggest();
  });
  container.addEventListener("click", (e) => { if (e.target === container || e.target === chipsEl) field.focus(); });

  return {
    get: () => {
      if (field.value.trim()) add(field.value); // saisie en attente jamais perdue
      return [...tags];
    },
    set: (arr) => { tags = [...new Set((arr || []).map((t) => t.trim()).filter(Boolean))]; renderChips(); },
    focus: () => field.focus(),
  };
}


/**
 * Remplit un <select> de dossiers avec une indentation hiérarchique :
 *   Barre personnelle
 *   – S4I
 *   – Dossier test
 *   –– sous dossier
 * (au lieu des chemins complets répétés).
 */
function fillFolderSelect(sel, folders, selectedId) {
  sel.replaceChildren();
  for (const f of folders) {
    const depth = (f.path.match(/\//g) || []).length;
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = (depth ? "\u2013".repeat(depth) + " " : "") + (f.title || f.path);
    o.title = f.path;
    sel.appendChild(o);
  }
  if (selectedId) sel.value = selectedId;
}
