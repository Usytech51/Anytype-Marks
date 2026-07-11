/* Anytype Marks — client de l'API locale Anytype.
 *
 * Communique exclusivement avec l'application Anytype locale
 * (http://localhost:31009). Aucune donnée ne quitte la machine.
 *
 * Authentification : POST /v1/auth/challenges (code à 4 chiffres affiché
 * dans Anytype Desktop) puis POST /v1/auth/api_keys → clé API stockée
 * chiffrée. Header requis : Anytype-Version.
 */
"use strict";

ABS.anytype = (() => {
  const BASE = "http://localhost:31009";
  const API_VERSION = "2025-11-08";
  const APP_NAME = "Anytype Marks (Firefox)";

  let apiKeyCache = undefined; // undefined = pas encore chargé, null = absent

  async function getApiKey() {
    if (apiKeyCache !== undefined) return apiKeyCache;
    apiKeyCache = await ABS.store.get("apiKey", null);
    return apiKeyCache;
  }

  async function setApiKey(key) {
    apiKeyCache = key;
    if (key) await ABS.store.set("apiKey", key);
    else await ABS.store.remove("apiKey");
  }

  class ApiError extends Error {
    constructor(status, body) {
      super(`Anytype API ${status}`);
      this.status = status;
      this.body = body;
    }
  }

  /* Limiteur de débit : l'API Anytype accepte une rafale de 60 requêtes
   * puis 1 requête/seconde en régime continu. On respecte ces limites
   * côté client pour que les longues synchronisations ne s'interrompent
   * jamais, et on réessaie automatiquement en cas de 429. */
  const bucket = { tokens: 55, last: Date.now() };
  let ratePromise = Promise.resolve();

  function acquireToken() {
    ratePromise = ratePromise.then(async () => {
      const now = Date.now();
      bucket.tokens = Math.min(55, bucket.tokens + (now - bucket.last) / 1000);
      bucket.last = now;
      if (bucket.tokens < 1) {
        const wait = Math.ceil((1 - bucket.tokens) * 1000);
        await ABS.util.sleep(wait);
        bucket.last = Date.now();
        bucket.tokens = 1;
      }
      bucket.tokens -= 1;
    });
    return ratePromise;
  }

  async function request(method, path, body, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await acquireToken();
        return await requestOnce(method, path, body, opts);
      } catch (e) {
        const transient = e.status === 429 || e.status === 503;
        if (!transient || attempt >= 4) throw e;
        const retryAfter =
          e.retryAfter || Math.min(8000, 1200 * Math.pow(2, attempt));
        await ABS.util.sleep(retryAfter);
      }
    }
  }

  async function requestOnce(method, path, body, { auth = true, timeout = 15000 } = {}) {
    const headers = {
      "Content-Type": "application/json",
      "Anytype-Version": API_VERSION,
    };
    if (auth) {
      const key = await getApiKey();
      if (!key) throw new ApiError(401, { error: "no_api_key" });
      headers["Authorization"] = `Bearer ${key}`;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(0, { error: "unreachable", detail: String(e) });
    } finally {
      clearTimeout(t);
    }
    let data = null;
    try { data = await res.json(); } catch { /* réponse vide */ }
    if (!res.ok) {
      const err = new ApiError(res.status, data);
      const ra = parseFloat(res.headers.get("Retry-After"));
      if (!Number.isNaN(ra)) err.retryAfter = Math.min(15000, ra * 1000 + 200);
      throw err;
    }
    return data;
  }

  /* ---------- disponibilité ---------- */

  async function isReachable() {
    try {
      await request("GET", "/v1/spaces?limit=1", undefined, { timeout: 3000 });
      return true;
    } catch (e) {
      // 401 = joignable mais non authentifié
      return e.status && e.status !== 0 ? true : false;
    }
  }

  async function isAuthenticated() {
    try {
      await request("GET", "/v1/spaces?limit=1", undefined, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- authentification ---------- */

  async function createChallenge() {
    const data = await request("POST", "/v1/auth/challenges", { app_name: APP_NAME }, { auth: false });
    return data.challenge_id || (data.challenge && data.challenge.id);
  }

  async function solveChallenge(challengeId, code) {
    const data = await request(
      "POST",
      "/v1/auth/api_keys",
      { challenge_id: challengeId, code: String(code).trim() },
      { auth: false }
    );
    const key = data.api_key || (data.api_key_object && data.api_key_object.key);
    if (!key) throw new ApiError(500, { error: "no_key_in_response" });
    await setApiKey(key);
    return key;
  }

  async function disconnect() {
    await setApiKey(null);
  }

  /* ---------- espaces ---------- */

  async function listSpaces() {
    const out = [];
    let offset = 0;
    for (;;) {
      const data = await request("GET", `/v1/spaces?limit=100&offset=${offset}`);
      const items = data.data || [];
      out.push(...items);
      if (!data.pagination || !data.pagination.has_more) break;
      offset += items.length;
      if (offset > 5000) break;
    }
    return out.map((s) => ({ id: s.id, name: s.name || s.id }));
  }

  /* ---------- propriété "tag" et options ---------- */

  const tagPropCache = new Map(); // spaceId → { propId, options } | { failedAt }

  async function getTagProperty(spaceId) {
    const cached = tagPropCache.get(spaceId);
    if (cached && !cached.failedAt) return cached;
    // Un échec (Anytype pas encore prêt, coupure…) n'est mémorisé que 60 s.
    if (cached && Date.now() - cached.failedAt < 60000) return null;
    try {
      const data = await request("GET", `/v1/spaces/${spaceId}/properties?limit=200`);
      const prop = (data.data || []).find(
        (p) => p.key === "tag" || (p.format === "multi_select" && ABS.util.normalize(p.name) === "tag")
      );
      if (!prop) { tagPropCache.set(spaceId, { failedAt: Date.now() }); return null; }
      const tagsData = await request("GET", `/v1/spaces/${spaceId}/properties/${prop.id}/tags?limit=1000`);
      const options = new Map();
      for (const t of tagsData.data || []) options.set(ABS.util.normalize(t.name), { id: t.id, name: t.name });
      const entry = { propId: prop.id, key: prop.key || "tag", options };
      tagPropCache.set(spaceId, entry);
      return entry;
    } catch {
      tagPropCache.set(spaceId, { failedAt: Date.now() });
      return null;
    }
  }

  /** Convertit des noms de tags en IDs d'options, en créant les manquantes. */
  async function resolveTagIds(spaceId, tagNames) {
    if (!tagNames || !tagNames.length) {
      const prop = await getTagProperty(spaceId);
      return prop ? [] : null;
    }
    const prop = await getTagProperty(spaceId);
    if (!prop) return null;
    const ids = [];
    for (const name of tagNames) {
      const norm = ABS.util.normalize(name);
      let opt = prop.options.get(norm);
      if (!opt) {
        try {
          const created = await request("POST", `/v1/spaces/${spaceId}/properties/${prop.propId}/tags`, {
            name,
            color: "grey",
          });
          const tag = created.tag || created.data || created;
          opt = { id: tag.id, name: tag.name || name };
          prop.options.set(norm, opt);
        } catch {
          continue;
        }
      }
      ids.push(opt.id);
    }
    return ids;
  }

  /* ---------- propriété dédiée « Dossier Firefox » ---------- */

  const folderPropCache = new Map(); // spaceId → { key } | { failedAt }
  const FOLDER_PROP_NAME = "Dossier Firefox";
  const orderPropCache = new Map(); // spaceId → { key } | { failedAt }
  const ORDER_PROP_NAME = "Ordre Firefox";

  async function ensureProperty(cache, spaceId, name, format) {
    const cached = cache.get(spaceId);
    if (cached && cached.key) return cached.key;
    if (cached && cached.failedAt && Date.now() - cached.failedAt < 60000) return null;
    try {
      const data = await request("GET", `/v1/spaces/${spaceId}/properties?limit=200`);
      let prop = (data.data || []).find(
        (p) => ABS.util.normalize(p.name) === ABS.util.normalize(name)
      );
      if (!prop) {
        const created = await request("POST", `/v1/spaces/${spaceId}/properties`, { name, format });
        prop = created.property || created.data || created;
      }
      const key = prop && prop.key ? prop.key : null;
      cache.set(spaceId, key ? { key } : { failedAt: Date.now() });
      return key;
    } catch {
      cache.set(spaceId, { failedAt: Date.now() });
      return null;
    }
  }

  const getFolderPropertyKey = (spaceId) => ensureProperty(folderPropCache, spaceId, FOLDER_PROP_NAME, "text");
  const getOrderPropertyKey = (spaceId) => ensureProperty(orderPropCache, spaceId, ORDER_PROP_NAME, "number");

  /* ---------- objets bookmark ---------- */

  async function buildProperties(spaceId, entry, tagIds) {
    const props = [{ key: "source", url: entry.url }];
    if (entry.description !== undefined) props.push({ key: "description", text: entry.description || "" });
    // Toujours envoyer la propriété tag (y compris vide) pour permettre
    // la suppression de tous les tags côté Anytype.
    if (Array.isArray(tagIds)) props.push({ key: "tag", multi_select: tagIds });
    const folderKey = await getFolderPropertyKey(spaceId);
    if (folderKey && entry.folderPath !== undefined) {
      props.push({ key: folderKey, text: entry.folderPath || "" });
    }
    const orderKey = await getOrderPropertyKey(spaceId);
    if (orderKey && typeof entry.order === "number") {
      props.push({ key: orderKey, number: entry.order });
    }
    return props;
  }

  /** Le corps ne contient que le contenu de page sauvegardé, en Markdown
   *  (le dossier et les tags vivent dans des propriétés dédiées). */
  function buildBody(entry) {
    return entry.pageText ? entry.pageText.slice(0, 60000) : "";
  }

  async function createBookmark(spaceId, entry) {
    const tagIds = await resolveTagIds(spaceId, entry.tags || []);
    const properties = await buildProperties(spaceId, entry, tagIds || []);
    const payload = {
      name: entry.title || entry.url,
      type_key: "bookmark",
      body: buildBody(entry),
      properties,
    };
    const data = await request("POST", `/v1/spaces/${spaceId}/objects`, payload);
    const obj = data.object || data.data || data;
    // Certaines propriétés (dont l'association aux tags) ne sont pas
    // appliquées de façon fiable à la création : on confirme par un PATCH.
    if ((tagIds && tagIds.length) || entry.folderPath) {
      try {
        await request("PATCH", `/v1/spaces/${spaceId}/objects/${obj.id}`, { properties });
      } catch { /* le prochain cycle de sync réessaiera */ }
    }
    return { id: obj.id };
  }

  async function updateBookmark(spaceId, objectId, entry) {
    const tagIds = await resolveTagIds(spaceId, entry.tags || []);
    const payload = {
      name: entry.title || entry.url,
      properties: await buildProperties(spaceId, entry, tagIds || []),
    };
    if (entry.pageText !== undefined) payload.body = buildBody(entry);
    const data = await request("PATCH", `/v1/spaces/${spaceId}/objects/${objectId}`, payload);
    const obj = data.object || data.data || data;
    return { id: obj.id || objectId };
  }

  /** Noms de tags existants dans l'espace (pour l'autocomplétion). */
  async function listTagNames(spaceId) {
    const prop = await getTagProperty(spaceId);
    return prop ? [...prop.options.values()].map((o) => o.name) : [];
  }

  async function deleteBookmark(spaceId, objectId) {
    try {
      await request("DELETE", `/v1/spaces/${spaceId}/objects/${objectId}`);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }

  async function getObject(spaceId, objectId) {
    const data = await request("GET", `/v1/spaces/${spaceId}/objects/${objectId}`);
    return data.object || data.data || data;
  }

  /** Liste tous les objets de type bookmark de l'espace. */
  async function listBookmarks(spaceId) {
    const folderKey = await getFolderPropertyKey(spaceId);
    const orderKey = await getOrderPropertyKey(spaceId);
    const out = [];
    let offset = 0;
    for (;;) {
      const data = await request("POST", `/v1/spaces/${spaceId}/search?limit=100&offset=${offset}`, {
        query: "",
        types: ["bookmark"],
        sort: { property_key: "last_modified_date", direction: "desc" },
      });
      const items = data.data || [];
      out.push(...items);
      if (!data.pagination || !data.pagination.has_more) break;
      offset += items.length;
      if (offset > 50000) break;
    }
    return out.map((o) => normalizeObject(o, folderKey, orderKey));
  }

  function propValue(obj, key) {
    const p = (obj.properties || []).find((x) => x.key === key);
    if (!p) return undefined;
    return p.url ?? p.text ?? p.number ?? p.date ?? p.multi_select ?? p.select ?? p.value;
  }

  /**
   * Normalise un objet Anytype. RÈGLE DE FIABILITÉ : une propriété ABSENTE
   * de la réponse vaut `undefined` (inconnue — les réponses de recherche
   * peuvent être partielles) et ne doit JAMAIS être traitée comme vide,
   * sinon un pull écraserait les tags/dossiers locaux puis le push les
   * effacerait dans Anytype.
   */
  function normalizeObject(obj, folderKey, orderKey) {
    const tagsRaw = propValue(obj, "tag");
    const tags =
      tagsRaw === undefined
        ? undefined
        : (Array.isArray(tagsRaw) ? tagsRaw : [])
            .map((t) => (typeof t === "string" ? t : t && t.name))
            .filter((t) => typeof t === "string" && t.trim());
    const descRaw = propValue(obj, "description");
    const orderRaw = orderKey ? propValue(obj, orderKey) : undefined;
    const lastModified = propValue(obj, "last_modified_date");
    return {
      anytypeId: obj.id,
      title: obj.name || "",
      url: propValue(obj, "source") || "",
      description: descRaw === undefined ? undefined : descRaw || "",
      folderPath: folderKey ? (propValue(obj, folderKey) === undefined ? undefined : propValue(obj, folderKey) || "") : undefined,
      order: typeof orderRaw === "number" ? orderRaw : undefined,
      tags,
      updatedAt: lastModified ? Date.parse(lastModified) || 0 : 0,
      archived: !!obj.archived,
    };
  }

  /** Objet complet (source d'autorité avant toute application côté Firefox).
   *  Retourne { gone: true } si l'objet n'existe plus. */
  async function getObjectNormalized(spaceId, objectId) {
    const folderKey = await getFolderPropertyKey(spaceId);
    const orderKey = await getOrderPropertyKey(spaceId);
    try {
      const data = await request("GET", `/v1/spaces/${spaceId}/objects/${objectId}`);
      const obj = data.object || data.data || data;
      return normalizeObject(obj, folderKey, orderKey);
    } catch (e) {
      if (e.status === 404 || e.status === 410) return { gone: true };
      throw e;
    }
  }

  /** Deep-link pour ouvrir un objet dans l'application Anytype. */
  const deepLink = (spaceId, objectId) => `anytype://object?objectId=${objectId}&spaceId=${spaceId}`;

  return {
    ApiError,
    isReachable, isAuthenticated,
    createChallenge, solveChallenge, disconnect, getApiKey,
    listSpaces, listTagNames,
    createBookmark, updateBookmark, deleteBookmark, getObject, getObjectNormalized, listBookmarks,
    deepLink,
  };
})();
