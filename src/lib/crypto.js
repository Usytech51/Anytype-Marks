/* Anytype Marks — chiffrement local.
 *
 * Toutes les données persistées (cache des favoris, file d'attente, contenu
 * de pages, token Anytype) sont chiffrées en AES-256-GCM via WebCrypto.
 * La clé est générée aléatoirement à la première exécution et conservée
 * dans browser.storage.local (isolé par profil Firefox et par extension).
 */
"use strict";

ABS.crypto = (() => {
  const KEY_ID = "abs.key.v1";
  let cachedKey = null;

  const b64 = {
    enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
    dec: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
  };

  async function getKey() {
    if (cachedKey) return cachedKey;
    const stored = await browser.storage.local.get(KEY_ID);
    if (stored[KEY_ID]) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        b64.dec(stored[KEY_ID]),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
      return cachedKey;
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const raw = await crypto.subtle.exportKey("raw", key);
    await browser.storage.local.set({ [KEY_ID]: b64.enc(raw) });
    cachedKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return cachedKey;
  }

  /** Chiffre une valeur JSON-sérialisable → { iv, data } en base64. */
  async function encrypt(value) {
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return { v: 1, iv: b64.enc(iv), data: b64.enc(cipher) };
  }

  /** Déchiffre un objet produit par encrypt(). Retourne null si invalide. */
  async function decrypt(blob) {
    if (!blob || !blob.iv || !blob.data) return null;
    try {
      const key = await getKey();
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64.dec(blob.iv) },
        key,
        b64.dec(blob.data)
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }

  return { encrypt, decrypt };
})();
