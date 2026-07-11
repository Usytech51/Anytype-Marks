/* Anytype Marks — moteur de synchronisation bidirectionnelle.
 *
 * Principe :
 *  - L'index local chiffré est la source de vérité intermédiaire.
 *  - Firefox → Anytype : chaque événement bookmarks alimente l'index et
 *    la file d'attente ; la file est rejouée dès qu'Anytype répond.
 *  - Anytype → Firefox : à intervalle régulier (alarme), les bookmarks
 *    de l'espace sont relus et comparés à l'index ; les différences sont
 *    appliquées à Firefox.
 *  - Conflit : le même favori a changé des deux côtés depuis la dernière
 *    synchronisation → résolution selon la politique configurée
 *    (dernière modification / Firefox / Anytype / demander).
 */
"use strict";

ABS.sync = (() => {
  const { store, queue, anytype, mapper, util } = ABS;

  /** Applique les règles de tags automatiques à une entrée.
   *  Retourne true si des tags ont été ajoutés. */
  async function applyRulesToEntry(entry) {
    const settings = await store.getSettings();
    const add = util.applyTagRules(settings.tagRules, {
      folderPath: entry.folderPath || "",
      title: entry.title || "",
      url: entry.url || "",
    });
    if (!add.length) return false;
    const seen = new Set((entry.tags || []).map((t) => util.normalize(t)));
    const missing = add.filter((t) => !seen.has(util.normalize(t)));
    if (!missing.length) return false;
    entry.tags = [...(entry.tags || []), ...missing];
    return true;
  }

  /** IDs Firefox en cours de modification par le moteur (anti-écho). */
  const selfEdits = new Set();
  const guard = (firefoxId) => {
    selfEdits.add(firefoxId);
    setTimeout(() => selfEdits.delete(firefoxId), 4000);
  };
  const isSelfEdit = (firefoxId) => selfEdits.has(firefoxId);

  let status = { online: false, lastSync: 0, pending: 0, conflicts: 0, syncing: false };
  const listeners = new Set();
  function emit() {
    for (const fn of listeners) { try { fn(status); } catch { /* noop */ } }
    try { browser.runtime.sendMessage({ type: "abs:status", status }).catch(() => {}); } catch { /* noop */ }
  }

  async function refreshBadge() {
    const pending = await queue.size();
    const index = await store.getIndex();
    const conflicts = Object.values(index).filter((e) => e.syncState === "conflict").length;
    status = { ...status, pending, conflicts };
    try {
      const text = conflicts ? "!" : pending ? String(Math.min(pending, 99)) : "";
      await browser.action.setBadgeText({ text });
      await browser.action.setBadgeBackgroundColor({ color: conflicts ? "#c0392b" : "#7a6ff0" });
    } catch { /* noop */ }
    emit();
  }

  /* ---------------- entrées de l'index ---------------- */

  function entryFingerprint(e) {
    return JSON.stringify([e.title, e.url, [...(e.tags || [])].sort(), e.description || "", e.folderPath || ""]);
  }

  async function findByFirefoxId(firefoxId) {
    const index = await store.getIndex();
    return Object.values(index).find((e) => e.firefoxId === firefoxId) || null;
  }

  /* ---------------- Firefox → index + file ---------------- */

  async function onLocalCreated(firefoxId, bm) {
    if (isSelfEdit(firefoxId) || !bm.url) return;
    // L'événement onCreated peut être émis AVANT que le code créateur
    // (pull Anytype, formulaire d'ajout) ait posé son guard ou son entrée.
    // Un court délai + revérification élimine les doublons de course.
    await util.sleep(400);
    if (isSelfEdit(firefoxId)) return;
    const existing = await findByFirefoxId(firefoxId);
    if (existing) return;
    const { bookmarks } = await mapper.snapshot();
    if (await findByFirefoxId(firefoxId)) return; // créée entre-temps (ajout via formulaire)
    const info = bookmarks.get(firefoxId) || { folderPath: "", order: 0, folderId: bm.parentId };
    const entry = {
      id: util.uid(),
      firefoxId,
      anytypeId: null,
      title: bm.title || bm.url,
      url: bm.url,
      folderId: info.folderId,
      folderPath: info.folderPath,
      order: info.order,
      tags: [],
      description: "",
      saved: "link",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      remoteUpdatedAt: 0,
      syncState: "pending",
    };
    await applyRulesToEntry(entry); // tags automatiques selon dossier/titre/URL
    await store.upsertEntry(entry);
    await queue.push("create", entry.id);
    await refreshBadge();
    triggerFlushSoon();
  }

  async function onLocalChanged(firefoxId, changeInfo) {
    if (isSelfEdit(firefoxId)) return;
    const entry = await findByFirefoxId(firefoxId);
    if (!entry) return;
    if (changeInfo.title !== undefined) entry.title = changeInfo.title;
    if (changeInfo.url !== undefined) entry.url = changeInfo.url;
    entry.updatedAt = Date.now();
    entry.syncState = entry.syncState === "conflict" ? "conflict" : "pending";
    await store.upsertEntry(entry);
    await queue.push("update", entry.id);
    await refreshBadge();
    triggerFlushSoon();
  }

  async function onLocalMoved(firefoxId) {
    if (isSelfEdit(firefoxId)) return;
    const entry = await findByFirefoxId(firefoxId);
    if (!entry) return;
    const { bookmarks } = await mapper.snapshot();
    const info = bookmarks.get(firefoxId);
    if (!info) return;
    entry.folderId = info.folderId;
    entry.folderPath = info.folderPath;
    entry.order = info.order;
    entry.updatedAt = Date.now();
    await applyRulesToEntry(entry); // nouveau dossier → tags automatiques
    if (entry.syncState !== "conflict") entry.syncState = "pending";
    await store.upsertEntry(entry);
    await queue.push("update", entry.id);
    await refreshBadge();
    triggerFlushSoon();
    reconcileFoldersSoon(); // les voisins décalés (index) sont resynchronisés
  }

  async function onLocalRemoved(firefoxId) {
    if (isSelfEdit(firefoxId)) return;
    const entry = await findByFirefoxId(firefoxId);
    if (!entry) return;
    entry.deleted = true;
    entry.updatedAt = Date.now();
    await store.upsertEntry(entry);
    await queue.push("delete", entry.id);
    await store.deletePage(entry.id);
    await refreshBadge();
    triggerFlushSoon();
  }

  /** Modification venue de l'interface (tags, description, mode de sauvegarde…). */
  async function updateEntryFromUI(entryId, patch) {
    const index = await store.getIndex();
    const entry = index[entryId];
    if (!entry) throw new Error("entry_not_found");

    const firefoxPatch = {};
    if (patch.title !== undefined && patch.title !== entry.title) firefoxPatch.title = patch.title;
    if (patch.url !== undefined && patch.url !== entry.url) firefoxPatch.url = patch.url;
    if (Object.keys(firefoxPatch).length && entry.firefoxId) {
      guard(entry.firefoxId);
      await mapper.updateBookmark(entry.firefoxId, firefoxPatch);
    }
    const folderChanged = patch.folderId !== undefined && patch.folderId !== entry.folderId;
    const orderChanged = patch.order !== undefined && patch.order !== entry.order;
    if ((folderChanged || orderChanged) && entry.firefoxId) {
      // Un changement d'ORDRE seul doit aussi être appliqué à Firefox
      // (avant : seul un changement de dossier déclenchait le move, le
      // réordonnancement ne touchait jamais la barre de favoris).
      guard(entry.firefoxId);
      await mapper.moveBookmark(entry.firefoxId, {
        folderId: patch.folderId !== undefined ? patch.folderId : entry.folderId,
        index: patch.order,
      });
      const { bookmarks } = await mapper.snapshot();
      const info = bookmarks.get(entry.firefoxId);
      if (info) { patch.folderPath = info.folderPath; patch.order = info.order; patch.folderId = info.folderId; }
      reconcileFoldersSoon(); // les index des voisins décalés partent aussi vers Anytype
    }

    Object.assign(entry, patch, { updatedAt: Date.now() });
    if (patch.folderId !== undefined || patch.title !== undefined || patch.url !== undefined) {
      await applyRulesToEntry(entry);
    }
    if (entry.syncState !== "conflict") entry.syncState = "pending";
    await store.upsertEntry(entry);
    await queue.push("update", entry.id);
    await refreshBadge();
    triggerFlushSoon();
    return entry;
  }

  /* ---------------- envoi de la file vers Anytype ---------------- */

  async function flushQueue() {
    const settings = await store.getSettings();
    if (!settings.spaceId) return;
    if (!(await anytype.isAuthenticated())) { status.online = false; emit(); return; }
    status.online = true;

    await queue.flush(async (op) => {
      const index = await store.getIndex();
      const entry = index[op.entryId];

      if (op.kind === "delete") {
        if (entry && entry.anytypeId) await anytype.deleteBookmark(settings.spaceId, entry.anytypeId);
        if (entry) await store.removeEntry(entry.id);
        return;
      }
      if (!entry || entry.deleted) { const e = new Error("gone"); e.permanent = true; throw e; }

      // Conflit non résolu : on n'écrase pas Anytype.
      if (entry.syncState === "conflict") { const e = new Error("conflict"); e.permanent = true; throw e; }

      let pageText;
      if (entry.saved === "full") {
        const page = await store.loadPage(entry.id);
        pageText = page ? page.markdown || page.text || undefined : undefined;
      }
      const payload = { ...entry, pageText };

      let anytypeId = entry.anytypeId;
      if (!anytypeId) {
        const { id } = await anytype.createBookmark(settings.spaceId, payload);
        anytypeId = id;
      } else {
        try {
          await anytype.updateBookmark(settings.spaceId, anytypeId, payload);
        } catch (e) {
          if (e.status === 404 || e.status === 410) {
            const { id } = await anytype.createBookmark(settings.spaceId, payload);
            anytypeId = id;
          } else throw e;
        }
      }
      // IMPORTANT : on relit l'entrée depuis l'index avant d'écrire.
      // L'appel réseau peut durer ; si l'utilisateur a modifié l'entrée
      // entre-temps (ex : tags posés juste après la création), réécrire
      // l'objet lu avant l'appel effacerait ces modifications.
      const freshIndex = await store.getIndex();
      const fresh = freshIndex[op.entryId];
      if (fresh && !fresh.deleted) {
        fresh.anytypeId = anytypeId;
        fresh.remoteUpdatedAt = Date.now();
        // Une opération plus récente en file re-synchronisera si besoin.
        const stillQueued = (await queue.list()).some(
          (o) => o.entryId === op.entryId && o.id !== op.id
        );
        fresh.syncState = stillQueued ? "pending" : "synced";
        await store.upsertEntry(fresh);
      }
    });
    await refreshBadge();
  }

  /* ---------------- Anytype → Firefox (pull) ---------------- */

  /** Déplacements d'ordre collectés pendant un pull, appliqués en une
   *  passe finale triée : appliquer les index au fil de l'eau décale les
   *  éléments déjà placés et donne un ordre final faux. */
  let orderMoves = [];

  async function finalizeOrderPass() {
    if (!orderMoves.length) return;
    const moves = orderMoves;
    orderMoves = [];
    // Tri par dossier puis index croissant : l'application séquentielle
    // ascendante reconstruit exactement l'arrangement voulu.
    moves.sort((a, b) =>
      String(a.folderId).localeCompare(String(b.folderId)) || a.order - b.order);
    for (const m of moves) {
      if (!m.firefoxId) continue;
      try {
        guard(m.firefoxId);
        await mapper.moveBookmark(m.firefoxId, { folderId: m.folderId || undefined, index: m.order });
      } catch { /* index hors bornes : ignoré */ }
    }
    // Réalité → index : une seule lecture de l'arbre pour tout mettre à jour.
    const { bookmarks } = await mapper.snapshot();
    const index = await store.getIndex();
    let dirty = false;
    for (const e of Object.values(index)) {
      const info = e.firefoxId && bookmarks.get(e.firefoxId);
      if (info && (e.order !== info.order || e.folderId !== info.folderId || e.folderPath !== info.folderPath)) {
        e.order = info.order; e.folderId = info.folderId; e.folderPath = info.folderPath;
        dirty = true;
      }
    }
    if (dirty) await store.setIndex(index);
  }

  async function pullFromAnytype() {
    const settings = await store.getSettings();
    if (!settings.spaceId) return;
    if (!(await anytype.isAuthenticated())) { status.online = false; emit(); return; }
    status.online = true;
    const spaceId = settings.spaceId;
    orderMoves = [];

    const remote = await anytype.listBookmarks(spaceId);
    const remoteById = new Map(remote.map((r) => [r.anytypeId, r]));
    const index = await store.getIndex();
    const entries = Object.values(index).filter((e) => !e.deleted);
    const pendingIds = new Set((await queue.list()).map((o) => o.entryId));

    /* 1. Mises à jour et suppressions distantes */
    for (const entry of entries) {
      if (!entry.anytypeId) continue;
      const r = remoteById.get(entry.anytypeId);

      if (!r || r.archived) {
        // Absent des résultats de recherche ≠ supprimé (réponse possiblement
        // partielle). On CONFIRME par une lecture directe avant de toucher
        // au favori Firefox.
        if (pendingIds.has(entry.id)) continue; // modif locale en attente : elle gagnera
        let full;
        try { full = await anytype.getObjectNormalized(spaceId, entry.anytypeId); }
        catch { continue; } // erreur transitoire : on ne supprime rien
        if (full.gone || full.archived) {
          if (entry.firefoxId) { guard(entry.firefoxId); await mapper.deleteBookmark(entry.firefoxId); }
          await store.removeEntry(entry.id);
          await store.deletePage(entry.id);
        }
        continue;
      }
      remoteById.delete(entry.anytypeId);

      // Détection rapide sur les données de recherche…
      const localTagsEmpty = !(entry.tags || []).length;
      const quickChanged =
        // …passe de réparation : des tags existent côté Anytype mais pas en
        // local (dégâts d'anciennes versions, merge incomplet) → on répare
        // sans condition d'horodatage.
        (localTagsEmpty && r.tags !== undefined && r.tags.length > 0) ||
        (r.updatedAt > (entry.remoteUpdatedAt || 0) + 2000 &&
        (r.title !== entry.title || r.url !== entry.url ||
          (r.tags !== undefined && JSON.stringify([...r.tags].sort()) !== JSON.stringify([...(entry.tags || [])].sort())) ||
          (r.description !== undefined && r.description !== (entry.description || "")) ||
          (r.folderPath !== undefined && r.folderPath !== "" && r.folderPath !== (entry.folderPath || "")) ||
          (r.order !== undefined && r.order !== entry.order) ||
          r.updatedAt > (entry.remoteUpdatedAt || 0) + 15000));
      if (!quickChanged) continue;

      // …mais l'application se fait TOUJOURS depuis l'objet complet
      // (les réponses de recherche peuvent omettre des propriétés).
      let full;
      try { full = await anytype.getObjectNormalized(spaceId, entry.anytypeId); }
      catch { continue; }
      if (full.gone) continue; // sera traité au prochain cycle
      const remoteChanged =
        full.title !== entry.title || full.url !== entry.url ||
        (full.tags !== undefined && JSON.stringify([...full.tags].sort()) !== JSON.stringify([...(entry.tags || [])].sort())) ||
        (full.description !== undefined && full.description !== (entry.description || "")) ||
        (full.folderPath !== undefined && full.folderPath !== "" && full.folderPath !== (entry.folderPath || "")) ||
        (full.order !== undefined && full.order !== entry.order);
      if (!remoteChanged) {
        entry.remoteUpdatedAt = Math.max(entry.remoteUpdatedAt || 0, full.updatedAt || r.updatedAt || 0);
        await store.upsertEntry(entry);
        continue;
      }

      const localPending = pendingIds.has(entry.id);
      // Garde-fou absolu anti-effacement : si le local n'a AUCUN tag et
      // qu'Anytype en a, on les fusionne avant tout arbitrage — ainsi même
      // une victoire locale (politique « Firefox » ou « dernière modif »)
      // poussera ces tags au lieu de les effacer.
      if (!(entry.tags || []).length && full.tags !== undefined && full.tags.length) {
        entry.tags = [...full.tags];
        await store.upsertEntry(entry);
      }
      if (localPending) {
        /* ----- Conflit ----- */
        const policy = settings.conflictPolicy;
        if (policy === "firefox") continue;
        if (policy === "anytype" || (policy === "latest" && (full.updatedAt || r.updatedAt) >= entry.updatedAt)) {
          await applyRemote(entry, full);
          await removeFromQueue(entry.id);
        } else if (policy === "latest") {
          continue;
        } else {
          entry.syncState = "conflict";
          entry.conflictRemote = {
            title: full.title, url: full.url,
            tags: full.tags !== undefined ? full.tags : entry.tags,
            description: full.description !== undefined ? full.description : entry.description,
            folderPath: full.folderPath,
            updatedAt: full.updatedAt || r.updatedAt,
          };
          await store.upsertEntry(entry);
          await notify("conflict", entry.title);
        }
      } else {
        await applyRemote(entry, full);
      }
    }

    /* 2. Nouveaux bookmarks créés dans Anytype */
    for (const [anytypeId, rLite] of remoteById) {
      if (rLite.archived || !rLite.url) continue;
      // Objet complet d'abord : tags / dossier / ordre fiables.
      let r;
      try { r = await anytype.getObjectNormalized(spaceId, anytypeId); }
      catch { continue; }
      if (r.gone || r.archived || !r.url) continue;

      // Adoption anti-doublon : une entrée locale non liée avec la même URL
      // (import Firefox en attente, réinstallation) est LIÉE à l'objet
      // existant. FUSION : union des tags (jamais d'écrasement) et reprise
      // de la description distante si la locale est vide — ainsi le
      // « create » en attente, devenu PATCH, envoie l'état fusionné et ne
      // peut plus effacer les tags de l'objet Anytype d'origine.
      const curIndex = await store.getIndex();
      const canon = (u) => util.normalize(u).replace(/\/+$/, "").replace(/#.*$/, "");
      const orphan = Object.values(curIndex).find(
        (e) => !e.deleted && !e.anytypeId && canon(e.url) === canon(r.url)
      );
      if (orphan) {
        orphan.anytypeId = anytypeId;
        if (r.tags !== undefined && r.tags.length) {
          const seen = new Set((orphan.tags || []).map((t) => util.normalize(t)));
          orphan.tags = [...(orphan.tags || []), ...r.tags.filter((t) => !seen.has(util.normalize(t)))];
        }
        if (r.description !== undefined && r.description && !(orphan.description || "")) {
          orphan.description = r.description;
        }
        orphan.remoteUpdatedAt = r.updatedAt || Date.now();
        await store.upsertEntry(orphan);
        // Aligne Anytype sur l'état fusionné (dossier, ordre, tags unis).
        await queue.push("update", orphan.id);
        continue;
      }

      const entry = {
        id: util.uid(),
        firefoxId: null,
        anytypeId,
        title: r.title || r.url,
        url: r.url,
        folderId: null,
        folderPath: "",
        order: typeof r.order === "number" ? r.order : 0,
        tags: r.tags !== undefined ? r.tags : [],
        description: r.description !== undefined ? r.description : "",
        saved: "link",
        createdAt: Date.now(),
        updatedAt: r.updatedAt || Date.now(),
        remoteUpdatedAt: r.updatedAt || Date.now(),
        syncState: "synced",
      };
      try {
        let targetFolderId = null;
        if (r.folderPath) {
          targetFolderId = await mapper.ensureFolderPath(r.folderPath).catch(() => null);
        }
        const created = await mapper.createBookmark({
          title: entry.title,
          url: entry.url,
          folderId: targetFolderId || undefined,
        });
        guard(created.id);
        entry.firefoxId = created.id;
        if (typeof r.order === "number") {
          orderMoves.push({ firefoxId: created.id, folderId: targetFolderId, order: r.order });
        }
        const { bookmarks } = await mapper.snapshot();
        const info = bookmarks.get(created.id);
        if (info) { entry.folderId = info.folderId; entry.folderPath = info.folderPath; entry.order = info.order; }
      } catch { continue; }
      await store.upsertEntry(entry);
    }
    await finalizeOrderPass();
    await refreshBadge();
  }

  async function applyRemote(entry, r) {
    if (entry.firefoxId) {
      guard(entry.firefoxId);
      try {
        await mapper.updateBookmark(entry.firefoxId, {
          title: r.title !== entry.title ? r.title : undefined,
          url: r.url !== entry.url ? r.url : undefined,
        });
      } catch { /* favori Firefox introuvable */ }
      // Dossier modifié dans Anytype : déplacement (dossiers créés au besoin).
      if (r.folderPath !== undefined && r.folderPath !== "" && r.folderPath !== (entry.folderPath || "")) {
        try {
          const folderId = await mapper.ensureFolderPath(r.folderPath);
          if (folderId && folderId !== entry.folderId) {
            guard(entry.firefoxId);
            await mapper.moveBookmark(entry.firefoxId, { folderId });
            entry.folderId = folderId;
            entry.folderPath = r.folderPath;
          }
        } catch { /* déplacement impossible : on garde l'existant */ }
      }
      // Ordre modifié dans Anytype : enregistré pour la passe finale triée.
      if (typeof r.order === "number" && r.order !== entry.order) {
        orderMoves.push({ firefoxId: entry.firefoxId, folderId: entry.folderId, order: r.order });
      }
    }
    entry.title = r.title;
    entry.url = r.url;
    // « Absent de la réponse » ≠ « vide » : on ne remplace que les champs connus.
    if (r.tags !== undefined) entry.tags = r.tags;
    if (r.description !== undefined) entry.description = r.description;
    entry.remoteUpdatedAt = r.updatedAt || Date.now();
    entry.updatedAt = Date.now();
    entry.syncState = "synced";
    delete entry.conflictRemote;
    await store.upsertEntry(entry);
  }

  async function removeFromQueue(entryId) {
    const items = (await queue.list()).filter((o) => o.entryId !== entryId);
    await store.set("queue", items);
  }

  /** Résolution manuelle d'un conflit ("firefox" | "anytype"). */
  async function resolveConflict(entryId, winner) {
    const index = await store.getIndex();
    const entry = index[entryId];
    if (!entry || entry.syncState !== "conflict") return;
    if (winner === "anytype" && entry.conflictRemote) {
      await applyRemote(entry, { ...entry.conflictRemote, updatedAt: entry.conflictRemote.updatedAt });
      await removeFromQueue(entryId);
    } else {
      entry.syncState = "pending";
      delete entry.conflictRemote;
      await store.upsertEntry(entry);
      await queue.push("update", entryId);
    }
    await refreshBadge();
    triggerFlushSoon();
  }

  /* ---------------- dossiers : renommage / déplacement ----------------
   * Quand un dossier Firefox est renommé ou déplacé, le chemin de tous les
   * favoris qu'il contient change. On recompare l'arbre réel à l'index et
   * on met en file les entrées dont le chemin a changé. */

  async function reconcileFolders() {
    const { bookmarks } = await mapper.snapshot();
    const index = await store.getIndex();
    let changed = 0;
    for (const entry of Object.values(index)) {
      if (entry.deleted || !entry.firefoxId) continue;
      const info = bookmarks.get(entry.firefoxId);
      if (!info) continue;
      if (info.folderPath !== entry.folderPath || info.folderId !== entry.folderId || info.order !== entry.order) {
        const pathChanged = info.folderPath !== entry.folderPath;
        entry.folderPath = info.folderPath;
        entry.folderId = info.folderId;
        entry.order = info.order;
        entry.updatedAt = Date.now();
        if (pathChanged) await applyRulesToEntry(entry);
        if (entry.syncState !== "conflict") entry.syncState = "pending";
        await store.upsertEntry(entry);
        await queue.push("update", entry.id);
        changed++;
      }
    }
    if (changed) { await refreshBadge(); triggerFlushSoon(); }
    return changed;
  }

  const reconcileFoldersSoon = util.debounce(() => reconcileFolders().catch(() => {}), 800);

  /** Changement d'Espace Anytype : les anciens liens objet pointent vers
   *  l'ancien espace. Sans réinitialisation, le pull du nouvel espace les
   *  croirait supprimés et EFFACERAIT les favoris Firefox. On délie tout
   *  et on remet en file : l'adoption par URL reliera ce qui existe,
   *  le reste sera créé dans le nouvel espace. */
  async function resetAnytypeLinks() {
    const index = await store.getIndex();
    for (const e of Object.values(index)) {
      if (e.deleted) continue;
      e.anytypeId = null;
      e.remoteUpdatedAt = 0;
      e.syncState = "pending";
      delete e.conflictRemote;
      await queue.push("create", e.id);
    }
    await store.setIndex(index);
    await refreshBadge();
  }

  /* ---------------- import initial + cycle complet ---------------- */

  /** Intègre à l'index tous les favoris Firefox encore inconnus. */
  async function importFirefoxBookmarks() {
    const { bookmarks } = await mapper.snapshot();
    const index = await store.getIndex();
    const knownFf = new Set(Object.values(index).map((e) => e.firefoxId).filter(Boolean));
    let added = 0;
    for (const [firefoxId, bm] of bookmarks) {
      if (knownFf.has(firefoxId)) continue;
      const entry = {
        id: util.uid(),
        firefoxId,
        anytypeId: null,
        title: bm.title || bm.url,
        url: bm.url,
        folderId: bm.folderId,
        folderPath: bm.folderPath,
        order: bm.order,
        tags: [],
        description: "",
        saved: "link",
        createdAt: bm.dateAdded,
        updatedAt: Date.now(),
        remoteUpdatedAt: 0,
        syncState: "pending",
      };
      await store.upsertEntry(entry);
      await queue.push("create", entry.id);
      added++;
    }
    if (added) { await refreshBadge(); triggerFlushSoon(); }
    return added;
  }

  let flushTimer = null;
  function triggerFlushSoon() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { fullSync().catch(() => {}); }, 1500);
  }

  let syncing = false;
  async function fullSync({ pull = true } = {}) {
    if (syncing) return;
    syncing = true;
    status.syncing = true; emit();
    try {
      const before = await queue.size();
      // ORDRE CRITIQUE : le pull s'exécute AVANT le flush. À la première
      // synchronisation d'un espace contenant déjà des bookmarks, c'est
      // l'adoption par URL (dans le pull) qui lie les entrées locales aux
      // objets existants ; flusher d'abord créerait des doublons et le
      // PATCH suivant effacerait les tags des originaux.
      if (pull) await pullFromAnytype();
      await flushQueue();
      status.lastSync = Date.now();
      const after = await queue.size();
      if (status.online && before > 0 && after === 0) await notify("syncOk");
      // La file n'est pas vide alors qu'Anytype répond (grosse importation,
      // limite de débit…) : on continue automatiquement sans intervention.
      if (status.online && after > 0) {
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => fullSync({ pull: false }).catch(() => {}), 4000);
      }
    } catch (e) {
      if (e && e.status === 0) status.online = false;
      else await notify("syncError", e && e.message);
    } finally {
      syncing = false;
      status.syncing = false;
      await refreshBadge();
    }
  }

  /* ---------------- notifications ---------------- */

  const lastNotif = new Map();
  async function notify(kind, detail) {
    const settings = await store.getSettings();
    if (!settings.notifications) return;
    const now = Date.now();
    if (now - (lastNotif.get(kind) || 0) < 60000) return; // discrétion
    lastNotif.set(kind, now);
    const msgs = {
      syncOk: util.i18n("notifSyncOk"),
      syncError: util.i18n("notifSyncError") + (detail ? ` (${detail})` : ""),
      conflict: util.i18n("notifConflict") + (detail ? ` : ${detail}` : ""),
      saveDone: util.i18n("notifSaveDone"),
      offline: util.i18n("notifOffline"),
    };
    try {
      await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon-96.png"),
        title: "Anytype Marks",
        message: msgs[kind] || kind,
      });
    } catch { /* noop */ }
  }

  return {
    onLocalCreated, onLocalChanged, onLocalMoved, onLocalRemoved,
    reconcileFolders, reconcileFoldersSoon,
    updateEntryFromUI, resolveConflict,
    importFirefoxBookmarks, resetAnytypeLinks, fullSync, triggerFlushSoon,
    refreshBadge, notify,
    getStatus: () => status,
    onStatus: (fn) => listeners.add(fn),
  };
})();
