// Локальное хранилище Cogniflux на основе IndexedDB.
// Чаты и вложения лежат в браузере пользователя, а не в памяти JavaScript.

const DB_NAME = "cogniflux";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("Этот браузер не поддерживает IndexedDB."));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeName, mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const Store = {
  getAllChats() {
    return run("chats", "readonly", (s) => s.getAll());
  },
  putChat(chat) {
    return run("chats", "readwrite", (s) => s.put(chat));
  },
  deleteChat(id) {
    return run("chats", "readwrite", (s) => s.delete(id));
  },
  getKV(key) {
    return run("kv", "readonly", (s) => s.get(key));
  },
  setKV(key, value) {
    return run("kv", "readwrite", (s) => s.put(value, key));
  },
  async clearAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["chats", "kv"], "readwrite");
      tx.objectStore("chats").clear();
      tx.objectStore("kv").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};
