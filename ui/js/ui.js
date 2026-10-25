// Shared overlays: toasts, modals, confirm and password prompts, busy state,
// and the "saved" dialog.

import { h, icon, formatBytes, dirname } from './dom.js';
import { reveal } from './backend.js';

export function toast(message, { error = false, ms = 3500 } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export const toastError = (e) => toast(e?.message || String(e), { error: true, ms: 6000 });

/**
 * Shows a modal. `build(close)` returns its content; resolves with whatever
 * is passed to close(). Escape and backdrop clicks close with `undefined`.
 */
export function modal(build, { labelledBy, dismissable = true } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy });
    box.append(...[build(close)].flat());
    const backdrop = h('div', {
      class: 'modal-backdrop',
      onMousedown: (e) => { if (dismissable && e.target === backdrop) close(undefined); },
    }, box);
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        close(undefined);
      } else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const f = [...box.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    requestAnimationFrame(() => (box.querySelector('[autofocus]') || box.querySelector('button, input'))?.focus());
  });
}

export function confirmDialog({ title, message, confirm = 'Ya', cancel = 'Batal', danger = false }) {
  return modal((close) => [
    h('div', { class: 'head' }, h('h1', { id: 'confirm-title' }, title), message && h('p', {}, message)),
    h('div', { class: 'row-end' },
      h('button', { class: 'btn tall', onClick: () => close(false) }, cancel),
      h('button', { class: `btn tall ${danger ? 'danger' : 'primary'}`, autofocus: true, onClick: () => close(true) }, confirm)),
  ], { labelledBy: 'confirm-title' }).then(Boolean);
}

export function askPassword(fileName, retry) {
  return modal((close) => {
    const input = h('input', { class: `input${retry ? ' invalid' : ''}`, type: 'password', id: 'pw', autofocus: true, autocomplete: 'off' });
    const submit = () => close(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return [
      h('div', { class: 'head' },
        h('div', { class: 'ok-badge', style: { background: 'var(--accent-soft)', color: 'var(--accent-ink)' } }, icon('lock', 26)),
        h('h1', { id: 'pw-title' }, 'PDF ini dikunci'),
        h('p', {}, `Masukkan kata sandi untuk membuka ${fileName}.`)),
      h('div', { class: 'field' },
        h('label', { for: 'pw' }, 'Kata sandi'),
        input,
        retry && h('span', { class: 'hint error' }, 'Kata sandi salah, coba lagi.')),
      h('div', { class: 'row-end' },
        h('button', { class: 'btn tall', onClick: () => close(null) }, 'Batal'),
        h('button', { class: 'btn tall primary', onClick: submit }, 'Buka')),
    ];
  }, { labelledBy: 'pw-title' }).then((v) => (v === undefined ? null : v));
}

let busyEl = null;
let busyDepth = 0;
/** Runs `task` behind a blocking "working…" overlay. */
export async function withBusy(label, task) {
  busyDepth++;
  if (!busyEl) {
    busyEl = h('div', { class: 'busy', role: 'alert', 'aria-busy': 'true' },
      h('div', { class: 'box' }, h('span', { class: 'spin' }), h('span', { class: 'label' }, label)));
    document.body.append(busyEl);
  } else {
    busyEl.querySelector('.label').textContent = label;
  }
  try {
    return await task((text) => { if (busyEl) busyEl.querySelector('.label').textContent = text; });
  } finally {
    if (--busyDepth === 0) {
      busyEl?.remove();
      busyEl = null;
    }
  }
}

/**
 * The "saved" dialog. Resolves to 'done', 'continue' or 'next'.
 * `files` are SavedFile records from the backend.
 */
export function savedDialog({ files, title = 'PDF berhasil disimpan', message, continueLabel, nextLabel }) {
  return modal((close) => {
    const list = h('div', { class: 'files' }, files.map((f) =>
      h('div', { class: 'file' },
        h('span', { style: { color: 'var(--muted)' } }, icon('file', 22)),
        h('div', { class: 'info' },
          h('b', { title: f.path }, f.name),
          h('span', {}, `${f.pages} halaman · ${formatBytes(f.bytes)}`)))));
    const showFolder = () => reveal(files[0].path).catch(() => reveal(dirname(files[0].path)).catch(toastError));
    return [
      h('div', { class: 'head' },
        h('div', { class: 'ok-badge' }, icon('check', 28, 2.2)),
        h('h1', { id: 'saved-title' }, title),
        message && h('p', {}, message)),
      list,
      h('div', { class: 'buttons' },
        nextLabel
          ? h('button', { class: 'btn tall primary block', autofocus: true, onClick: () => close('next') }, nextLabel)
          : h('button', { class: 'btn tall primary block', autofocus: true, onClick: () => close('done') }, 'Selesai'),
        h('div', { class: 'row2' },
          h('button', { class: 'btn tall', onClick: showFolder }, icon('folder', 16), 'Buka folder'),
          continueLabel
            ? h('button', { class: 'btn tall', onClick: () => close('continue') }, continueLabel)
            : h('button', { class: 'btn tall', onClick: () => close(nextLabel ? 'done' : 'continue') }, nextLabel ? 'Selesai' : 'Tutup'))),
    ];
  }, { labelledBy: 'saved-title' }).then((v) => v || 'continue');
}
