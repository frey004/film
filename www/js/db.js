// IndexedDB storage: projects (JSON) and media (original files as Blobs).

const DB_NAME = 'montaje';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('media')) {
          const s = db.createObjectStore('media', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function listProjects() {
  const all = await wrap((await store('projects')).getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getProject(id) { return wrap((await store('projects')).get(id)); }
export async function putProject(p) { return wrap((await store('projects', 'readwrite')).put(p)); }

export async function deleteProject(id) {
  const media = await listMedia(id);
  const s = await store('media', 'readwrite');
  for (const m of media) s.delete(m.id);
  return wrap((await store('projects', 'readwrite')).delete(id));
}

export async function listMedia(projectId) {
  const s = await store('media');
  return wrap(s.index('projectId').getAll(projectId));
}
export async function putMedia(m) { return wrap((await store('media', 'readwrite')).put(m)); }
export async function deleteMedia(id) { return wrap((await store('media', 'readwrite')).delete(id)); }

/** Asks the browser not to evict our data under storage pressure. */
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}
