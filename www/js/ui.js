// Bottom sheets, toasts, prompts and the Android back-button stack.
import { $, h, icon } from './util.js';

// Each open layer (editor screen, sheet) owns one history entry, so the
// Android back button / back gesture closes the topmost one. Layers closed
// from the UI pop their entry with history.back(), which is asynchronous, so
// those pops are counted and new entries wait until they have happened.
const layers = [];
let pendingBacks = 0;
let queuedPushes = 0;

window.addEventListener('popstate', () => {
  if (pendingBacks > 0) {
    pendingBacks--;
    if (!pendingBacks) for (; queuedPushes > 0; queuedPushes--) history.pushState({ l: 1 }, '');
    return;
  }
  const close = layers.pop();
  if (close) close();
});

export function pushLayer(close) {
  layers.push(close);
  if (pendingBacks) queuedPushes++;
  else history.pushState({ l: 1 }, '');
}

/** Closes the topmost layer from the UI. */
export function popLayer() {
  const close = layers.pop();
  if (!close) return;
  close();
  if (queuedPushes) queuedPushes--;
  else { pendingBacks++; history.back(); }
}

let sheetOpen = false;
let sheetOnClose = null;

export function openSheet(title, body, { onClose, actions } = {}) {
  const backdrop = $('#sheet-backdrop');
  const sheet = $('#sheet');
  sheet.textContent = '';
  const head = h('div.sheet-head', null, h('h2', null, title), actions || null,
    h('button.icon-btn', { onclick: () => closeSheet(), 'aria-label': 'Cerrar' }, icon('close')));
  sheet.append(head, body);
  sheet.scrollTop = 0;
  if (sheetOpen) {
    // Replacing the content of an open sheet keeps its history entry.
    const prev = sheetOnClose;
    sheetOnClose = onClose || null;
    prev && prev();
    return;
  }
  sheetOpen = true;
  sheetOnClose = onClose || null;
  backdrop.classList.remove('hidden');
  backdrop.onpointerdown = (e) => {
    if (e.target === backdrop) closeSheet();
  };
  pushLayer(() => hideSheet());
}

function hideSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('#sheet-backdrop').classList.add('hidden');
  $('#sheet').textContent = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb && cb();
}

export function closeSheet() {
  if (sheetOpen) popLayer();
}

export const isSheetOpen = () => sheetOpen;

let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Text prompt in a sheet. Resolves with the value, or null if dismissed. */
export function ask(title, value = '', { placeholder = '', okLabel = 'Aceptar' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value, placeholder });
    const ok = () => {
      done = true;
      resolve(input.value.trim());
      closeSheet();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    const body = h('div', null, h('div.field', null, input),
      h('div.row.end', null, h('button.primary-btn', { onclick: ok }, okLabel)));
    openSheet(title, body, { onClose: () => !done && resolve(null) });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

export function confirmSheet(title, message, okLabel = 'Eliminar') {
  return new Promise((resolve) => {
    let done = false;
    const body = h('div', null, h('p.note', null, message),
      h('div.row.end', null,
        h('button.secondary-btn', { onclick: () => closeSheet() }, 'Cancelar'),
        h('button.danger-btn', { onclick: () => { done = true; resolve(true); closeSheet(); } }, okLabel)));
    openSheet(title, body, { onClose: () => !done && resolve(false) });
  });
}

/** Slider field. onInput gets the numeric value; label shows fmt(value). */
export function slider(label, { min, max, step, value, fmt = (v) => v, onInput, onStart }) {
  const out = h('b', null, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value });
  let started = false;
  input.addEventListener('input', () => {
    if (!started) { started = true; onStart && onStart(); }
    const v = parseFloat(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  input.addEventListener('change', () => (started = false));
  return h('div.field', null, h('div.field-label', null, h('span', null, label), out), input);
}

export function chips(options, value, onPick) {
  const wrap = h('div.chips');
  const render = (v) => {
    wrap.textContent = '';
    for (const [val, label] of options) {
      wrap.append(h(`button.chip${val === v ? '.on' : ''}`, { onclick: () => { onPick(val); render(val); } }, label));
    }
  };
  render(value);
  return wrap;
}

export function menu(items) {
  return h('div.menu-list', null, items.filter(Boolean).map((it) =>
    h(`button.menu-item${it.danger ? '.danger' : ''}`, { onclick: it.onclick },
      it.icon ? icon(it.icon) : null,
      h('div', null, it.label, it.sub ? h('small', null, it.sub) : null))));
}
