/* Anytype Marks — passerelle avec browser.bookmarks.
 *
 * Lit l'arbre de favoris Firefox, calcule les chemins de dossiers et
 * fournit les opérations de création / modification / déplacement
 * utilisées par l'interface et le moteur de synchronisation.
 */
"use strict";

ABS.mapper = (() => {
  /** Ordre d'affichage des racines Firefox : Barre personnelle d'abord. */
  const ROOT_ORDER = { toolbar_____: 0, menu________: 1, unfiled_____: 2, mobile______: 3 };
  const SYSTEM_ROOTS = new Set(Object.keys(ROOT_ORDER));

  /** Retourne { bookmarks: Map(firefoxId → bm), folders: Map(id → {id,title,parentId,path}) } */
  async function snapshot() {
    const tree = await browser.bookmarks.getTree();
    const bookmarks = new Map();
    const folders = new Map();

    function walk(node, path) {
      const isRoot = !node.parentId;
      const title = node.title || "";
      if (node.type === "folder" || (!node.url && node.children !== undefined)) {
        const p = isRoot || !title ? path : path ? `${path}/${title}` : title;
        if (!isRoot) folders.set(node.id, { id: node.id, title, parentId: node.parentId, path: p });
        let children = node.children || [];
        if (isRoot) {
          children = [...children].sort(
            (a, b) => (ROOT_ORDER[a.id] ?? 9) - (ROOT_ORDER[b.id] ?? 9)
          );
        }
        for (const child of children) walk(child, p);
      } else if (node.url && !node.url.startsWith("place:")) {
        bookmarks.set(node.id, {
          firefoxId: node.id,
          title,
          url: node.url,
          folderId: node.parentId,
          folderPath: path,
          order: node.index || 0,
          dateAdded: node.dateAdded || Date.now(),
        });
      }
    }
    for (const root of tree) walk(root, "");
    return { bookmarks, folders };
  }

  /** Dossiers dans l'ordre de l'arbre (Barre personnelle en tête), en
   *  masquant les racines système vides (Mobile, Autres… sans contenu). */
  async function listFolders() {
    const { bookmarks, folders } = await snapshot();
    const list = [...folders.values()]; // ordre d'insertion = ordre de l'arbre trié
    const nonEmptyPrefixes = new Set();
    for (const bm of bookmarks.values()) {
      const parts = (bm.folderPath || "").split("/");
      for (let i = 1; i <= parts.length; i++) nonEmptyPrefixes.add(parts.slice(0, i).join("/"));
    }
    return list.filter((f) => !SYSTEM_ROOTS.has(f.id) || nonEmptyPrefixes.has(f.path));
  }

  async function createBookmark({ title, url, folderId }) {
    return await browser.bookmarks.create({ title, url, parentId: folderId || undefined });
  }

  async function updateBookmark(firefoxId, { title, url }) {
    const changes = {};
    if (title !== undefined) changes.title = title;
    if (url !== undefined) changes.url = url;
    if (Object.keys(changes).length) return await browser.bookmarks.update(firefoxId, changes);
  }

  async function moveBookmark(firefoxId, { folderId, index }) {
    const dest = {};
    if (folderId) dest.parentId = folderId;
    if (index !== undefined) dest.index = index;
    return await browser.bookmarks.move(firefoxId, dest);
  }

  async function deleteBookmark(firefoxId) {
    try { await browser.bookmarks.remove(firefoxId); } catch { /* déjà supprimé */ }
  }

  async function createFolder(title, parentId) {
    return await browser.bookmarks.create({ title, parentId: parentId || undefined, type: "folder" });
  }

  /**
   * Retrouve le dossier Firefox correspondant à un chemin « A/B/C » ;
   * crée les segments manquants. Si le premier segment ne correspond à
   * aucun conteneur existant, la chaîne est créée sous « Autres
   * marque-pages ». Retourne l'id du dossier, ou null si chemin vide.
   */
  async function ensureFolderPath(path) {
    if (!path || !path.trim()) return null;
    const { folders } = await snapshot();
    const byPath = new Map([...folders.values()].map((f) => [f.path, f.id]));
    if (byPath.has(path)) return byPath.get(path);

    const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
    let parentId = null;
    let i = parts.length;
    for (; i > 0; i--) {
      const prefix = parts.slice(0, i).join("/");
      if (byPath.has(prefix)) { parentId = byPath.get(prefix); break; }
    }
    if (!parentId) { parentId = "unfiled_____"; i = 0; }
    for (; i < parts.length; i++) {
      const created = await browser.bookmarks.create({ title: parts[i], parentId, type: "folder" });
      parentId = created.id;
    }
    return parentId;
  }

  async function renameFolder(id, title) {
    return await browser.bookmarks.update(id, { title });
  }

  async function deleteFolder(id) {
    await browser.bookmarks.removeTree(id);
  }

  return {
    snapshot, listFolders,
    createBookmark, updateBookmark, moveBookmark, deleteBookmark,
    createFolder, renameFolder, deleteFolder, ensureFolderPath,
  };
})();
