/* Anytype Marks — utilitaires partagés.
 * Chargé en premier : définit le namespace global ABS. */
"use strict";

const ABS = (globalThis.ABS = globalThis.ABS || {});

ABS.util = (() => {
  const uid = () =>
    Date.now().toString(36) + "-" + crypto.getRandomValues(new Uint32Array(2)).join("");

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Normalisation pour recherche : minuscules + suppression des accents. */
  const normalize = (s) =>
    (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  /** Distance de Damerau-Levenshtein bornée (tolérance fautes de frappe). */
  function editDistance(a, b, max = 2) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
        }
        rowMin = Math.min(rowMin, dp[i][j]);
      }
      if (rowMin > max) return max + 1;
    }
    return dp[a.length][b.length];
  }

  /**
   * Recherche floue : correspondance partielle, insensible à la casse et aux
   * accents, tolérante aux petites fautes de frappe.
   * Retourne un score > 0 si le texte correspond à la requête, 0 sinon.
   */
  function fuzzyScore(query, text) {
    const q = normalize(query).trim();
    const t = normalize(text);
    if (!q) return 1;
    if (!t) return 0;
    if (t.includes(q)) return 100 - Math.min(50, t.indexOf(q));
    // Tolérance aux fautes : chaque mot de la requête doit approcher un mot du texte.
    const qWords = q.split(/\s+/);
    const tWords = t.split(/[\s/._\-:?#&=]+/);
    let total = 0;
    for (const qw of qWords) {
      let best = 0;
      for (const tw of tWords) {
        if (tw.includes(qw)) { best = Math.max(best, 60); continue; }
        if (qw.length >= 4) {
          const tol = qw.length >= 7 ? 2 : 1;
          const d = editDistance(qw, tw.slice(0, qw.length + tol), tol);
          if (d <= tol) best = Math.max(best, 40 - d * 10);
        }
      }
      if (best === 0) return 0;
      total += best;
    }
    return total / qWords.length;
  }

  const i18n = (key, subs) => {
    try {
      const m = browser.i18n.getMessage(key, subs);
      return m || key;
    } catch {
      return key;
    }
  };

  /** Applique data-i18n / data-i18n-placeholder / data-i18n-title dans un document. */
  function localizeDocument(doc = document) {
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = i18n(el.dataset.i18n);
    for (const el of doc.querySelectorAll("[data-i18n-placeholder]"))
      el.placeholder = i18n(el.dataset.i18nPlaceholder);
    for (const el of doc.querySelectorAll("[data-i18n-title]")) el.title = i18n(el.dataset.i18nTitle);
  }

  const faviconFor = (url) => {
    try {
      const u = new URL(url);
      return `https://icons.duckduckgo.com/ip3/${u.hostname}.ico`;
    } catch {
      return "";
    }
  };

  const escapeHtml = (s) =>
    (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- règles de tags automatiques ----------
   * rule = { id, name, enabled, match: "all"|"any",
   *          conditions: [{ field: "folder"|"title"|"url",
   *                         op: "equals"|"startsWith"|"contains"|"notContains"|"regex",
   *                         value }],
   *          tags: ["Pro", "<<client>>"] }
   * Toutes les règles qui correspondent contribuent leurs tags (union).
   *
   * VARIABLES DYNAMIQUES : une condition peut contenir <<nom>> (ou $$nom).
   * Pour un dossier, <<nom>> capture UN segment de chemin ; pour titre/URL,
   * une portion de texte. La valeur capturée est réutilisable dans les tags.
   *   Condition : dossier contient « Travail/clients/<<client>> »
   *   Tag       : « <<client>> »
   *   → « Barre personnelle/Travail/clients/Entreprise1 » donne le tag « Entreprise1 ».
   * Avec l'opérateur regex, les groupes deviennent <<1>>, <<2>>… et les
   * groupes nommés (?<nom>…) deviennent <<nom>>.
   */
  const VAR_TOKEN_SRC = "<<\\s*([\\w-]+)\\s*>>|\\$\\$([\\w-]+)";
  const hasVars = (v) => new RegExp(VAR_TOKEN_SRC).test(v || "");
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Compile un motif à variables en RegExp. Les groupes reçoivent des noms
   *  techniques sûrs (g0, g1…) mappés vers les noms de variables : cela
   *  autorise les tirets (<<ma-var>>) et la répétition d'une même variable
   *  dans une condition (sinon : nom de groupe invalide ou dupliqué →
   *  SyntaxError silencieuse et condition toujours fausse). */
  function compileVarPattern(value, field) {
    const token = new RegExp(VAR_TOKEN_SRC, "g");
    let re = "";
    let last = 0;
    let i = 0;
    const map = []; // [nomDeGroupeTechnique, nomDeVariable]
    let m;
    while ((m = token.exec(value)) !== null) {
      re += escRe(value.slice(last, m.index));
      const name = (m[1] || m[2]).toLowerCase();
      const g = "g" + i++;
      map.push([g, name]);
      re += field === "folder" ? `(?<${g}>[^/]+)` : `(?<${g}>.+?)`;
      last = m.index + m[0].length;
    }
    re += escRe(value.slice(last));
    return { re, map };
  }

  /** Évalue une condition. Retourne { ok, vars } (vars = captures). */
  function evalCondition(c, ctx) {
    const raw = (c.field === "title" ? ctx.title : c.field === "url" ? ctx.url : ctx.folderPath) || "";
    const value = c.value || "";

    if (c.op === "regex") {
      try {
        const m = raw.match(new RegExp(value, "i"));
        if (!m) return { ok: false, vars: {} };
        const vars = {};
        m.slice(1).forEach((g, i) => { if (g !== undefined) vars[String(i + 1)] = g; });
        for (const [k, v] of Object.entries(m.groups || {})) if (v !== undefined) vars[k.toLowerCase()] = v;
        return { ok: true, vars };
      } catch { return { ok: false, vars: {} }; }
    }

    if (hasVars(value)) {
      // Motif à variables : correspondance insensible à la casse sur le
      // texte BRUT (la capture conserve la casse d'origine).
      const { re, map } = compileVarPattern(value, c.field);
      const seg = c.field === "folder" ? "(?:^|.*/)" : "";
      const anchored = {
        equals: `^${seg}${re}$`,
        startsWith: c.field === "folder" ? `^${seg}${re}` : `^${re}`,
        contains: `${seg}${re}`,
        notContains: `${seg}${re}`,
      }[c.op];
      if (!anchored) return { ok: false, vars: {} };
      let m = null;
      try { m = raw.match(new RegExp(anchored, "i")); } catch { return { ok: false, vars: {} }; }
      if (c.op === "notContains") return { ok: !m, vars: {} };
      if (!m) return { ok: false, vars: {} };
      const vars = {};
      for (const [g, name] of map) {
        const v = m.groups && m.groups[g];
        if (v !== undefined) vars[name] = v;
      }
      return { ok: true, vars };
    }

    // Motif simple : insensible à la casse ET aux accents.
    const hay = normalize(raw);
    const val = normalize(value);
    switch (c.op) {
      case "equals":
        if (c.field === "folder") {
          return { ok: hay === val || hay.split("/").some((s) => s.trim() === val), vars: {} };
        }
        return { ok: hay === val, vars: {} };
      case "startsWith": return { ok: val !== "" && hay.startsWith(val), vars: {} };
      case "contains": return { ok: val !== "" && hay.includes(val), vars: {} };
      case "notContains": return { ok: val !== "" && !hay.includes(val), vars: {} };
      default: return { ok: false, vars: {} };
    }
  }

  /** Substitue <<nom>> / $$nom dans un tag. Retourne null si une variable
   *  n'est pas résolue (le tag est alors ignoré). */
  function substituteVars(tag, vars) {
    let unresolved = false;
    const out = tag.replace(new RegExp(VAR_TOKEN_SRC, "g"), (_, a, b) => {
      const v = vars[(a || b).toLowerCase()];
      if (v === undefined) { unresolved = true; return ""; }
      return v;
    });
    return unresolved ? null : out.trim();
  }

  /** Retourne les tags à ajouter pour un contexte { folderPath, title, url }. */
  function applyTagRules(rules, ctx) {
    const out = [];
    const seen = new Set();
    for (const rule of rules || []) {
      if (rule.enabled === false) continue;
      const conds = (rule.conditions || []).filter((c) => c && c.value);
      if (!conds.length) continue;
      const results = conds.map((c) => evalCondition(c, ctx));
      const ok = rule.match === "any" ? results.some((r) => r.ok) : results.every((r) => r.ok);
      if (!ok) continue;
      // Captures de toutes les conditions satisfaites de la règle.
      const vars = {};
      for (const r of results) if (r.ok) Object.assign(vars, r.vars);
      for (const t of rule.tags || []) {
        const resolved = substituteVars(t, vars);
        if (!resolved) continue;
        const k = normalize(resolved);
        if (k && !seen.has(k)) { seen.add(k); out.push(resolved); }
      }
    }
    return out;
  }

  return { uid, debounce, sleep, normalize, fuzzyScore, i18n, localizeDocument, faviconFor, escapeHtml, applyTagRules };
})();
