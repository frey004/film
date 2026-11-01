// Project data model and the editing operations (split, insert, overwrite,
// ripple delete...). Everything here works on plain JSON so it can be saved
// to IndexedDB and snapshotted for undo/redo.
import { uid, clamp } from './util.js';

export const ASPECTS = {
  '9:16': { w: 9, h: 16, label: '9:16 Vertical' },
  '16:9': { w: 16, h: 9, label: '16:9 Horizontal' },
  '1:1': { w: 1, h: 1, label: '1:1 Cuadrado' },
  '4:5': { w: 4, h: 5, label: '4:5 Retrato' },
};

export const MIN_CLIP = 0.1; // seconds
export const IMAGE_DEFAULT = 3;
export const TEXT_DEFAULT = 3;

export function newTrack(type, name) {
  return { id: uid(), type, name, clips: [], muted: false, hidden: false };
}

export function newProject(name, aspect = '9:16') {
  const now = Date.now();
  return {
    id: uid(), name, aspect, bg: '#000000', fps: 30,
    createdAt: now, updatedAt: now,
    // Display order, top to bottom. Visual tracks higher up are drawn on top.
    tracks: [newTrack('text', 'T1'), newTrack('video', 'V2'), newTrack('video', 'V1'), newTrack('audio', 'A1')],
  };
}

export function nextTrackName(project, type) {
  const prefix = { video: 'V', audio: 'A', text: 'T' }[type];
  let n = 1;
  while (project.tracks.some((t) => t.name === prefix + n)) n++;
  return prefix + n;
}

/** Adds a track of `type` above the other tracks of that type (audio: below). */
export function addTrack(project, type) {
  const tr = newTrack(type, nextTrackName(project, type));
  const idx = project.tracks.findIndex((t) => t.type === type);
  if (type === 'audio') project.tracks.push(tr);
  else if (idx >= 0) project.tracks.splice(idx, 0, tr);
  else project.tracks.unshift(tr);
  return tr;
}

export function newClip(kind, props = {}) {
  return {
    id: uid(), kind, mediaId: null,
    start: 0, in: 0, out: kind === 'text' ? TEXT_DEFAULT : IMAGE_DEFAULT,
    speed: 1, volume: 1, opacity: 1, scale: 1, x: 0, y: 0, rotation: 0, fit: 'contain',
    brightness: 1, contrast: 1, saturation: 1,
    kf: {}, // keyframes: { scale: [{ t, v }], ... } with t relative to the clip start
    fadeIn: 0, fadeOut: 0,
    ...(kind === 'text' ? { text: 'Tu texto', size: 0.07, color: '#ffffff', box: false, boxColor: '#000000', outline: true, y: 0.3 } : {}),
    ...props,
  };
}

/** Which track types accept a clip kind. */
export const trackAccepts = (track, kind) =>
  track.type === 'video' ? kind === 'video' || kind === 'image'
    : track.type === 'audio' ? kind === 'audio'
      : kind === 'text';

export const dur = (c) => (c.out - c.in) / c.speed;
export const end = (c) => c.start + dur(c);
export const hasSourceBounds = (c) => c.kind === 'video' || c.kind === 'audio';
export const hasAudio = (c) => c.kind === 'video' || c.kind === 'audio';

export function projectDuration(p) {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, end(c));
  return d;
}

export function trackEnd(track) {
  return track.clips.reduce((m, c) => Math.max(m, end(c)), 0);
}

export function findClip(p, id) {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

export const sortTrack = (track) => track.clips.sort((a, b) => a.start - b.start);

/** Moves the clip's left edge to timeline time t (keeps the right edge). */
export function trimStartTo(c, t) {
  const delta = t - c.start;
  c.in += delta * c.speed;
  c.start = t;
  // Keyframes stay attached to the same moment of the content.
  if (c.kf) for (const k of Object.keys(c.kf)) for (const key of c.kf[k]) key.t -= delta;
}

/** Moves the clip's right edge to timeline time t. */
export function trimEndTo(c, t) {
  c.out = c.in + (t - c.start) * c.speed;
}

/** Splits clip at timeline time t. Returns the new right-hand clip or null. */
export function splitClip(track, c, t) {
  if (t <= c.start + MIN_CLIP / 2 || t >= end(c) - MIN_CLIP / 2) return null;
  const right = { ...JSON.parse(JSON.stringify(c)), id: uid() };
  trimEndTo(c, t);
  trimStartTo(right, t);
  c.fadeOut = 0;
  right.fadeIn = 0;
  track.clips.push(right);
  sortTrack(track);
  return right;
}

/** Empties the range [a, b) on a track, trimming/splitting what overlaps. */
export function clearRange(track, a, b, exceptId) {
  const eps = 1e-6;
  for (const c of [...track.clips]) {
    if (c.id === exceptId) continue;
    const s = c.start, e = end(c);
    if (e <= a + eps || s >= b - eps) continue;
    if (s >= a - eps && e <= b + eps) {
      track.clips.splice(track.clips.indexOf(c), 1);
    } else if (s < a && e > b) {
      const right = splitClip(track, c, a);
      if (right) trimStartTo(right, b);
      else trimStartTo(c, b);
    } else if (s < a) {
      trimEndTo(c, a);
    } else {
      trimStartTo(c, b);
    }
  }
  track.clips = track.clips.filter((c) => c.id === exceptId || dur(c) >= MIN_CLIP / 4);
  sortTrack(track);
}

/** Three-point "insert": opens a gap at t and pushes later clips to the right. */
export function insertClip(track, clip, t) {
  const spanning = track.clips.find((c) => c.start < t && end(c) > t);
  if (spanning) splitClip(track, spanning, t);
  const d = dur(clip);
  for (const c of track.clips) if (c.start >= t - 1e-6) c.start += d;
  clip.start = t;
  track.clips.push(clip);
  sortTrack(track);
}

/** Three-point "overwrite": replaces whatever is in [t, t + dur). */
export function overwriteClip(track, clip, t) {
  clip.start = t;
  clearRange(track, t, t + dur(clip), clip.id);
  if (!track.clips.includes(clip)) track.clips.push(clip);
  sortTrack(track);
}

export function appendClip(track, clip) {
  clip.start = trackEnd(track);
  track.clips.push(clip);
  sortTrack(track);
}

export function removeClip(track, clip, ripple = false) {
  track.clips.splice(track.clips.indexOf(clip), 1);
  if (ripple) {
    const d = dur(clip);
    for (const c of track.clips) if (c.start >= clip.start - 1e-6) c.start = Math.max(0, c.start - d);
  }
}

/** Shifts every clip that starts at/after `from` on the track by `delta`. */
export function shiftAfter(track, from, delta, exceptId) {
  for (const c of track.clips) if (c.id !== exceptId && c.start >= from - 1e-6) c.start = Math.max(0, c.start + delta);
}

/** Limits for trimming a clip: neighbours on the track and the source media. */
export function trimLimits(track, c, mediaDuration) {
  const others = track.clips.filter((o) => o.id !== c.id);
  const prevEnd = others.filter((o) => end(o) <= c.start + 1e-6).reduce((m, o) => Math.max(m, end(o)), 0);
  const nextStart = others.filter((o) => o.start >= end(c) - 1e-6).reduce((m, o) => Math.min(m, o.start), Infinity);
  let minStart = prevEnd;
  let maxEnd = nextStart;
  if (hasSourceBounds(c)) {
    minStart = Math.max(minStart, c.start - c.in / c.speed);
    maxEnd = Math.min(maxEnd, c.start + (mediaDuration - c.in) / c.speed);
  }
  return { minStart: Math.max(0, minStart), maxEnd };
}

/** 0..1 multiplier from the clip's fade in/out at timeline time t. */
export function fadeAt(c, t) {
  const d = dur(c);
  const local = t - c.start;
  let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, local / c.fadeIn);
  if (c.fadeOut > 0) f = Math.min(f, (d - local) / c.fadeOut);
  return clamp(f, 0, 1);
}

/** Changes speed keeping the start; later clips on the track move with it. */
export function setSpeed(track, c, speed) {
  const oldEnd = end(c);
  c.speed = speed;
  shiftAfter(track, oldEnd, end(c) - oldEnd, c.id);
}

export function snapshot(p) {
  return JSON.stringify({ tracks: p.tracks, aspect: p.aspect, bg: p.bg });
}
export function restore(p, snap) {
  Object.assign(p, JSON.parse(snap));
}

// ---- keyframes -------------------------------------------------------------

export const ANIMATABLE = ['scale', 'x', 'y', 'rotation', 'opacity'];
const KEY_EPS = 1 / 30;

export const isAnimated = (c, prop) => !!(c.kf && c.kf[prop] && c.kf[prop].length);

/** Value of an animatable property at timeline time t (linear between keys). */
export function propAt(c, prop, t) {
  const keys = c.kf && c.kf[prop];
  if (!keys || !keys.length) return c[prop];
  const lt = t - c.start;
  if (lt <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (lt >= last.t) return last.v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (lt <= b.t) {
      // Smoothstep easing so motion starts and stops gently.
      const u = (lt - a.t) / (b.t - a.t || 1);
      const e = u * u * (3 - 2 * u);
      return a.v + (b.v - a.v) * e;
    }
  }
  return last.v;
}

export function keyAt(c, prop, t) {
  const keys = c.kf && c.kf[prop];
  if (!keys) return null;
  const lt = t - c.start;
  return keys.find((k) => Math.abs(k.t - lt) < KEY_EPS) || null;
}

/** Adds or updates the keyframe of `prop` at timeline time t. */
export function setKey(c, prop, t, v) {
  c.kf = c.kf || {};
  const keys = (c.kf[prop] = c.kf[prop] || []);
  const lt = Math.round((t - c.start) * 1000) / 1000;
  const k = keys.find((key) => Math.abs(key.t - lt) < KEY_EPS);
  if (k) k.v = v;
  else keys.push({ t: lt, v });
  keys.sort((a, b) => a.t - b.t);
}

export function removeKey(c, prop, t) {
  const keys = c.kf && c.kf[prop];
  if (!keys) return;
  const k = keyAt(c, prop, t);
  if (k) keys.splice(keys.indexOf(k), 1);
  if (!keys.length) delete c.kf[prop];
}

/** Sets a property: as a keyframe when it is animated, otherwise directly. */
export function setProp(c, prop, t, v) {
  if (isAnimated(c, prop)) setKey(c, prop, t, v);
  else c[prop] = v;
}

/** All keyframe times of a clip (relative to its start), for the timeline. */
export function keyTimes(c) {
  const out = new Set();
  if (c.kf) for (const keys of Object.values(c.kf)) for (const k of keys) out.add(k.t);
  return [...out];
}
