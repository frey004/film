// "Sonidos en la nube": search free, openly licensed music and sound effects
// through the Openverse API (openverse.org), which indexes Jamendo,
// Freesound, Wikimedia Commons and other sources. No account is needed.
import { isNative, nativeCall, platform } from './util.js';

const API = 'https://api.openverse.org/v1/audio/';

export const CATEGORIES = [
  ['', 'Todo'],
  ['music', 'Música'],
  ['sound_effect', 'Efectos'],
];

const LICENSE_NAMES = {
  cc0: 'CC0 (dominio público)', pdm: 'Dominio público', by: 'CC BY', 'by-sa': 'CC BY-SA',
  'by-nd': 'CC BY-ND', 'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND', sampling: 'Sampling+',
};

export const licenseName = (r) => LICENSE_NAMES[r.license] || (r.license || '').toUpperCase();
/** Licences that ask you to credit the author. */
export const needsCredit = (license) => !['cc0', 'pdm'].includes(license);
/** Licences that forbid commercial use (monetised videos). */
export const nonCommercial = (license) => /nc/.test(license || '');

/** GET through the native HTTP stack in the app (no CORS limits), fetch() on the web. */
async function httpGet(url, binary) {
  if (isNative()) {
    const res = await nativeCall('CapacitorHttp', 'request', {
      url, method: 'GET', headers: {}, responseType: binary ? 'arraybuffer' : 'json',
    });
    if (res.status >= 400) throw new Error(`Error ${res.status}`);
    if (!binary) return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const bin = atob(res.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return binary ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

/** Returns { results, pages } for a search. */
export async function search(query, { category = '', page = 1 } = {}) {
  const params = new URLSearchParams({ q: query, page_size: '20', page: String(page), mature: 'false' });
  if (category) params.set('category', category);
  // iPhone/iPad cannot decode Ogg in every iOS version: ask for safe formats.
  const ios = platform() === 'ios' || /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  if (ios) params.set('extension', 'mp3,wav,m4a,flac');
  let data;
  try {
    data = await httpGet(`${API}?${params}`, false);
  } catch (e) {
    throw new Error(`No se pudo conectar con Openverse (${e.message || e}). Revisa tu conexión.`);
  }
  const results = (data.results || []).filter((r) => r.url).map((r) => ({
    id: r.id,
    title: r.title || 'Sin título',
    creator: r.creator || 'Autor desconocido',
    duration: r.duration ? r.duration / 1000 : 0,
    license: r.license,
    licenseVersion: r.license_version || '',
    licenseUrl: r.license_url || '',
    url: r.url,
    filetype: r.filetype || (r.url.split('?')[0].split('.').pop() || 'mp3').toLowerCase(),
    source: r.source || r.provider || '',
    page: r.foreign_landing_url || '',
    attribution: r.attribution || '',
  }));
  return { results, pages: data.page_count || 1 };
}

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg' };

/** Downloads a result as a File that media.importFile() accepts. */
export async function download(r) {
  let bytes;
  try {
    bytes = await httpGet(r.url, true);
  } catch (e) {
    throw new Error(isNative()
      ? `No se pudo descargar «${r.title}» (${e.message || e}).`
      : `El sitio de «${r.title}» no permite descargarlo desde el navegador. Prueba con otro resultado o usa la app instalada.`);
  }
  const ext = MIME[r.filetype] ? r.filetype : 'mp3';
  const safe = r.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60).trim() || 'sonido';
  return new File([bytes], `${safe}.${ext}`, { type: MIME[ext] });
}

/** Credit line for a cloud sound, e.g. «Lluvia» de Ana (CC BY 4.0), vía Freesound. */
export function creditLine(c) {
  const lic = `${LICENSE_NAMES[c.license] || c.license}${c.licenseVersion ? ' ' + c.licenseVersion : ''}`;
  return `«${c.title}» de ${c.creator} (${lic})${c.source ? `, vía ${c.source}` : ''}${c.page ? ` — ${c.page}` : ''}`;
}
