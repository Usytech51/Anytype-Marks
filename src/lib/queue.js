/* Anytype Marks — file d'attente de synchronisation.
 *
 * Chaque opération locale (création, modification, suppression…) est
 * enregistrée ici, chiffrée, puis rejouée dès qu'Anytype est joignable.
 * Les opérations vers un même favori sont fusionnées (coalescence) pour
 * éviter les allers-retours inutiles.
 */
"use strict";

ABS.queue = (() => {
  const KEY = "queue";
  let flushing = false;

  async function list() {
    return await ABS.store.get(KEY, []);
  }

  async function save(items) {
    await ABS.store.set(KEY, items);
  }

  /**
   * op = { id, entryId, kind: "create"|"update"|"delete", at }
   * Coalescence :
   *  - update après create → create (les données sont relues au flush)
   *  - delete après create non envoyé → les deux sont annulés
   *  - update après update → un seul update
   */
  async function push(kind, entryId) {
    const items = await list();
    const existing = items.filter((o) => o.entryId === entryId);

    if (kind === "delete") {
      const hadCreate = existing.some((o) => o.kind === "create");
      const rest = items.filter((o) => o.entryId !== entryId);
      if (!hadCreate) rest.push({ id: ABS.util.uid(), entryId, kind: "delete", at: Date.now() });
      await save(rest);
      return;
    }

    if (existing.length) {
      // Un « update » après un « create » n'est PAS absorbé : si le create
      // est déjà en cours d'envoi (flush parallèle), il a été lu sans les
      // données les plus récentes ; l'update garantit leur transmission.
      if (existing.some((o) => o.kind === kind)) return; // même opération déjà en file
    }
    items.push({ id: ABS.util.uid(), entryId, kind, at: Date.now() });
    await save(items);
  }

  async function size() {
    return (await list()).length;
  }

  async function clear() {
    await save([]);
  }

  /**
   * Rejoue la file. `handler(op)` doit lancer une exception pour laisser
   * l'opération en file (Anytype indisponible), ou retourner normalement.
   */
  async function flush(handler) {
    if (flushing) return { done: 0, remaining: await size() };
    flushing = true;
    let done = 0;
    try {
      let items = await list();
      while (items.length) {
        const op = items[0];
        try {
          await handler(op);
        } catch (e) {
          if (e && e.permanent) {
            // erreur définitive (ex : entrée disparue) → on jette l'opération
          } else if (e && e.status === 0) {
            break; // Anytype injoignable → on réessaiera plus tard
          } else {
            // erreur transitoire malgré les reprises : on compte les essais
            // et on abandonne l'opération après 10 échecs pour ne pas
            // bloquer le reste de la file.
            const cur = await list();
            const idx = cur.findIndex((o) => o.id === op.id);
            if (idx >= 0) {
              cur[idx].tries = (cur[idx].tries || 0) + 1;
              if (cur[idx].tries >= 10) cur.splice(idx, 1);
              else cur.push(cur.splice(idx, 1)[0]); // repoussée en fin de file
              await save(cur);
            }
            items = await list();
            if (items.every((o) => (o.tries || 0) > 0)) break; // tout a déjà échoué ce cycle
            continue;
          }
        }
        items = (await list()).filter((o) => o.id !== op.id);
        await save(items);
        done++;
      }
      return { done, remaining: (await list()).length };
    } finally {
      flushing = false;
    }
  }

  return { push, list, size, clear, flush };
})();
