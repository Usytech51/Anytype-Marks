/* Anytype Marks — stockage local chiffré.
 *
 * - Petites données (paramètres, index des favoris, file d'attente, token) :
 *   browser.storage.local, valeurs chiffrées AES-256-GCM.
 * - Données volumineuses (contenu HTML/texte des pages sauvegardées) :
 *   IndexedDB, enregistrements chiffrés individuellement.
 */
"use strict";

ABS.store = (() => {
  const { encrypt, decrypt } = ABS.crypto;

  /* ---------- valeurs chiffrées dans storage.local ---------- */

  async function get(key, fallback = null) {
    const res = await browser.storage.local.get("enc." + key);
    const blob = res["enc." + key];
    if (!blob) return fallback;
    const val = await decrypt(blob);
    return val === null ? fallback : val;
  }

  async function set(key, value) {
    const blob = await encrypt(value);
    await browser.storage.local.set({ ["enc." + key]: blob });
  }

  async function remove(key) {
    await browser.storage.local.remove("enc." + key);
  }

  /* ---------- paramètres ---------- */

  const DEFAULT_SETTINGS = {
    spaceId: "",
    spaceName: "",
    autoSync: true,
    syncIntervalMin: 5,
    conflictPolicy: "latest", // latest | firefox | anytype | ask
    saveMode: "ask", // link | full | ask
    saveImages: true,
    theme: "auto", // auto | light | dark
    language: "auto",
    notifications: true,
    maxCacheMB: 200,
    autoPruneCache: true,
    managerSort: "dateAddedDesc",
    tagRules: [],
  };

  async function getSettings() {
    const s = await get("settings", {});
    return { ...DEFAULT_SETTINGS, ...s };
  }

  async function setSettings(patch) {
    const s = await getSettings();
    const next = { ...s, ...patch };
    await set("settings", next);
    return next;
  }

  /* ---------- index des favoris (cache local) ----------
   * Chaque entrée :
   * { id (uid interne), firefoxId, anytypeId, url, title, folderId,
   *   folderPath, tags[], description, saved ("link"|"full"),
   *   createdAt, updatedAt, syncState ("synced"|"pending"|"conflict"),
   *   order }
   */

  async function getIndex() {
    return await get("index", {});
  }

  async function setIndex(index) {
    await set("index", index);
  }

  async function upsertEntry(entry) {
    const index = await getIndex();
    index[entry.id] = { ...(index[entry.id] || {}), ...entry };
    await setIndex(index);
    return index[entry.id];
  }

  async function removeEntry(id) {
    const index = await getIndex();
    delete index[id];
    await setIndex(index);
  }

  /* ---------- IndexedDB : contenu de pages ---------- */

  const DB_NAME = "abs-pages";
  const STORE = "pages";
  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const t = d.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          const out = fn(store);
          t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
          t.onerror = () => reject(t.error);
        })
    );
  }

  /** Sauvegarde chiffrée du contenu d'une page. */
  async function savePage(id, page) {
    const blob = await encrypt(page);
    blob.savedAt = Date.now();
    blob.size = JSON.stringify(blob).length;
    await tx("readwrite", (s) => s.put({ id, ...blob }));
  }

  async function loadPage(id) {
    const rec = await tx("readonly", (s) => s.get(id));
    return rec ? await decrypt(rec) : null;
  }

  async function deletePage(id) {
    await tx("readwrite", (s) => s.delete(id));
  }

  async function listPages() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const cur = d.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          out.push({ id: c.value.id, size: c.value.size || 0, savedAt: c.value.savedAt || 0 });
          c.continue();
        } else resolve(out);
      };
      cur.onerror = () => reject(cur.error);
    });
  }

  /** Purge les pages les plus anciennes si le cache dépasse la limite. */
  async function pruneCache() {
    const settings = await getSettings();
    if (!settings.autoPruneCache) return;
    const limit = settings.maxCacheMB * 1024 * 1024;
    const pages = (await listPages()).sort((a, b) => a.savedAt - b.savedAt);
    let total = pages.reduce((s, p) => s + p.size, 0);
    for (const p of pages) {
      if (total <= limit) break;
      await deletePage(p.id);
      total -= p.size;
    }
  }

  async function cacheStats() {
    const pages = await listPages();
    return { count: pages.length, bytes: pages.reduce((s, p) => s + p.size, 0) };
  }

  async function clearPages() {
    await tx("readwrite", (s) => s.clear());
  }

  return {
    get, set, remove,
    getSettings, setSettings, DEFAULT_SETTINGS,
    getIndex, setIndex, upsertEntry, removeEntry,
    savePage, loadPage, deletePage, pruneCache, cacheStats, clearPages,
  };
})();
