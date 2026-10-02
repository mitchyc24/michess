// IndexedDB persistence. Everything stays in this browser.
const DB_NAME = "chess-lens";
const VERSION = 1;
const STORES = ["games", "analysis", "evals"];
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: "id" });
          s.createIndex("user", "user");
        }
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const result = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function putMany(store, records) {
  if (!records.length) return;
  const tx = (await open()).transaction(store, "readwrite");
  const s = tx.objectStore(store);
  for (const r of records) s.put(r);
  return done(tx);
}
export async function put(store, record) { return putMany(store, [record]); }
export async function get(store, key) {
  return result((await open()).transaction(store).objectStore(store).get(key));
}
export async function allForUser(store, user) {
  return result((await open()).transaction(store).objectStore(store).index("user").getAll(user));
}
export async function idsForUser(store, user) {
  return result((await open()).transaction(store).objectStore(store).index("user").getAllKeys(user));
}
export async function getMeta(key) { return (await get("meta", key))?.value; }
export async function setMeta(key, value) { return put("meta", { key, value }); }

export async function deleteUser(user) {
  const db = await open();
  for (const store of STORES) {
    const keys = await idsForUser(store, user);
    const tx = db.transaction(store, "readwrite");
    for (const k of keys) tx.objectStore(store).delete(k);
    await done(tx);
  }
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").delete(`sync:${user}`);
  await done(tx);
}

export async function persist() {
  // Ask the browser not to evict our data under storage pressure.
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
