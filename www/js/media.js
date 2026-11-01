// Imported media: metadata probing, thumbnails, waveforms and decoded audio.
import * as db from './db.js';
import { uid } from './util.js';

const assets = new Map(); // id -> record + runtime fields (url, img, buffer)
let audioCtx;

export function getAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ latencyHint: 'interactive' });
  }
  return audioCtx;
}

export const getAsset = (id) => assets.get(id);
export const allAssets = () => [...assets.values()];

const EXT = {
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp', 'avi'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'amr'],
};

export function kindOf(file) {
  const t = (file.type || '').split('/')[0];
  if (t === 'video' || t === 'image' || t === 'audio') return t;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k;
  return null;
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Tiempo agotado leyendo ${what}`)), ms)),
  ]);
}

function once(target, ok, bad = 'error') {
  return new Promise((resolve, reject) => {
    const a = () => { clean(); resolve(); };
    const b = () => { clean(); reject(target.error || new Error('No se pudo leer el archivo')); };
    const clean = () => { target.removeEventListener(ok, a); target.removeEventListener(bad, b); };
    target.addEventListener(ok, a);
    target.addEventListener(bad, b);
  });
}

async function probeVideo(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  await once(v, 'loadedmetadata');
  let duration = v.duration;
  if (!isFinite(duration)) {
    // Some recorded WebM files report Infinity until you seek far ahead.
    v.currentTime = 1e7;
    await once(v, 'seeked').catch(() => {});
    duration = v.duration;
  }
  v.currentTime = Math.min(0.5, (duration || 1) / 3);
  await once(v, 'seeked').catch(() => {});
  if (v.readyState < 2) await withTimeout(once(v, 'loadeddata'), 4000, 'el vídeo').catch(() => {});
  const thumb = drawThumb(v, v.videoWidth, v.videoHeight);
  v.removeAttribute('src');
  v.load();
  return { duration: duration || 0, width: v.videoWidth, height: v.videoHeight, thumb };
}

async function probeImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return { duration: 0, width: img.naturalWidth, height: img.naturalHeight, thumb: drawThumb(img, img.naturalWidth, img.naturalHeight), img };
}

async function probeAudio(url) {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  a.src = url;
  await once(a, 'loadedmetadata');
  return { duration: isFinite(a.duration) ? a.duration : 0, width: 0, height: 0, thumb: null };
}

function drawThumb(source, w, h) {
  if (!w || !h) return null;
  const H = 96;
  const W = Math.max(24, Math.round((H * w) / h));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  try {
    c.getContext('2d').drawImage(source, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

/** Waveform picture covering the whole file (clips show their slice of it). */
function drawWave(buffer) {
  const cols = Math.min(4000, Math.max(200, Math.ceil(buffer.duration * 40)));
  const H = 48;
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = H;
  const g = c.getContext('2d');
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / cols));
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (let x = 0; x < cols; x++) {
    let peak = 0;
    const from = x * step;
    for (let i = from; i < from + step && i < data.length; i += 4) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    const bar = Math.max(1, peak * H);
    g.fillRect(x, (H - bar) / 2, 1, bar);
  }
  return c.toDataURL('image/png');
}

const MAX_DECODE_BYTES = 450 * 1024 * 1024;

async function decodeAudio(asset) {
  if (asset.kind === 'image' || asset.buffer || asset.noAudio) return;
  if (asset.blob.size > MAX_DECODE_BYTES) { asset.noAudio = true; return; }
  try {
    const ctx = getAudioContext();
    const data = await asset.blob.arrayBuffer();
    asset.buffer = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    if (!asset.wave) {
      asset.wave = drawWave(asset.buffer);
      await db.putMedia(toRecord(asset));
    }
  } catch {
    asset.noAudio = true; // video without an audio track, or unsupported codec
  }
}

function toRecord(a) {
  const { url, img, buffer, noAudio, ...rec } = a;
  return rec;
}

function attachRuntime(rec) {
  const a = { ...rec, url: URL.createObjectURL(rec.blob) };
  assets.set(a.id, a);
  return a;
}

/** Stores a picked file in the project and returns the asset. */
export async function importFile(projectId, file) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`Formato no compatible: ${file.name}`);
  const url = URL.createObjectURL(file);
  let meta;
  try {
    const probe = kind === 'video' ? probeVideo : kind === 'image' ? probeImage : probeAudio;
    meta = await withTimeout(probe(url), 20000, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (kind !== 'image' && !(meta.duration > 0)) throw new Error(`No se pudo leer la duración de ${file.name}`);
  const rec = {
    id: uid(), projectId, kind, name: file.name, type: file.type,
    duration: meta.duration, width: meta.width, height: meta.height,
    thumb: meta.thumb, wave: null, blob: file, addedAt: Date.now(),
  };
  await db.putMedia(rec);
  const asset = attachRuntime(rec);
  if (kind === 'image') asset.img = meta.img && (await reloadImage(asset));
  await decodeAudio(asset);
  return asset;
}

async function reloadImage(asset) {
  const img = new Image();
  img.src = asset.url;
  try { await img.decode(); } catch {}
  return img;
}

/** Loads every asset of a project. Audio is decoded in the background. */
export async function loadProject(projectId, onAudioReady) {
  unloadAll();
  const recs = await db.listMedia(projectId);
  recs.sort((a, b) => a.addedAt - b.addedAt);
  for (const rec of recs) {
    const a = attachRuntime(rec);
    if (a.kind === 'image') a.img = await reloadImage(a);
  }
  (async () => {
    for (const a of allAssets()) {
      if (!assets.has(a.id)) return; // project was closed meanwhile
      await decodeAudio(a);
      onAudioReady && onAudioReady(a);
    }
  })();
}

export function unloadAll() {
  for (const a of assets.values()) URL.revokeObjectURL(a.url);
  assets.clear();
}

export async function removeAsset(id) {
  const a = assets.get(id);
  if (a) URL.revokeObjectURL(a.url);
  assets.delete(id);
  await db.deleteMedia(id);
}
