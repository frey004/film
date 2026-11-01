import * as db from './db.js';
import * as media from './media.js';
import * as M from './model.js';
import { Engine, pickMimeType, canFilter } from './engine.js';
import { Timeline } from './timeline.js';
import * as ui from './ui.js';
import { $, h, icon, fmtTime, fmtDate, debounce, clamp, isNative, platform, nativeCall, uid } from './util.js';

const app = {
  project: null,
  selectedId: null,
  undoStack: [],
  redoStack: [],
  engine: null,
  timeline: null,

  /** Call before changing the project, so the change can be undone. */
  commit() {
    this.undoStack.push(M.snapshot(this.project));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    updateUndo();
  },

  /** Call after changing the project. */
  changed() {
    if (this.selectedId && !M.findClip(this.project, this.selectedId)) this.selectedId = null;
    this.engine.invalidate();
    this.timeline.render();
    renderToolbar();
    updateTime(this.engine.t);
    save();
  },

  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.timeline.render();
    renderToolbar();
  },

  scrub(t) {
    if (this.engine.playing) this.engine.pause();
    this.engine.seek(t);
  },

  /** Shows the frame at t without moving the playhead (used while trimming). */
  previewAt(t) {
    this.engine.t = t;
    this.engine.syncPaused();
    this.engine.requestDraw();
    updateTime(t);
  },

  trackMenu(trackId) { trackMenu(trackId); },
};

// ---- setup -----------------------------------------------------------------

function init() {
  $('#btn-close').append(icon('back'));
  $('#btn-undo').append(icon('undo'));
  $('#btn-redo').append(icon('redo'));
  $('#btn-start').append(icon('start'));
  $('#btn-play').append(icon('play', 30));
  $('#btn-split').append(icon('split'));
  $('#btn-zoom-out').append(icon('zoomOut', 22));
  $('#btn-zoom-in').append(icon('zoomIn', 22));

  app.engine = new Engine($('#preview'));
  app.engine.onTime = (t) => { updateTime(t); app.timeline.setTime(t); };
  app.engine.onState = (playing) => {
    const b = $('#btn-play');
    b.textContent = '';
    b.append(icon(playing ? 'pause' : 'play', 30));
  };
  app.timeline = new Timeline($('#timeline'), app);

  $('#btn-new').onclick = newProjectSheet;
  $('#btn-close').onclick = () => ui.popLayer();
  $('#btn-rename').onclick = renameProject;
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  $('#btn-play').onclick = () => app.engine.toggle();
  $('#btn-start').onclick = () => app.scrub(0);
  $('#btn-split').onclick = splitAtPlayhead;
  $('#btn-zoom-in').onclick = () => app.timeline.zoom(1.5);
  $('#btn-zoom-out').onclick = () => app.timeline.zoom(1 / 1.5);
  $('#btn-export').onclick = exportSheet;

  new ResizeObserver(layoutPreview).observe($('#preview-wrap'));
  setupPreviewGestures();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && app.project && !exporting) {
      app.engine.pause();
      saveNow();
    }
  });

  db.persist();
  renderProjects();

  if ('serviceWorker' in navigator && !isNative() && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---- home screen ---------------------------------------------------------

async function renderProjects() {
  const list = $('#project-list');
  const projects = await db.listProjects();
  list.textContent = '';
  if (!projects.length) {
    list.append(h('div.empty', null,
      h('strong', null, 'Aún no tienes proyectos'),
      'Crea uno, añade vídeos, fotos, música y textos, y expórtalo en MP4.'));
    return;
  }
  for (const p of projects) {
    const d = M.projectDuration(p);
    const card = h('button.project-card', { onclick: () => openProject(p.id) },
      h('div.thumb', { style: p.thumb ? { backgroundImage: `url("${p.thumb}")` } : null }, p.thumb ? null : icon('movie', 36)),
      h('div.info', null,
        h('div.name', null, p.name),
        h('div.meta', null, `${fmtTime(d, false)} · ${p.aspect} · ${fmtDate(p.updatedAt)}`)));
    const more = h('button.icon-btn.menu', { 'aria-label': 'Opciones' }, icon('more', 20));
    more.onclick = (e) => { e.stopPropagation(); projectMenu(p); };
    card.append(more);
    list.append(card);
  }
}

function projectMenu(p) {
  ui.openSheet(p.name, ui.menu([
    { icon: 'edit', label: 'Renombrar', onclick: async () => {
      const name = await ui.ask('Renombrar proyecto', p.name);
      if (name) { p.name = name; await db.putProject(p); renderProjects(); }
    } },
    { icon: 'delete', label: 'Eliminar proyecto', danger: true, onclick: async () => {
      if (await ui.confirmSheet('¿Eliminar proyecto?', `Se borrará «${p.name}» y los archivos que importaste en él. Los originales de tu galería no se tocan.`)) {
        await db.deleteProject(p.id);
        renderProjects();
      }
    } },
  ]));
}

async function newProjectSheet() {
  const count = (await db.listProjects()).length;
  let aspect = '9:16';
  const name = h('input', { type: 'text', value: `Proyecto ${count + 1}` });
  const body = h('div', null,
    h('div.field', null, h('label', null, 'Nombre'), name),
    h('div.field', null, h('label', null, 'Formato'),
      ui.chips(Object.entries(M.ASPECTS).map(([k, a]) => [k, a.label]), aspect, (v) => (aspect = v))),
    h('div.row.end', null, h('button.primary-btn', {
      onclick: async () => {
        const p = M.newProject(name.value.trim() || `Proyecto ${count + 1}`, aspect);
        await db.putProject(p);
        ui.closeSheet();
        openProject(p.id);
      },
    }, 'Crear')));
  ui.openSheet('Nuevo proyecto', body);
}

// ---- editor screen -------------------------------------------------------

async function openProject(id) {
  const p = await db.getProject(id);
  if (!p) return;
  app.project = p;
  app.selectedId = null;
  app.undoStack = [];
  app.redoStack = [];
  await media.loadProject(id, () => {
    if (app.project === p) { app.timeline.render(); if (app.engine.playing) app.engine.invalidate(); }
  });
  $('#home').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  $('#btn-rename').textContent = p.name;
  app.engine.setProject(p);
  layoutPreview();
  app.timeline.render();
  renderToolbar();
  updateTime(0);
  updateUndo();
  ui.pushLayer(closeEditor);
}

function closeEditor() {
  app.engine.pause();
  saveNow();
  $('#editor').classList.add('hidden');
  $('#home').classList.remove('hidden');
  app.project = null;
  app.engine.project = null;
  app.engine.sweep();
  media.unloadAll();
  renderProjects();
}

async function renameProject() {
  const name = await ui.ask('Nombre del proyecto', app.project.name);
  if (name) {
    app.project.name = name;
    $('#btn-rename').textContent = name;
    save();
  }
}

function layoutPreview() {
  const p = app.project;
  if (!p) return;
  const wrap = $('#preview-wrap');
  const canvas = $('#preview');
  const a = M.ASPECTS[p.aspect];
  const W = wrap.clientWidth - 16, H = wrap.clientHeight - 16;
  if (W <= 0 || H <= 0) return;
  const s = Math.min(W / a.w, H / a.h);
  const cw = Math.floor(a.w * s), ch = Math.floor(a.h * s);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const k = Math.min(dpr, 1080 / Math.min(cw, ch));
  canvas.width = Math.round(cw * k);
  canvas.height = Math.round(ch * k);
  app.engine.requestDraw();
}

function updateTime(t) {
  if (!app.project) return;
  $('#time').textContent = `${fmtTime(t)} / ${fmtTime(app.engine.duration())}`;
}

function updateUndo() {
  $('#btn-undo').disabled = !app.undoStack.length;
  $('#btn-redo').disabled = !app.redoStack.length;
}

function undo() {
  if (!app.undoStack.length) return;
  app.redoStack.push(M.snapshot(app.project));
  M.restore(app.project, app.undoStack.pop());
  afterRestore();
}

function redo() {
  if (!app.redoStack.length) return;
  app.undoStack.push(M.snapshot(app.project));
  M.restore(app.project, app.redoStack.pop());
  afterRestore();
}

function afterRestore() {
  updateUndo();
  layoutPreview();
  app.changed();
}

const saveNow = async () => {
  const p = app.project;
  if (!p) return;
  p.updatedAt = Date.now();
  p.thumb = projectThumb(p);
  try { await db.putProject(p); } catch (e) { ui.toast('No se pudo guardar: ' + e.message); }
};
const save = debounce(saveNow, 400);

function projectThumb(p) {
  const tracks = [...p.tracks].reverse();
  for (const tr of tracks) {
    if (tr.type !== 'video') continue;
    const c = [...tr.clips].sort((a, b) => a.start - b.start)[0];
    const a = c && media.getAsset(c.mediaId);
    if (a && a.thumb) return a.thumb;
  }
  return null;
}

// ---- toolbar ---------------------------------------------------------------

function tool(name, label, onclick, opts = {}) {
  return h(`button.tool${opts.danger ? '.danger' : ''}`, { onclick, disabled: opts.disabled }, icon(name), label);
}

function selected() {
  return app.selectedId ? M.findClip(app.project, app.selectedId) : null;
}

function renderToolbar() {
  const bar = $('#toolbar');
  bar.textContent = '';
  const sel = selected();
  if (!sel) {
    bar.append(
      tool('add', 'Añadir', () => pickAndImport('video/*,image/*', 'main')),
      tool('folder', 'Medios', openBin),
      tool('music', 'Audio', () => pickAndImport('audio/*', 'audio')),
      tool('text', 'Texto', addText),
      tool('aspect', 'Formato', formatSheet),
      tool('layers', 'Pistas', tracksSheet),
    );
    return;
  }
  const c = sel.clip;
  const visual = c.kind !== 'audio';
  bar.append(...[
    tool('check', 'Listo', () => app.select(null)),
    tool('split', 'Dividir', splitAtPlayhead),
    c.kind === 'text' && tool('edit', 'Editar', () => textSheet(c)),
    M.hasAudio(c) && tool('speed', 'Velocidad', () => speedSheet(sel)),
    M.hasAudio(c) && tool('volume', 'Volumen', () => volumeSheet(c)),
    tool('fade', 'Fundidos', () => fadeSheet(c)),
    visual && tool('transform', 'Ajuste', () => transformSheet(c)),
    (c.kind === 'video' || c.kind === 'image') && tool('color', 'Color', () => colorSheet(c)),
    tool('copy', 'Duplicar', () => duplicate(sel)),
    tool('delete', 'Eliminar', () => removeSelected(false), { danger: true }),
    tool('magnet', 'Quitar hueco', () => removeSelected(true), { danger: true }),
  ].filter(Boolean));
}

// ---- importing -------------------------------------------------------------

function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = $('#file-input');
    input.accept = accept;
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

async function pickAndImport(accept, mode) {
  const files = await pickFiles(accept);
  if (files.length) await importFiles(files, mode);
}

function mainVideoTrack() {
  const vids = app.project.tracks.filter((t) => t.type === 'video');
  return vids[vids.length - 1] || M.addTrack(app.project, 'video');
}

/** Puts a clip at t on the first track of `type` that is free there. */
function placeFree(type, clip, t) {
  const p = app.project;
  const a = t, b = t + M.dur(clip);
  let track = p.tracks.find((tr) => tr.type === type &&
    !tr.clips.some((c) => c.start < b - 1e-6 && M.end(c) > a + 1e-6));
  if (!track) track = M.addTrack(p, type);
  clip.start = t;
  track.clips.push(clip);
  M.sortTrack(track);
  return track;
}

function clipFromAsset(asset, from = 0, to = null) {
  return M.newClip(asset.kind, {
    mediaId: asset.id,
    in: asset.kind === 'image' ? 0 : from,
    out: asset.kind === 'image' ? (to || M.IMAGE_DEFAULT) : (to ?? asset.duration),
  });
}

async function importFiles(files, mode) {
  const p = app.project;
  const added = [];
  for (let i = 0; i < files.length; i++) {
    ui.toast(`Importando ${files.length > 1 ? `${i + 1}/${files.length}` : ''}… ${files[i].name}`, 60000);
    try {
      added.push(await media.importFile(p.id, files[i]));
    } catch (e) {
      ui.toast(e.message || String(e), 4000);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (app.project !== p) return added;
  if (added.length) ui.toast(added.length === 1 ? 'Archivo añadido' : `${added.length} archivos añadidos`);
  if (mode === 'bin' || !added.length) return added;
  app.commit();
  let t = app.engine.t;
  for (const asset of added) {
    const clip = clipFromAsset(asset);
    if (asset.kind === 'audio') {
      placeFree('audio', clip, t);
      t += M.dur(clip);
    } else {
      M.appendClip(mainVideoTrack(), clip);
    }
  }
  app.changed();
  return added;
}

// ---- editing actions ---------------------------------------------------------

function splitAtPlayhead() {
  const t = app.engine.t;
  const sel = selected();
  if (sel) {
    if (t <= sel.clip.start || t >= M.end(sel.clip)) return ui.toast('Pon el cursor dentro del clip seleccionado');
    app.commit();
    M.splitClip(sel.track, sel.clip, t);
    return app.changed();
  }
  const targets = [];
  for (const tr of app.project.tracks) for (const c of tr.clips) if (c.start < t && M.end(c) > t) targets.push([tr, c]);
  if (!targets.length) return ui.toast('No hay ningún clip bajo el cursor');
  app.commit();
  for (const [tr, c] of targets) M.splitClip(tr, c, t);
  app.changed();
}

function removeSelected(ripple) {
  const sel = selected();
  if (!sel) return;
  app.commit();
  M.removeClip(sel.track, sel.clip, ripple);
  app.selectedId = null;
  app.changed();
}

function duplicate(sel) {
  app.commit();
  const copy = { ...JSON.parse(JSON.stringify(sel.clip)), id: uid() };
  M.insertClip(sel.track, copy, M.end(sel.clip));
  app.selectedId = copy.id;
  app.changed();
}

function addText() {
  app.commit();
  const clip = M.newClip('text');
  placeFree('text', clip, app.engine.t);
  app.selectedId = clip.id;
  app.changed();
  textSheet(clip);
}

// Live-edit helpers for property sheets: the first change of a gesture makes
// an undo step; later ones only refresh.
function liveSlider(label, c, key, opts) {
  return ui.slider(label, {
    ...opts,
    value: c[key] ?? (key === 'sepia' ? 0 : 1),
    onStart: () => app.commit(),
    onInput: (v) => {
      c[key] = v;
      opts.after ? opts.after(v) : refresh();
    },
  });
}

const refresh = debounce(() => app.changed(), 120);
const redraw = () => { app.engine.invalidate(); save(); };

function speedSheet(sel) {
  const c = sel.clip;
  const body = h('div', null,
    ui.slider('Velocidad', {
      min: 0.25, max: 4, step: 0.05, value: c.speed, fmt: (v) => `${v.toFixed(2)}x`,
      onStart: () => app.commit(),
      onInput: (v) => { M.setSpeed(sel.track, c, v); refresh(); },
    }),
    h('p.note', null, 'Los clips que van detrás en la misma pista se desplazan para dejar sitio. El tono del audio cambia con la velocidad.'));
  ui.openSheet('Velocidad', body);
}

function volumeSheet(c) {
  const body = h('div', null,
    liveSlider('Volumen', c, 'volume', { min: 0, max: 2, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, after: redraw }),
    h('div.row', null,
      h('button.secondary-btn', { onclick: () => { app.commit(); c.volume = 0; app.changed(); volumeSheet(c); } }, 'Silenciar'),
      h('button.secondary-btn', { onclick: () => { app.commit(); c.volume = 1; app.changed(); volumeSheet(c); } }, '100%')));
  ui.openSheet('Volumen', body);
}

function fadeSheet(c) {
  const max = Math.max(0.1, Math.min(5, M.dur(c) / 2));
  const body = h('div', null,
    liveSlider('Fundido de entrada', c, 'fadeIn', { min: 0, max, step: 0.05, fmt: (v) => `${v.toFixed(2)} s`, after: redraw }),
    liveSlider('Fundido de salida', c, 'fadeOut', { min: 0, max, step: 0.05, fmt: (v) => `${v.toFixed(2)} s`, after: redraw }),
    h('p.note', null, c.kind === 'audio' ? 'Sube y baja el volumen suavemente.' : 'La imagen aparece y desaparece desde negro; el sonido también se funde.'));
  ui.openSheet('Fundidos', body);
}

/** Slider for an animatable property, with a keyframe (◆) toggle. */
function animSlider(label, c, prop, opts) {
  const now = () => clamp(app.engine.t, c.start, M.end(c) - 0.001);
  const diamond = h('button.kf-btn', { 'aria-label': 'Fotograma clave', title: 'Fotograma clave' }, '◆');
  const paint = () => {
    diamond.classList.toggle('on', !!M.keyAt(c, prop, now()));
    diamond.classList.toggle('anim', M.isAnimated(c, prop));
  };
  const field = ui.slider(label, {
    ...opts,
    value: M.propAt(c, prop, now()),
    onStart: () => app.commit(),
    onInput: (v) => { M.setProp(c, prop, now(), v); paint(); redraw(); },
  });
  diamond.onclick = () => {
    app.commit();
    const t = now();
    if (M.keyAt(c, prop, t)) M.removeKey(c, prop, t);
    else M.setKey(c, prop, t, M.propAt(c, prop, t));
    paint();
    app.changed();
  };
  field.querySelector('.field-label').insertBefore(diamond, field.querySelector('.field-label b'));
  paint();
  return field;
}

function transformSheet(c) {
  const pct = (v) => `${Math.round(v * 100)}`;
  const body = h('div', null,
    c.kind !== 'text' && h('div.field', null, h('label', null, 'Encuadre'),
      ui.chips([['contain', 'Ajustar'], ['cover', 'Rellenar']], c.fit, (v) => { app.commit(); c.fit = v; redraw(); })),
    animSlider('Escala', c, 'scale', { min: 0.1, max: 3, step: 0.01, fmt: (v) => `${pct(v)}%` }),
    animSlider('Posición horizontal', c, 'x', { min: -1, max: 1, step: 0.005, fmt: pct }),
    animSlider('Posición vertical', c, 'y', { min: -1, max: 1, step: 0.005, fmt: pct }),
    animSlider('Rotación', c, 'rotation', { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` }),
    animSlider('Opacidad', c, 'opacity', { min: 0, max: 1, step: 0.01, fmt: (v) => `${pct(v)}%` }),
    h('p.note', null, 'Arrastra el clip en la vista previa para moverlo y pellizca para cambiar su tamaño. ',
      'Para animar: pon el cursor, toca ◆ para crear un fotograma clave, mueve el cursor y cambia el valor; se crea otro y Montaje interpola entre ellos.'),
    h('div.row.end', null, h('button.secondary-btn', {
      onclick: () => {
        app.commit();
        Object.assign(c, { scale: 1, x: 0, y: c.kind === 'text' ? 0.3 : 0, rotation: 0, opacity: 1, kf: {} });
        app.changed();
        transformSheet(c);
      },
    }, 'Restablecer')));
  ui.openSheet('Ajuste y animación', body);
}

const LOOKS = {
  normal: { label: 'Normal', brightness: 1, contrast: 1, saturation: 1, sepia: 0 },
  vivid: { label: 'Vívido', brightness: 1.05, contrast: 1.15, saturation: 1.45, sepia: 0 },
  bw: { label: 'B/N', brightness: 1, contrast: 1.2, saturation: 0, sepia: 0 },
  vintage: { label: 'Vintage', brightness: 1.05, contrast: 0.9, saturation: 0.8, sepia: 0.45 },
  cine: { label: 'Cine', brightness: 0.95, contrast: 1.25, saturation: 0.85, sepia: 0.1 },
};

function colorSheet(c) {
  const body = h('div', null,
    !canFilter && h('p.note', null, 'Este dispositivo no admite ajustes de color en el navegador. Actualiza el sistema para usarlos.'),
    h('div.field', null, h('label', null, 'Estilo'),
      ui.chips(Object.entries(LOOKS).map(([k, l]) => [k, l.label]), null, (k) => {
        app.commit();
        const { label, ...vals } = LOOKS[k];
        Object.assign(c, vals);
        redraw();
        colorSheet(c);
      })),
    liveSlider('Brillo', c, 'brightness', { min: 0.3, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, after: redraw }),
    liveSlider('Contraste', c, 'contrast', { min: 0.3, max: 2, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, after: redraw }),
    liveSlider('Saturación', c, 'saturation', { min: 0, max: 2.5, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, after: redraw }),
    liveSlider('Tono sepia', c, 'sepia', { min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, after: redraw }));
  if (c.sepia == null) c.sepia = 0;
  ui.openSheet('Color', body);
}

const COLORS = ['#ffffff', '#000000', '#ffd400', '#ff4d4d', '#4da3ff', '#3ddc84', '#ff8ad8'];

function textSheet(c) {
  const area = h('textarea', { value: c.text });
  let started = false;
  area.addEventListener('input', () => {
    if (!started) { app.commit(); started = true; }
    c.text = area.value;
    redraw();
    refresh();
  });
  const colorRow = (key) => h('div.row', null,
    COLORS.map((col) => h('button.chip', {
      style: { background: col, width: '34px', height: '34px', padding: 0, border: c[key] === col ? '2px solid var(--accent)' : '1px solid #555' },
      onclick: () => { app.commit(); c[key] = col; redraw(); textSheet(c); },
    })),
    h('input', { type: 'color', value: c[key], oninput: (e) => { c[key] = e.target.value; redraw(); }, onchange: () => save() }));
  const body = h('div', null,
    h('div.field', null, area),
    liveSlider('Tamaño', c, 'size', { min: 0.02, max: 0.2, step: 0.002, fmt: (v) => Math.round(v * 1000), after: redraw }),
    h('div.field', null, h('label', null, 'Color'), colorRow('color')),
    h('label.check', null, h('input', { type: 'checkbox', checked: c.outline, onchange: (e) => { app.commit(); c.outline = e.target.checked; redraw(); } }), 'Contorno'),
    h('label.check', null, h('input', { type: 'checkbox', checked: c.box, onchange: (e) => { app.commit(); c.box = e.target.checked; redraw(); textSheet(c); } }), 'Fondo detrás del texto'),
    c.box && h('div.field', null, h('label', null, 'Color del fondo'), colorRow('boxColor')));
  ui.openSheet('Texto', body);
}

function formatSheet() {
  const p = app.project;
  const body = h('div', null,
    h('div.field', null, h('label', null, 'Formato del vídeo'),
      ui.chips(Object.entries(M.ASPECTS).map(([k, a]) => [k, a.label]), p.aspect, (v) => {
        app.commit();
        p.aspect = v;
        layoutPreview();
        app.changed();
      })),
    h('div.field', null, h('label', null, 'Color de fondo'),
      h('div.row', null, ['#000000', '#ffffff', '#1d2b53', '#3a0d0d'].map((col) => h('button.chip', {
        style: { background: col, width: '34px', height: '34px', padding: 0, border: '1px solid #555' },
        onclick: () => { app.commit(); p.bg = col; redraw(); },
      })), h('input', { type: 'color', value: p.bg, oninput: (e) => { p.bg = e.target.value; redraw(); } }))));
  ui.openSheet('Formato', body);
}

function tracksSheet() {
  const add = (type) => () => {
    app.commit();
    M.addTrack(app.project, type);
    app.changed();
    ui.closeSheet();
  };
  ui.openSheet('Pistas', h('div', null,
    ui.menu([
      { icon: 'movie', label: 'Añadir pista de vídeo', sub: 'Para superponer vídeos o fotos (picture-in-picture)', onclick: add('video') },
      { icon: 'music', label: 'Añadir pista de audio', sub: 'Música, voces o efectos', onclick: add('audio') },
      { icon: 'text', label: 'Añadir pista de texto', onclick: add('text') },
    ]),
    h('p.note', null, 'Toca el nombre de una pista (V1, A1…) para silenciarla, ocultarla o eliminarla. Las pistas de arriba se dibujan encima.')));
}

function trackMenu(trackId) {
  const p = app.project;
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const sameType = p.tracks.filter((t) => t.type === track.type).length;
  const toggle = (key) => () => { app.commit(); track[key] = !track[key]; app.changed(); ui.closeSheet(); };
  const idx = p.tracks.indexOf(track);
  const move = (dir) => () => {
    const j = idx + dir;
    if (j < 0 || j >= p.tracks.length) return;
    app.commit();
    [p.tracks[idx], p.tracks[j]] = [p.tracks[j], p.tracks[idx]];
    app.changed();
    ui.closeSheet();
  };
  ui.openSheet(`Pista ${track.name}`, ui.menu([
    track.type !== 'text' && { icon: 'volume', label: track.muted ? 'Activar sonido' : 'Silenciar pista', onclick: toggle('muted') },
    track.type !== 'audio' && { icon: 'layers', label: track.hidden ? 'Mostrar pista' : 'Ocultar pista', onclick: toggle('hidden') },
    idx > 0 && { icon: 'layers', label: 'Subir pista', sub: 'Se dibuja por encima', onclick: move(-1) },
    idx < p.tracks.length - 1 && { icon: 'layers', label: 'Bajar pista', onclick: move(1) },
    sameType > 1 && { icon: 'delete', label: 'Eliminar pista', danger: true, onclick: async () => {
      if (track.clips.length && !(await ui.confirmSheet('¿Eliminar pista?', `La pista ${track.name} tiene ${track.clips.length} clip(s).`))) return;
      app.commit();
      p.tracks.splice(p.tracks.indexOf(track), 1);
      app.changed();
      if (ui.isSheetOpen()) ui.closeSheet();
    } },
  ]));
}

// ---- media bin & source monitor (three-point editing) ------------------------

function openBin() {
  const assets = media.allAssets();
  const grid = h('div.bin');
  for (const a of assets) {
    grid.append(h('button.bin-item', { onclick: () => openMonitor(a) },
      h('div.thumb', { style: a.thumb ? { backgroundImage: `url("${a.thumb}")` } : null },
        a.thumb ? null : icon(a.kind === 'audio' ? 'music' : a.kind === 'image' ? 'image' : 'movie', 32)),
      a.kind !== 'image' && h('span.dur', null, fmtTime(a.duration, false)),
      h('div.cap', null, a.name)));
  }
  const body = h('div', null,
    h('div.row', { style: { marginBottom: '12px' } },
      h('button.primary-btn', { onclick: async () => {
        const files = await pickFiles('video/*,image/*,audio/*');
        if (files.length) { await importFiles(files, 'bin'); if (ui.isSheetOpen()) openBin(); }
      } }, '+ Importar')),
    assets.length ? grid : h('p.note', null, 'Aún no hay medios en este proyecto.'),
    assets.length ? h('p.note', null, 'Toca un medio para elegir el fragmento (entrada y salida) e insertarlo o sobrescribir en la posición del cursor.') : null);
  ui.openSheet('Medios del proyecto', body);
}

function openMonitor(asset) {
  const p = app.project;
  let inP = 0;
  let outP = asset.kind === 'image' ? M.IMAGE_DEFAULT : asset.duration;
  const tracks = p.tracks.filter((t) => M.trackAccepts(t, asset.kind));
  let target = asset.kind === 'audio' ? tracks[0] : mainVideoTrack();
  let player = null;
  const marks = h('div.marks');
  const showMarks = () => {
    marks.textContent = '';
    marks.append(
      h('div', null, 'Entrada', h('b', null, fmtTime(inP))),
      h('div', null, 'Salida', h('b', null, fmtTime(outP))),
      h('div', null, 'Duración', h('b', null, fmtTime(outP - inP))));
  };
  let monitor;
  if (asset.kind === 'image') {
    monitor = h('div.monitor', null, h('img', { src: asset.url, alt: '' }),
      ui.slider('Duración', { min: 0.5, max: 20, step: 0.5, value: outP, fmt: (v) => `${v} s`, onInput: (v) => { outP = v; showMarks(); } }));
  } else {
    player = h('video', { src: asset.url, controls: true, playsInline: true, preload: 'auto' });
    player.setAttribute('playsinline', '');
    if (asset.kind === 'audio' && asset.wave) player.poster = asset.wave;
    monitor = h('div.monitor', null, player,
      h('div.row', { style: { marginTop: '10px' } },
        h('button.secondary-btn', { onclick: () => {
          inP = Math.min(player.currentTime, asset.duration - M.MIN_CLIP);
          if (outP <= inP + M.MIN_CLIP) outP = asset.duration;
          showMarks();
        } }, '[ Marcar entrada'),
        h('button.secondary-btn', { onclick: () => {
          outP = Math.max(player.currentTime, M.MIN_CLIP);
          if (outP <= inP + M.MIN_CLIP) inP = 0;
          showMarks();
        } }, 'Marcar salida ]')));
  }
  showMarks();
  const place = (how) => () => {
    if (!target) target = M.addTrack(p, asset.kind === 'audio' ? 'audio' : 'video');
    app.commit();
    const clip = clipFromAsset(asset, inP, outP);
    const t = app.engine.t;
    if (how === 'insert') M.insertClip(target, clip, t);
    else if (how === 'overwrite') M.overwriteClip(target, clip, t);
    else M.appendClip(target, clip);
    app.changed();
    ui.closeSheet();
    ui.toast(`${how === 'insert' ? 'Insertado' : how === 'overwrite' ? 'Sobrescrito' : 'Añadido'} en ${target.name} · ${fmtTime(clip.start)}`);
  };
  const body = h('div', null, monitor, marks,
    tracks.length > 1 && h('div.field', null, h('label', null, 'Pista de destino'),
      ui.chips(tracks.map((t) => [t.id, t.name]), target && target.id, (id) => (target = tracks.find((t) => t.id === id)))),
    h('div.row', null,
      h('button.primary-btn', { onclick: place('insert') }, 'Insertar'),
      h('button.secondary-btn', { onclick: place('overwrite') }, 'Sobrescribir'),
      h('button.secondary-btn', { onclick: place('append') }, 'Al final')),
    h('p.note', null, `«Insertar» abre hueco en ${fmtTime(app.engine.t)} y desplaza lo que hay detrás; «Sobrescribir» reemplaza lo que haya en ese tramo.`),
    h('div.row.end', null, h('button.secondary-btn', { style: { color: 'var(--danger)' }, onclick: async () => {
      const used = p.tracks.reduce((n, t) => n + t.clips.filter((c) => c.mediaId === asset.id).length, 0);
      const ok = await ui.confirmSheet('¿Quitar del proyecto?', used ? `Se quitarán también ${used} clip(s) que lo usan.` : 'El archivo se quitará de este proyecto.', 'Quitar');
      if (!ok) return;
      app.commit();
      for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== asset.id);
      await media.removeAsset(asset.id);
      app.changed();
    } }, 'Quitar del proyecto')));
  ui.openSheet(asset.name, body, { onClose: () => player && player.pause() });
}

// ---- preview gestures: drag to move, pinch to scale ---------------------------

function setupPreviewGestures() {
  const canvas = $('#preview');
  const pts = new Map();
  let g = null;
  const activeVisual = () => {
    const sel = selected();
    if (!sel || sel.clip.kind === 'audio') return null;
    const t = app.engine.t;
    return t >= sel.clip.start && t < M.end(sel.clip) ? sel.clip : null;
  };
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const c = activeVisual();
    const t = app.engine.t;
    if (pts.size === 1) g = { c, x0: e.clientX, y0: e.clientY, cx: c && M.propAt(c, 'x', t), cy: c && M.propAt(c, 'y', t), moved: false, committed: false };
    else if (pts.size === 2 && g && g.c) Object.assign(g, { pinch: true, d0: dist(), s0: M.propAt(g.c, 'scale', t), moved: true });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = canvas.getBoundingClientRect();
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > 6) g.moved = true;
    if (!g.moved || !g.c || app.engine.playing) return;
    if (!g.committed) { app.commit(); g.committed = true; }
    const t = app.engine.t;
    if (g.pinch && pts.size === 2) {
      M.setProp(g.c, 'scale', t, clamp(g.s0 * (dist() / g.d0), 0.05, 8));
    } else if (!g.pinch) {
      M.setProp(g.c, 'x', t, clamp(g.cx + dx / r.width, -1.5, 1.5));
      M.setProp(g.c, 'y', t, clamp(g.cy + dy / r.height, -1.5, 1.5));
    }
    app.engine.requestDraw();
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size || !g) return;
    if (!g.moved) app.engine.toggle();
    else if (g.committed) { save(); app.timeline.render(); }
    g = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

// ---- export ----------------------------------------------------------------

let exporting = false;

function exportSheet() {
  const p = app.project;
  app.engine.pause();
  const total = app.engine.duration();
  if (!total) return ui.toast('El proyecto está vacío');
  const mime = pickMimeType();
  const canRecord = mime && HTMLCanvasElement.prototype.captureStream;
  if (!canRecord) {
    return ui.openSheet('Exportar', h('p.note', null, 'Este dispositivo no permite grabar vídeo desde el navegador. Actualiza el sistema o usa la app instalada.'));
  }
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  // Destination presets, like the export panel of a desktop editor.
  const PRESETS = {
    file: { label: 'Archivo 1080p', short: 1080 },
    light: { label: 'Archivo 720p (ligero)', short: 720 },
    tiktok: { label: 'TikTok · Reels · Shorts', short: 1080, aspect: '9:16' },
    youtube: { label: 'YouTube', short: 1080, aspect: '16:9' },
    instagram: { label: 'Instagram (feed)', short: 1080, aspect: '4:5' },
  };
  let preset = 'file';
  const info = h('p.note');
  const go = h('button.primary-btn');
  const paint = () => {
    const pr = PRESETS[preset];
    const [w, hh] = app.engine.sizeFor(pr.short);
    const change = pr.aspect && pr.aspect !== p.aspect;
    info.textContent = change
      ? `Este destino usa formato ${pr.aspect}; el proyecto es ${p.aspect}. Se cambiará el formato del proyecto (puedes deshacerlo).`
      : `${w}×${hh} · ${ext.toUpperCase()} · ${p.fps} fps · ${fmtTime(total)}`;
    go.textContent = change ? `Cambiar a ${pr.aspect} y exportar` : 'Exportar vídeo';
  };
  go.onclick = () => {
    const pr = PRESETS[preset];
    if (pr.aspect && pr.aspect !== p.aspect) {
      app.commit();
      p.aspect = pr.aspect;
      layoutPreview();
      app.changed();
    }
    runExport(pr.short, mime, ext);
  };
  const body = h('div', null,
    h('div.field', null, h('label', null, 'Destino'),
      ui.chips(Object.entries(PRESETS).map(([k, v]) => [k, v.label]), preset, (v) => { preset = v; paint(); })),
    info,
    h('p.note', null, 'La exportación tarda lo mismo que dura el vídeo. Mantén la pantalla encendida y la app abierta.'),
    h('div.row.end', null, go));
  paint();
  ui.openSheet('Exportar', body);
}

async function runExport(short, mime, ext) {
  const engine = app.engine;
  const [w, hgt] = engine.sizeFor(short);
  const canvas = h('canvas', { width: w, height: hgt });
  const bar = h('div');
  const pct = h('span', null, '0%');
  const ctrl = new AbortController();
  let finished = false;
  const view = h('div.export-view', null, canvas,
    h('div.progress', null, bar),
    h('div.row', null, h('span.note', { style: { flex: 1 } }, 'Exportando… ', pct),
      h('button.secondary-btn', { onclick: () => ui.closeSheet() }, 'Cancelar')));
  ui.openSheet('Exportando', view, { onClose: () => { if (!finished) ctrl.abort(); } });
  exporting = true;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  let blob = null;
  try {
    blob = await engine.exportVideo(canvas, {
      mimeType: mime,
      bitrate: short >= 1080 ? 12_000_000 : 6_000_000,
      signal: ctrl.signal,
      onProgress: (f) => { bar.style.width = `${f * 100}%`; pct.textContent = `${Math.round(f * 100)}%`; },
    });
  } catch (e) {
    ui.toast('Error al exportar: ' + (e.message || e), 5000);
  } finally {
    exporting = false;
    finished = true;
    try { lock && lock.release(); } catch {}
  }
  if (!blob || !blob.size || !ui.isSheetOpen()) return;
  showResult(blob, ext);
}

function showResult(blob, ext) {
  const safe = app.project.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'video';
  const name = `${safe}.${ext}`;
  const url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: blob.type });
  const mb = (blob.size / 1048576).toFixed(1);
  const actions = h('div.row');
  if (isNative()) {
    actions.append(h('button.primary-btn', { onclick: () => saveNative(blob, name) },
      platform() === 'ios' ? 'Guardar / Compartir' : 'Guardar / Compartir'));
  } else {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      actions.append(h('button.primary-btn', {
        onclick: () => navigator.share({ files: [file], title: name }).catch(() => {}),
      }, 'Guardar / Compartir'));
    }
    actions.append(h('a.secondary-btn', { href: url, download: name, style: { textDecoration: 'none' } }, 'Descargar'));
  }
  const video = h('video', { src: url, controls: true, playsInline: true });
  video.setAttribute('playsinline', '');
  ui.openSheet('Vídeo listo', h('div.export-view', null, video,
    h('p.note', null, `${name} · ${mb} MB`), actions,
    platform() === 'ios' || /iPhone|iPad/.test(navigator.userAgent)
      ? h('p.note', null, 'En el menú de compartir, elige «Guardar vídeo» para llevarlo a Fotos.') : null),
  { onClose: () => { video.pause(); setTimeout(() => URL.revokeObjectURL(url), 60000); } });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Writes the video to the app cache in chunks and opens the share sheet. */
async function saveNative(blob, name) {
  try {
    ui.toast('Preparando el archivo…', 60000);
    const path = `exports/${Date.now()}-${name}`;
    const CHUNK = 3 * 1024 * 1024; // multiple of 3 so base64 chunks concatenate cleanly
    for (let off = 0; off < blob.size; off += CHUNK) {
      const data = await blobToBase64(blob.slice(off, off + CHUNK));
      if (off === 0) await nativeCall('Filesystem', 'writeFile', { path, data, directory: 'CACHE', recursive: true });
      else await nativeCall('Filesystem', 'appendFile', { path, data, directory: 'CACHE' });
    }
    const { uri } = await nativeCall('Filesystem', 'getUri', { path, directory: 'CACHE' });
    ui.toast('Listo', 800);
    await nativeCall('Share', 'share', { title: name, files: [uri], dialogTitle: 'Guardar o compartir el vídeo' });
  } catch (e) {
    if (!/cancel/i.test(String(e && e.message))) ui.toast('No se pudo guardar: ' + (e.message || e), 5000);
  }
}

init();
