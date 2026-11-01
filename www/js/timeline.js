// The multitrack timeline: centred playhead, scroll to scrub, pinch to zoom,
// tap to select, drag a selected clip to move it (also across tracks) and
// drag its white handles to trim.
import { getAsset } from './media.js';
import {
  MIN_CLIP, dur, end, keyTimes, overwriteClip, projectDuration, sortTrack, trackAccepts,
  trimEndTo, trimLimits, trimStartTo,
} from './model.js';
import { clamp, fmtTime, h } from './util.js';

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const SNAP_PX = 10;
const TAP_PX = 8;

export class Timeline {
  constructor(root, app) {
    this.app = app;
    this.pps = 60; // pixels per second
    this.root = root;
    this.scroll = h('div.tl-scroll');
    this.inner = h('div.tl-inner');
    this.scroll.append(this.inner);
    root.append(this.scroll, h('div.tl-playhead'));
    this.progScroll = -1;
    this.drag = null;

    this.scroll.addEventListener('scroll', () => {
      const x = this.scroll.scrollLeft;
      if (Math.abs(x - this.progScroll) < 1.5) return;
      this.progScroll = -1;
      this.app.scrub(x / this.pps);
    }, { passive: true });

    // Tap on empty space clears the selection.
    let down = null;
    this.scroll.addEventListener('pointerdown', (e) => {
      down = e.target.closest('.tl-clip') ? null : { x: e.clientX, y: e.clientY };
    });
    this.scroll.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP_PX) {
        const label = e.target.closest('.tl-label');
        if (label) this.app.trackMenu(label.parentNode.dataset.id);
        else this.app.select(null);
      }
      down = null;
    });
    this.scroll.addEventListener('pointercancel', () => (down = null));

    this.setupPinch();
    new ResizeObserver(() => this.render()).observe(root);
  }

  get pad() { return Math.round(this.root.clientWidth / 2); }

  zoom(factor) { this.setPps(this.pps * factor); }

  setPps(pps) {
    const t = this.app.engine.t;
    this.pps = clamp(pps, 8, 600);
    this.render();
    this.setTime(t);
  }

  setupPinch() {
    let start = null;
    const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    this.scroll.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) start = { d: dist(e), pps: this.pps, t: this.app.engine.t };
    }, { passive: true });
    this.scroll.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      this.pps = clamp(start.pps * (dist(e) / start.d), 8, 600);
      this.render();
      this.setTime(start.t);
    }, { passive: false });
    this.scroll.addEventListener('touchend', (e) => { if (e.touches.length < 2) start = null; });
  }

  /** Moves the timeline so time t sits under the playhead. */
  setTime(t) {
    const x = Math.round(t * this.pps);
    if (Math.abs(this.scroll.scrollLeft - x) < 1) return;
    this.progScroll = x;
    this.scroll.scrollLeft = x;
  }

  x(t) { return this.pad + t * this.pps; }

  render() {
    const p = this.app.project;
    if (!p || this.drag) return;
    const pps = this.pps;
    const total = projectDuration(p);
    const width = this.pad * 2 + (total + 6) * pps;
    this.inner.textContent = '';
    this.inner.style.width = width + 'px';

    // Ruler
    const step = STEPS.find((s) => s * pps >= 64) || 600;
    const ruler = h('div.tl-ruler');
    for (let t = 0; t <= total + 6; t += step) {
      ruler.append(h('div.tl-tick', { style: { left: this.x(t) + 'px' } }, fmtTime(t, step < 1)));
    }
    this.inner.append(ruler);

    for (const track of p.tracks) {
      const row = h(`div.tl-track.${track.type}`, { 'data-id': track.id });
      const flags = [track.muted && 'MUDO', track.hidden && 'OCULTO'].filter(Boolean).join(' ');
      row.append(h('div.tl-label', null, track.name, flags && h('span.flags', null, flags)));
      for (const c of track.clips) row.append(this.clipEl(track, c));
      this.inner.append(row);
    }
    if (!total) {
      this.inner.append(h('div.tl-hint', null, 'Toca «Añadir» para poner vídeos o fotos en la línea de tiempo'));
    }
    this.setTime(this.app.engine.t);
  }

  clipEl(track, c) {
    const pps = this.pps;
    const asset = c.mediaId && getAsset(c.mediaId);
    const selected = this.app.selectedId === c.id;
    const el = h(`div.tl-clip.${c.kind}`, { 'data-id': c.id });
    el.style.left = this.x(c.start) + 'px';
    el.style.width = Math.max(4, dur(c) * pps) + 'px';
    if ((c.kind === 'video' || c.kind === 'image') && asset && asset.thumb) {
      el.style.backgroundImage = `url("${asset.thumb}")`;
    }
    if (c.kind === 'audio' && asset && asset.wave) {
      el.style.backgroundImage = `url("${asset.wave}")`;
      el.style.backgroundSize = `${(asset.duration / c.speed) * pps}px 100%`;
      el.style.backgroundPosition = `${(-c.in / c.speed) * pps}px 0`;
    }
    const name = c.kind === 'text' ? (c.text || '').split('\n')[0] : asset ? asset.name : 'Medio no encontrado';
    el.append(h('div.lbl', null, name));
    const badges = [c.speed !== 1 && `${+c.speed.toFixed(2)}x`, c.volume === 0 && 'mudo'].filter(Boolean);
    if (badges.length) el.append(h('div.badge', null, badges.join(' · ')));
    if (selected) {
      el.classList.add('selected');
      for (const kt of keyTimes(c)) {
        if (kt >= 0 && kt <= dur(c)) el.append(h('div.tl-kf', { style: { left: kt * pps + 'px' } }));
      }
      el.append(h('div.tl-handle.l', { 'data-h': 'l' }), h('div.tl-handle.r', { 'data-h': 'r' }));
    }
    this.bindClip(el, track, c);
    return el;
  }

  bindClip(el, track, c) {
    let tap = null;
    el.addEventListener('pointerdown', (e) => {
      if (this.app.selectedId !== c.id) {
        tap = { x: e.clientX, y: e.clientY };
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.startDrag(e, el, track, c, e.target.dataset.h || 'move');
    });
    el.addEventListener('pointerup', (e) => {
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_PX) this.app.select(c.id);
      tap = null;
    });
    el.addEventListener('pointercancel', () => (tap = null));
  }

  snapPoints(exceptId) {
    const pts = [0, this.app.engine.t];
    for (const tr of this.app.project.tracks) {
      for (const o of tr.clips) if (o.id !== exceptId) pts.push(o.start, end(o));
    }
    return pts;
  }

  snap(t, pts) {
    const tol = SNAP_PX / this.pps;
    let best = t, bestD = tol;
    for (const p of pts) {
      const d = Math.abs(p - t);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  startDrag(e, el, track, c, mode) {
    const asset = c.mediaId && getAsset(c.mediaId);
    const d = {
      mode, el, track, clip: c, target: track,
      x0: e.clientX, y0: e.clientY, s0: this.scroll.scrollLeft,
      start: c.start, end: end(c),
      limits: trimLimits(track, c, asset ? asset.duration : Infinity),
      pts: this.snapPoints(c.id),
      committed: false, moved: false, lastX: e.clientX, lastY: e.clientY,
    };
    this.drag = d;
    el.classList.add('dragging');
    const id = e.pointerId;

    // Listen on window: the clip element may move to another track row.
    const onMove = (ev) => {
      if (ev.pointerId !== id) return;
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      this.updateDrag();
    };
    const finish = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      cancelAnimationFrame(d.raf);
      this.endDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);

    // Auto-scroll when the finger is near the left/right edge.
    const tick = () => {
      const r = this.scroll.getBoundingClientRect();
      const edge = 36;
      let v = 0;
      if (d.moved && d.lastX < r.left + edge) v = -8;
      if (d.moved && d.lastX > r.right - edge) v = 8;
      if (v) {
        this.scroll.scrollLeft += v;
        this.updateDrag();
      }
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  }

  updateDrag() {
    const d = this.drag;
    if (!d) return;
    const dxPx = d.lastX - d.x0 + (this.scroll.scrollLeft - d.s0);
    if (!d.moved && Math.abs(dxPx) < TAP_PX / 2 && Math.abs(d.lastY - d.y0) < TAP_PX) return;
    if (!d.committed) {
      this.app.commit();
      d.committed = true;
    }
    d.moved = true;
    const dt = dxPx / this.pps;
    const c = d.clip;
    if (d.mode === 'move') {
      const length = d.end - d.start;
      let s = Math.max(0, d.start + dt);
      const snapS = this.snap(s, d.pts);
      const snapE = this.snap(s + length, d.pts);
      if (snapS !== s) s = snapS;
      else if (snapE !== s + length) s = snapE - length;
      c.start = Math.max(0, s);
      const over = this.trackUnder(d.lastY, c);
      if (over && over !== d.target) {
        d.target = over;
        this.inner.querySelectorAll('.tl-track').forEach((r) => r.classList.toggle('drop-target', r.dataset.id === over.id));
        this.inner.querySelector(`.tl-track[data-id="${over.id}"]`).append(d.el);
      }
      d.el.style.left = this.x(c.start) + 'px';
    } else if (d.mode === 'l') {
      let s = clamp(d.start + dt, d.limits.minStart, d.end - MIN_CLIP);
      s = clamp(this.snap(s, d.pts), d.limits.minStart, d.end - MIN_CLIP);
      trimStartTo(c, s);
      d.el.style.left = this.x(c.start) + 'px';
      d.el.style.width = dur(c) * this.pps + 'px';
      this.app.previewAt(c.start);
    } else {
      let e = clamp(d.end + dt, d.start + MIN_CLIP, d.limits.maxEnd);
      e = clamp(this.snap(e, d.pts), d.start + MIN_CLIP, d.limits.maxEnd);
      trimEndTo(c, e);
      d.el.style.width = dur(c) * this.pps + 'px';
      this.app.previewAt(Math.max(c.start, e - 1 / 30));
    }
  }

  /** The track row under screen y that can hold this clip, if any. */
  trackUnder(y, c) {
    for (const row of this.inner.querySelectorAll('.tl-track')) {
      const r = row.getBoundingClientRect();
      if (y >= r.top - 2 && y <= r.bottom + 2) {
        const tr = this.app.project.tracks.find((t) => t.id === row.dataset.id);
        return tr && trackAccepts(tr, c.kind) ? tr : null;
      }
    }
    return null;
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved && d.mode === 'move') {
      d.track.clips.splice(d.track.clips.indexOf(d.clip), 1);
      overwriteClip(d.target, d.clip, d.clip.start);
    } else if (d.moved) {
      sortTrack(d.track);
    }
    if (d.moved) this.app.changed();
    else this.render();
    this.app.scrub(this.scroll.scrollLeft / this.pps);
  }
}
