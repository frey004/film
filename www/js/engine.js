// Playback and rendering. The audio clock (Web Audio) is the master clock:
// audio clips are scheduled sample-accurately from decoded buffers, video
// elements (muted) chase that clock, and every frame is composited on a
// canvas. Export records that same canvas plus the audio mix.
import { getAsset, getAudioContext } from './media.js';
import { ASPECTS, end, fadeAt, hasAudio, projectDuration, propAt } from './model.js';
import { clamp } from './util.js';

const PRELOAD = 1.2; // seconds before a clip starts that its video gets ready

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.project = null;
    this.t = 0;
    this.playing = false;
    this.els = new Map(); // clipId -> <video>
    this.pool = document.getElementById('media-pool');
    this.sources = [];
    this.onTime = null;
    this.onState = null;
    this.target = null; // export canvas while exporting
    this.drawQueued = false;
    const ac = getAudioContext();
    this.master = ac.createGain();
    this.monitor = ac.createGain();
    this.master.connect(this.monitor);
    this.monitor.connect(ac.destination);
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }

  setProject(p) {
    this.pause();
    this.project = p;
    this.t = 0;
    this.sweep();
    this.requestDraw();
  }

  duration() { return this.project ? projectDuration(this.project) : 0; }

  /** Output size for a given short side (preview or export). */
  sizeFor(short) {
    const a = ASPECTS[this.project.aspect];
    const even = (v) => Math.round(v / 2) * 2;
    return a.w < a.h ? [even(short), even((short * a.h) / a.w)] : [even((short * a.w) / a.h), even(short)];
  }

  // ---- clock ---------------------------------------------------------------

  now() {
    if (!this.playing) return this.t;
    const ac = getAudioContext();
    return this.t0 + Math.max(0, ac.currentTime - this.ctxStart);
  }

  seek(t) {
    this.t = clamp(t, 0, Math.max(0, this.duration()));
    if (this.playing) this.restartAudio();
    else this.syncPaused();
    this.requestDraw();
    this.onTime && this.onTime(this.t);
  }

  play() {
    if (this.playing || !this.project) return;
    const ac = getAudioContext();
    ac.resume(); // must run inside the tap handler on iOS
    if (this.t >= this.duration() - 0.05) this.t = 0;
    this.playing = true;
    this.restartAudio();
    this.onState && this.onState(true);
    this.loop();
  }

  pause() {
    if (!this.playing) return;
    this.t = Math.min(this.now(), this.duration());
    this.playing = false;
    this.stopAudio();
    for (const el of this.els.values()) if (!el.paused) el.pause();
    this.syncPaused();
    this.requestDraw();
    this.onState && this.onState(false);
    this.onTime && this.onTime(this.t);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** Call after any edit so audio scheduling and the frame are refreshed. */
  invalidate() {
    this.sweep();
    if (this.playing) {
      this.t = this.now();
      this.restartAudio();
    } else {
      this.syncPaused();
    }
    this.requestDraw();
  }

  loop() {
    if (!this.playing) return;
    const t = this.now();
    const d = this.duration();
    if (t >= d) {
      this.t = d;
      this.pause();
      this.onEnded && this.onEnded();
      return;
    }
    this.syncPlaying(t);
    this.draw(t);
    this.onTime && this.onTime(t);
    requestAnimationFrame(() => this.loop());
  }

  // ---- audio ---------------------------------------------------------------

  restartAudio() {
    this.stopAudio();
    const ac = getAudioContext();
    this.t0 = this.t;
    this.ctxStart = ac.currentTime + 0.06;
    const from = this.t0;
    const at = (tl) => this.ctxStart + (tl - from);
    for (const track of this.project.tracks) {
      if (track.muted || track.type === 'text') continue;
      for (const c of track.clips) {
        if (!hasAudio(c) || c.volume <= 0) continue;
        const asset = getAsset(c.mediaId);
        if (!asset || !asset.buffer) continue;
        const e = end(c);
        if (e <= from + 0.01) continue;
        const s = Math.max(c.start, from);
        const offset = c.in + (s - c.start) * c.speed;
        const length = Math.min(c.out, asset.buffer.duration) - offset;
        if (length <= 0.005) continue;
        const src = ac.createBufferSource();
        src.buffer = asset.buffer;
        src.playbackRate.value = c.speed;
        const g = ac.createGain();
        const gainAt = (tl) => c.volume * fadeAt(c, tl);
        g.gain.setValueAtTime(gainAt(s), at(s));
        const knots = [c.start + c.fadeIn, e - c.fadeOut, e].filter((k) => k > s).sort((a, b) => a - b);
        for (const k of knots) g.gain.linearRampToValueAtTime(gainAt(k), at(k));
        src.connect(g);
        g.connect(this.master);
        src.start(at(s), offset, length);
        this.sources.push(src);
      }
    }
  }

  stopAudio() {
    for (const s of this.sources) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    this.sources = [];
  }

  // ---- video elements ----------------------------------------------------

  videoClips() {
    const out = [];
    for (const track of this.project.tracks) {
      if (track.type !== 'video' || track.hidden) continue;
      for (const c of track.clips) if (c.kind === 'video') out.push(c);
    }
    return out;
  }

  videoFor(c) {
    const asset = getAsset(c.mediaId);
    if (!asset) return null;
    let el = this.els.get(c.id);
    if (el && el._url === asset.url) return el;
    if (el) el.remove();
    el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.preload = 'auto';
    el._url = asset.url;
    el.src = asset.url;
    el._pending = null;
    el.addEventListener('seeked', () => {
      if (el._pending != null) {
        const p = el._pending;
        el._pending = null;
        el.currentTime = p;
      }
      this.requestDraw();
    });
    el.addEventListener('loadeddata', () => this.requestDraw());
    // iOS only decodes frames for videos that have been played once.
    el.addEventListener('loadedmetadata', () => {
      if (!this.playing) el.play().then(() => { if (!this.isActive(c)) el.pause(); }).catch(() => {});
    }, { once: true });
    this.pool.append(el);
    this.els.set(c.id, el);
    return el;
  }

  isActive(c) {
    const t = this.now();
    return this.playing && t >= c.start && t < end(c);
  }

  /** Drops elements of clips that no longer exist. */
  sweep() {
    if (!this.project) return;
    const live = new Set(this.videoClips().map((c) => c.id));
    for (const [id, el] of this.els) {
      if (!live.has(id)) {
        el.pause();
        el.removeAttribute('src');
        el.load();
        el.remove();
        this.els.delete(id);
      }
    }
  }

  setTime(el, t) {
    if (el.seeking) el._pending = t;
    else el.currentTime = t;
  }

  syncPlaying(t) {
    for (const c of this.videoClips()) {
      const s = c.start, e = end(c);
      const near = t >= s - PRELOAD && t < e;
      if (!near) {
        const el = this.els.get(c.id);
        if (el && !el.paused) el.pause();
        continue;
      }
      const el = this.videoFor(c);
      if (!el) continue;
      if (t < s) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - c.in) > 0.05 && !el.seeking) el.currentTime = c.in;
        continue;
      }
      const want = c.in + (t - s) * c.speed;
      if (el.playbackRate !== c.speed) el.playbackRate = c.speed;
      if (el.paused) {
        if (Math.abs(el.currentTime - want) > 0.05) this.setTime(el, want);
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - want) > 0.3) {
        this.setTime(el, want);
      }
    }
  }

  syncPaused() {
    if (!this.project) return;
    const t = this.t;
    for (const c of this.videoClips()) {
      if (t < c.start || t >= end(c)) continue;
      const el = this.videoFor(c);
      if (!el) continue;
      if (!el.paused) el.pause();
      const want = Math.min(c.in + (t - c.start) * c.speed, c.out - 0.001);
      if (Math.abs(el.currentTime - want) > 0.015) this.setTime(el, want);
    }
  }

  /** Resolves once every video visible at time t has a decoded frame. */
  async waitReady(t, timeout = 4000) {
    const deadline = performance.now() + timeout;
    for (;;) {
      const pending = this.videoClips().filter((c) => t >= c.start && t < end(c))
        .map((c) => this.videoFor(c)).filter((el) => el && (el.readyState < 2 || el.seeking));
      if (!pending.length || performance.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ---- drawing ---------------------------------------------------------------

  requestDraw() {
    if (this.drawQueued || this.playing) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (!this.playing) this.draw(this.t);
    });
  }

  draw(t) {
    if (!this.project) return;
    const canvas = this.target || this.canvas;
    const ctx = this.target ? this.targetCtx : this.ctx;
    render(ctx, canvas.width, canvas.height, this.project, t, (c) => this.els.get(c.id));
  }

  // ---- export ----------------------------------------------------------------

  /**
   * Plays the project from the start in real time, recording the canvas and
   * the audio mix. Resolves with the video Blob (or null when cancelled).
   */
  async exportVideo(canvas, { mimeType, bitrate, onProgress, signal }) {
    this.pause();
    const ac = getAudioContext();
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    this.master.connect(dest);
    this.monitor.gain.value = 0;
    this.target = canvas;
    this.targetCtx = canvas.getContext('2d');
    const fps = this.project.fps || 30;
    const stream = new MediaStream([
      ...canvas.captureStream(fps).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    const total = this.duration();
    const prevOnTime = this.onTime;
    let cancelled = false;
    const cleanup = () => {
      this.onTime = prevOnTime;
      this.onEnded = null;
      this.target = null;
      this.monitor.gain.value = 1;
      try { this.master.disconnect(dest); } catch {}
      stream.getTracks().forEach((tr) => tr.stop());
    };
    try {
      this.t = 0;
      this.syncPaused();
      await this.waitReady(0);
      this.draw(0);
      const finished = new Promise((resolve) => {
        this.onEnded = resolve;
        signal && signal.addEventListener('abort', () => { cancelled = true; this.pause(); resolve(); });
      });
      this.onTime = (t) => onProgress && onProgress(Math.min(1, t / total));
      rec.start(1000);
      this.play();
      await finished;
      // Let the last frame and audio reach the recorder.
      await new Promise((r) => setTimeout(r, 250));
      rec.stop();
      await stopped;
    } finally {
      cleanup();
      this.seek(0);
    }
    if (cancelled) return null;
    return new Blob(chunks, { type: (rec.mimeType || mimeType).split(';')[0] });
  }
}

/** Best recording format this device offers (MP4 first). */
export function pickMimeType() {
  if (!window.MediaRecorder) return null;
  const list = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || null;
}

// ---- compositor ------------------------------------------------------------

export function render(ctx, W, H, project, t, videoOf) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.bg || '#000';
  ctx.fillRect(0, 0, W, H);
  // Bottom track first so upper tracks end up on top.
  const visual = project.tracks.filter((tr) => tr.type !== 'audio' && !tr.hidden).reverse();
  for (const track of visual) {
    for (const c of track.clips) {
      if (t < c.start || t >= end(c)) continue;
      const alpha = clamp(propAt(c, 'opacity', t) * fadeAt(c, t), 0, 1);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      if (c.kind === 'video') {
        const el = videoOf(c);
        if (el && el.readyState >= 2 && el.videoWidth) drawMedia(ctx, W, H, c, t, el, el.videoWidth, el.videoHeight);
      } else if (c.kind === 'image') {
        const a = getAsset(c.mediaId);
        if (a && a.img && a.img.naturalWidth) drawMedia(ctx, W, H, c, t, a.img, a.img.naturalWidth, a.img.naturalHeight);
      } else if (c.kind === 'text') {
        drawText(ctx, W, H, c, t);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** Whether this browser applies ctx.filter (colour adjustments). */
export const canFilter = (() => {
  try {
    const g = document.createElement('canvas').getContext('2d');
    g.filter = 'brightness(0.5)';
    return g.filter === 'brightness(0.5)';
  } catch { return false; }
})();

function colorFilter(c) {
  const b = c.brightness ?? 1, k = c.contrast ?? 1, s = c.saturation ?? 1, sp = c.sepia ?? 0;
  if (b === 1 && k === 1 && s === 1 && !sp) return 'none';
  return `brightness(${b}) contrast(${k}) saturate(${s})${sp ? ` sepia(${sp})` : ''}`;
}

function drawMedia(ctx, W, H, c, t, src, w, h) {
  const fit = c.fit === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  const s = fit * propAt(c, 'scale', t);
  const dw = w * s, dh = h * s;
  const cx = W / 2 + propAt(c, 'x', t) * W;
  const cy = H / 2 + propAt(c, 'y', t) * H;
  const rot = (propAt(c, 'rotation', t) || 0) * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  if (canFilter) ctx.filter = colorFilter(c);
  try { ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh); } catch {}
  ctx.restore();
}

export function drawText(ctx, W, H, c, t) {
  const size = Math.max(8, c.size * H * propAt(c, 'scale', t));
  const rot = (propAt(c, 'rotation', t) || 0) * Math.PI / 180;
  ctx.save();
  const ox = W / 2 + propAt(c, 'x', t) * W, oy = H / 2 + propAt(c, 'y', t) * H;
  ctx.translate(ox, oy);
  if (rot) ctx.rotate(rot);
  ctx.translate(-ox, -oy);
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = String(c.text || '').split('\n');
  const lh = size * 1.25;
  const cx = ox;
  const cy = oy;
  const top = cy - ((lines.length - 1) * lh) / 2;
  if (c.box) {
    const pad = size * 0.35;
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
    ctx.fillStyle = c.boxColor || '#000';
    const bx = cx - width / 2 - pad, by = top - lh / 2 - pad * 0.4;
    const bw = width + pad * 2, bh = lines.length * lh + pad * 0.8;
    roundRect(ctx, bx, by, bw, bh, size * 0.25);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (c.outline && !c.box) {
      ctx.lineWidth = size * 0.12;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = c.color || '#fff';
    ctx.fillText(line, cx, y);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

