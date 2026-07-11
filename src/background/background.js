/* Anytype Marks — script d'arrière-plan.
 *
 * - Écoute les événements de favoris Firefox et alimente le moteur de sync.
 * - Alarme périodique pour la synchronisation automatique.
 * - Capture du contenu des pages (mode « sauvegarde complète »).
 * - API de messages pour le popup, le gestionnaire et les options.
 */
"use strict";

const { store, queue, anytype, mapper, sync, util } = ABS;

/* ---------------- événements de favoris ---------------- */

async function isFolder(id) {
  try {
    const [node] = await browser.bookmarks.get(id);
    return node && !node.url;
  } catch {
    return false;
  }
}

browser.bookmarks.onCreated.addListener((id, bm) => sync.onLocalCreated(id, bm));
browser.bookmarks.onChanged.addListener(async (id, info) => {
  if (await isFolder(id)) sync.reconcileFoldersSoon(); // renommage de dossier
  else sync.onLocalChanged(id, info);
});
browser.bookmarks.onMoved.addListener(async (id) => {
  if (await isFolder(id)) sync.reconcileFoldersSoon(); // déplacement de dossier
  else sync.onLocalMoved(id);
});
browser.bookmarks.onRemoved.addListener((id) => sync.onLocalRemoved(id));

/* ---------------- alarme de synchronisation ---------------- */

async function scheduleAlarm() {
  const s = await store.getSettings();
  await browser.alarms.clear("abs-sync");
  if (s.autoSync) {
    browser.alarms.create("abs-sync", { periodInMinutes: Math.max(1, s.syncIntervalMin) });
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "abs-sync") sync.fullSync().catch(() => {});
  if (alarm.name === "abs-prune") store.pruneCache().catch(() => {});
});

browser.runtime.onInstalled.addListener(async () => {
  await scheduleAlarm();
  browser.alarms.create("abs-prune", { periodInMinutes: 360 });
  await sync.refreshBadge();
  createMenus();
});

browser.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await sync.refreshBadge();
  createMenus();
  sync.fullSync().catch(() => {});
});

/* ---------------- menu contextuel de page ---------------- */

function createMenus() {
  try {
    browser.menus.removeAll().then(() => {
      browser.menus.create({
        id: "abs-add-page",
        title: util.i18n("menuAddPage"),
        contexts: ["page", "link"],
      });
      browser.menus.create({
        id: "abs-open-manager",
        title: util.i18n("menuOpenManager"),
        contexts: ["action"],
      });
    });
  } catch { /* menus indisponibles */ }
}

browser.menus &&
  browser.menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "abs-open-manager") {
      openManager();
      return;
    }
    if (info.menuItemId === "abs-add-page") {
      const url = info.linkUrl || info.pageUrl || (tab && tab.url);
      const title = info.linkUrl ? info.linkText || url : (tab && tab.title) || url;
      if (!url) return;
      await addBookmark({ title, url, tags: [], saveFull: false, tabId: tab && tab.id });
    }
  });

function openManager() {
  browser.tabs.create({ url: browser.runtime.getURL("src/manager/manager.html") });
}

/* ---------------- capture de page ---------------- */

async function capturePageFromTab(tabId) {
  // 1) Injecte Readability.js — le moteur du mode Lecture de Firefox —
  //    pour extraire l'article sans les éléments parasites.
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["src/lib/vendor/Readability.js"],
    });
  } catch { /* la capture brute servira de repli */ }

  const settings = await store.getSettings();
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    args: [settings.saveImages !== false],
    func: async (withImages) => {
      const pick = (sel, attr) => {
        const el = document.querySelector(sel);
        return el ? (attr ? el.getAttribute(attr) : el.textContent) : "";
      };
      const base = {
        title: document.title,
        description:
          pick('meta[name="description"]', "content") ||
          pick('meta[property="og:description"]', "content") || "",
        favicon:
          pick('link[rel~="icon"]', "href") ||
          new URL("/favicon.ico", location.origin).href,
        capturedAt: Date.now(),
        url: location.href,
      };

      // Extraction « mode Lecture »
      let article = null;
      try {
        if (typeof Readability === "function") {
          article = new Readability(document.cloneNode(true), { charThreshold: 250 }).parse();
        }
      } catch { article = null; }

      if (!article || !article.content) {
        return {
          ...base,
          html: document.documentElement.outerHTML.slice(0, 2_000_000),
          text: (document.body ? document.body.innerText : "").slice(0, 500_000),
          reader: false,
        };
      }

      // Nettoyage + images de l'article. DOMParser produit un document
      // inerte (aucun script exécuté) — préférable à innerHTML pour AMO.
      const artDoc = new DOMParser().parseFromString(article.content, "text/html");
      const artRoot = artDoc.body;
      for (const el of artRoot.querySelectorAll("script, iframe, object, embed, form")) el.remove();

      const toDataUrl = (url) =>
        fetch(url, { credentials: "omit" })
          .then((r) => r.blob())
          .then((blob) => {
            if (blob.size > 500_000 || !blob.type.startsWith("image/")) return null;
            return new Promise((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => resolve(null);
              fr.readAsDataURL(blob);
            });
          })
          .catch(() => null);

      // Résout toutes les images en URL absolue, puis tente l'incrustation
      // en data-URL. Si elle échoue (image inter-domaines bloquée par CORS,
      // trop lourde…), on GARDE l'URL absolue : l'image reste visible dans
      // la visionneuse et dans Anytype au lieu de disparaître.
      const imgs = [...artRoot.querySelectorAll("img")];
      let budget = 4_000_000;
      for (const img of imgs) {
        const src = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
        if (!src) { img.remove(); continue; }
        let abs;
        try { abs = new URL(src, location.href).href; } catch { img.remove(); continue; }
        img.src = abs;
        img.removeAttribute("srcset");
        img.removeAttribute("data-src");
        img.dataset.origSrc = abs; // conservé pour le Markdown
        if (withImages && budget > 0 && imgs.indexOf(img) < 15) {
          const data = await toDataUrl(abs);
          if (data && data.length <= budget) {
            img.src = data;
            budget -= data.length;
          }
        }
      }

      // Conversion de l'article en Markdown (titres, paragraphes, listes,
      // liens, images, code…) pour un corps Anytype correctement mis en
      // forme, avec de vrais retours à la ligne.
      function toMarkdown(node) {
        let out = "";
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            out += child.textContent.replace(/\s+/g, " ");
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) continue;
          const tag = child.tagName.toLowerCase();
          const inner = () => toMarkdown(child).trim();
          switch (tag) {
            case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
              out += `\n\n${"#".repeat(+tag[1])} ${inner()}\n\n`; break;
            case "p": case "section": case "article": case "div": case "figure":
              out += `\n\n${toMarkdown(child).trim()}\n\n`; break;
            case "br": out += "\n"; break;
            case "hr": out += "\n\n---\n\n"; break;
            case "ul": case "ol": {
              let i = 1;
              out += "\n\n";
              for (const li of child.children) {
                if (li.tagName.toLowerCase() !== "li") continue;
                out += `${tag === "ol" ? `${i++}.` : "-"} ${toMarkdown(li).trim().replace(/\n+/g, " ")}\n`;
              }
              out += "\n"; break;
            }
            case "blockquote":
              out += "\n\n" + inner().split("\n").map((l) => "> " + l).join("\n") + "\n\n"; break;
            case "pre":
              out += "\n\n```\n" + child.textContent.replace(/```/g, "ʼʼʼ") + "\n```\n\n"; break;
            case "code": out += "`" + child.textContent + "`"; break;
            case "strong": case "b": out += `**${inner()}**`; break;
            case "em": case "i": out += `*${inner()}*`; break;
            case "a": {
              const href = child.getAttribute("href");
              const t = inner() || href || "";
              out += href && /^https?:/.test(href) ? `[${t}](${href})` : t;
              break;
            }
            case "img": {
              const src = child.dataset.origSrc || child.src || "";
              if (/^https?:/.test(src)) out += `\n\n![${(child.alt || "image").replace(/[\[\]]/g, "")}](${src})\n\n`;
              break;
            }
            case "figcaption": out += `\n*${inner()}*\n`; break;
            case "table": out += "\n\n" + child.innerText.trim() + "\n\n"; break;
            default: out += toMarkdown(child);
          }
        }
        return out;
      }
      const markdown = toMarkdown(artRoot)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return {
        ...base,
        title: article.title || base.title,
        description: article.excerpt || base.description,
        byline: article.byline || "",
        html: artRoot.innerHTML.slice(0, 6_000_000),
        markdown: markdown.slice(0, 60_000),
        text: (article.textContent || "").slice(0, 500_000),
        reader: true,
      };
    },
  });
  return res && res.result;
}

async function capturePageByFetch(url) {
  // Nécessite la permission d'hôte optionnelle "<all_urls>".
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) return null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    const html = (await res.text()).slice(0, 2_000_000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500_000);
    return { html, text, title: "", description: "", favicon: util.faviconFor(url), capturedAt: Date.now(), url };
  } catch {
    return null;
  }
}

/** Ajoute ou retire le tag automatique « Sauvegardé » sur une entrée. */
async function setSavedTag(entry, on) {
  const label = util.i18n("savedTag");
  const norm = util.normalize(label);
  const has = (entry.tags || []).some((t) => util.normalize(t) === norm);
  if (on && !has) entry.tags = [...(entry.tags || []), label];
  else if (!on && has) entry.tags = entry.tags.filter((t) => util.normalize(t) !== norm);
  else return false;
  return true;
}

async function saveFullPage(entryId, { tabId, url }) {
  let page = null;
  if (tabId != null) {
    try { page = await capturePageFromTab(tabId); } catch { /* onglet protégé */ }
  }
  if (!page && url) page = await capturePageByFetch(url);
  if (!page) return false;
  await store.savePage(entryId, page);
  await store.pruneCache();
  const index = await store.getIndex();
  if (index[entryId]) {
    index[entryId].saved = "full";
    await setSavedTag(index[entryId], true); // tag « Sauvegardé » visible dans les tags + Anytype
    index[entryId].updatedAt = Date.now();
    await store.setIndex(index);
    await queue.push("update", entryId);
    sync.triggerFlushSoon();
  }
  await sync.notify("saveDone");
  return true;
}

/* ---------------- ajout d'un favori ---------------- */

async function addBookmark({ title, url, folderId, tags = [], description = "", saveFull = false, tabId }) {
  const created = await mapper.createBookmark({ title, url, folderId });
  // onCreated va créer l'entrée ; on la retrouve puis on la complète.
  await util.sleep(150);
  let entry = null;
  for (let i = 0; i < 10 && !entry; i++) {
    const index = await store.getIndex();
    entry = Object.values(index).find((e) => e.firefoxId === created.id) || null;
    if (!entry) await util.sleep(150);
  }
  if (!entry) throw new Error("entry_not_created");
  entry.tags = tags;
  entry.description = description;
  entry.saved = saveFull ? "full" : "link";
  entry.updatedAt = Date.now();
  await store.upsertEntry(entry);
  await queue.push("update", entry.id);
  if (saveFull) saveFullPage(entry.id, { tabId, url }).catch(() => {});
  sync.triggerFlushSoon();
  return entry;
}

/* ---------------- suppression / duplication ---------------- */

async function deleteEntry(entryId) {
  const index = await store.getIndex();
  const entry = index[entryId];
  if (!entry) return;
  if (entry.firefoxId) {
    await mapper.deleteBookmark(entry.firefoxId); // onRemoved fera le reste
  } else {
    entry.deleted = true;
    await store.upsertEntry(entry);
    await queue.push("delete", entryId);
    sync.triggerFlushSoon();
  }
}

async function duplicateEntry(entryId) {
  const index = await store.getIndex();
  const e = index[entryId];
  if (!e) return null;
  return await addBookmark({
    title: e.title + " (copie)",
    url: e.url,
    folderId: e.folderId,
    tags: [...(e.tags || [])],
    description: e.description,
    saveFull: false,
  });
}

async function forceSyncEntry(entryId) {
  await queue.push("update", entryId);
  await sync.fullSync({ pull: false });
}

/* ---------------- API de messages ---------------- */

browser.runtime.onMessage.addListener((msg, sender) => {
  const handlers = {
    /* état */
    getStatus: async () => ({ ...sync.getStatus(), pending: await queue.size() }),
    getSettings: () => store.getSettings(),
    setSettings: async ({ patch }) => {
      const before = await store.getSettings();
      const next = await store.setSettings(patch);
      if (patch.syncIntervalMin !== undefined || patch.autoSync !== undefined) await scheduleAlarm();
      if (patch.spaceId && patch.spaceId !== before.spaceId) {
        // Changement d'espace : délier les objets de l'ancien espace AVANT
        // tout, sinon le pull du nouvel espace les croirait supprimés et
        // effacerait des favoris Firefox.
        if (before.spaceId) await sync.resetAnytypeLinks();
        await sync.importFirefoxBookmarks();
        sync.fullSync().catch(() => {});
      }
      return next;
    },

    /* connexion Anytype */
    anytypeReachable: () => anytype.isReachable(),
    anytypeAuthenticated: () => anytype.isAuthenticated(),
    connectStart: () => anytype.createChallenge(),
    connectSolve: async ({ challengeId, code }) => {
      await anytype.solveChallenge(challengeId, code);
      return true;
    },
    disconnect: async () => { await anytype.disconnect(); return true; },
    listSpaces: () => anytype.listSpaces(),

    /* données */
    listEntries: async () => Object.values(await store.getIndex()).filter((e) => !e.deleted),
    listFolders: () => mapper.listFolders(),
    listTags: async () => {
      const names = new Set();
      const settings = await store.getSettings();
      if (settings.spaceId) {
        for (const n of await anytype.listTagNames(settings.spaceId).catch(() => [])) names.add(n);
      }
      const index = await store.getIndex();
      for (const e of Object.values(index)) for (const t of e.tags || []) if (t.trim()) names.add(t.trim());
      return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    },
    addBookmark: ({ data }) => addBookmark(data),
    updateEntry: ({ entryId, patch }) => sync.updateEntryFromUI(entryId, patch),
    deleteEntry: ({ entryId }) => deleteEntry(entryId),
    duplicateEntry: ({ entryId }) => duplicateEntry(entryId),
    forceSyncEntry: ({ entryId }) => forceSyncEntry(entryId),
    resolveConflict: ({ entryId, winner }) => sync.resolveConflict(entryId, winner),

    /* dossiers */
    createFolder: ({ title, parentId }) => mapper.createFolder(title, parentId),
    renameFolder: ({ id, title }) => mapper.renameFolder(id, title),
    deleteFolder: ({ id }) => mapper.deleteFolder(id),

    /* pages sauvegardées */
    getPage: ({ entryId }) => store.loadPage(entryId),
    savePage: ({ entryId, tabId, url }) => saveFullPage(entryId, { tabId, url }),
    deletePage: async ({ entryId }) => {
      await store.deletePage(entryId);
      const index = await store.getIndex();
      if (index[entryId]) {
        index[entryId].saved = "link";
        if (await setSavedTag(index[entryId], false)) {
          index[entryId].updatedAt = Date.now();
          await queue.push("update", entryId);
          sync.triggerFlushSoon();
        }
        await store.setIndex(index);
      }
      return true;
    },
    cacheStats: () => store.cacheStats(),
    clearCache: async () => {
      await store.clearPages();
      const index = await store.getIndex();
      for (const e of Object.values(index)) {
        if (e.saved === "full") {
          e.saved = "link";
          if (await setSavedTag(e, false)) {
            e.updatedAt = Date.now();
            await queue.push("update", e.id);
          }
        }
      }
      await store.setIndex(index);
      sync.triggerFlushSoon();
      return true;
    },

    /* actions globales */
    syncNow: async () => { await sync.fullSync(); return sync.getStatus(); },
    importAll: () => sync.importFirefoxBookmarks(),
    openManager: async () => { openManager(); return true; },
    openInAnytype: async ({ entryId }) => {
      const index = await store.getIndex();
      const e = index[entryId];
      const s = await store.getSettings();
      if (!e || !e.anytypeId || !s.spaceId) return false;
      await browser.tabs.create({ url: anytype.deepLink(s.spaceId, e.anytypeId) });
      return true;
    },
    captureActiveTab: async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return tab ? { tabId: tab.id, title: tab.title, url: tab.url } : null;
    },
    checkReaderable: async ({ tabId }) => {
      // Détecte, via le module officiel du mode Lecture de Firefox, si la
      // page peut être extraite. Les pages privilégiées (about:, AMO…)
      // rejettent l'injection → non compatibles.
      try {
        await browser.scripting.executeScript({
          target: { tabId },
          files: ["src/lib/vendor/Readability-readerable.js"],
        });
        const [res] = await browser.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              return typeof isProbablyReaderable === "function" && isProbablyReaderable(document);
            } catch { return false; }
          },
        });
        return !!(res && res.result);
      } catch {
        return false;
      }
    },
  };

  const h = handlers[msg && msg.type];
  if (!h) return;
  return h(msg).then(
    (result) => ({ ok: true, result }),
    (err) => ({ ok: false, error: (err && (err.message || String(err))) || "error", status: err && err.status })
  );
});

/* ---------------- démarrage ---------------- */

(async () => {
  await scheduleAlarm();
  await sync.refreshBadge();
  createMenus();
  // Premier passage : rejoue la file si Anytype est déjà disponible.
  sync.fullSync().catch(() => {});
})();
