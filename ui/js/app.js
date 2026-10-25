// Entry point: routing between screens, loading documents, recent files,
// theme, and OS-level file drops.

import { h, icon, basename } from './dom.js';
import * as backend from './backend.js';
import { openPdf, PasswordCancelled } from './pdf.js';
import { toast, toastError, askPassword, confirmDialog, withBusy } from './ui.js';
import { homeScreen } from './screens/home.js';
import { multiScreen } from './screens/multi.js';
import { editorScreen } from './screens/editor.js';
import { mergeScreen } from './screens/merge.js';
import { splitScreen } from './screens/split.js';

const SCREENS = { home: homeScreen, multi: multiScreen, editor: editorScreen, merge: mergeScreen, split: splitScreen };
const RECENT_KEY = 'lembar.recent';
const MAX_RECENT = 30;

let current = null; // { name, el, dispose, docs, onDrop, isDirty }
let liveDocs = new Set();

export const app = {
  /** Switches screen. `docs` are loaded documents the screen will own. */
  async go(name, params = {}) {
    if (current?.isDirty?.() && !params.force) {
      const ok = await confirmDialog({
        title: 'Buang perubahan?',
        message: 'Perubahan yang belum disimpan akan hilang.',
        confirm: 'Buang',
        danger: true,
      });
      if (!ok) return false;
    }
    current?.dispose?.();
    const root = document.getElementById('app');
    const screen = SCREENS[name](params, app);
    root.replaceChildren(screen.el);
    current = { name, ...screen };
    const keep = new Set(screen.docs || []);
    for (const d of liveDocs) if (!keep.has(d)) d.pdf.destroy().catch(() => {});
    liveDocs = keep;
    backend.setTitle(screen.title ? `${screen.title} — Lembar` : 'Lembar');
    screen.mounted?.();
    return true;
  },

  /** Lets a screen adopt more documents (e.g. "Tambah PDF"). */
  adopt(docs) {
    for (const d of docs) liveDocs.add(d);
  },

  release(doc) {
    if (liveDocs.delete(doc)) doc.pdf.destroy().catch(() => {});
  },

  /**
   * Loads PDFs from paths. Files that fail are reported and skipped; a
   * cancelled password prompt skips that file silently.
   */
  async loadDocs(paths) {
    const docs = [];
    const pdfPaths = paths.filter((p) => /\.pdf$/i.test(p));
    if (pdfPaths.length < paths.length) toast('Hanya file PDF yang bisa dibuka.');
    if (!pdfPaths.length) return docs;
    await withBusy(pdfPaths.length > 1 ? `Membuka ${pdfPaths.length} file…` : 'Membuka PDF…', async (setLabel) => {
      for (const [i, path] of pdfPaths.entries()) {
        if (pdfPaths.length > 1) setLabel(`Membuka ${i + 1} dari ${pdfPaths.length}…`);
        try {
          docs.push(await app.loadDoc(path));
        } catch (e) {
          if (!(e instanceof PasswordCancelled)) toastError(new Error(`${basename(path)}: ${e.message || e}`));
        }
      }
    });
    return docs;
  },

  async loadDoc(path) {
    const name = basename(path);
    const bytes = await backend.readPdf(path);
    const { doc: pdf, password } = await openPdf(bytes, (retry) => askPassword(name, retry));
    const doc = { id: crypto.randomUUID(), path, name, pdf, password, pages: pdf.numPages };
    app.remember(doc);
    return doc;
  },

  /** Opens files the way the home screen does: one → editor, several → choose. */
  async openPaths(paths, intent = 'auto') {
    const docs = await app.loadDocs(paths);
    if (!docs.length) return;
    app.adopt(docs);
    if (intent === 'merge') return app.go('merge', { docs });
    if (intent === 'split' && docs.length === 1) return app.go('split', { doc: docs[0] });
    if (docs.length === 1) return app.go('editor', { queue: docs });
    return app.go('multi', { docs });
  },

  async pickAndOpen(intent = 'auto') {
    try {
      const paths = await backend.pickPdfs();
      if (paths.length) await app.openPaths(paths, intent);
    } catch (e) {
      toastError(e);
    }
  },

  recents() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  },

  remember(doc) {
    const list = app.recents().filter((r) => r.path !== doc.path);
    list.unshift({ path: doc.path, name: doc.name, pages: doc.pages, at: Date.now() });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch (_) {}
  },

  forget(path) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(app.recents().filter((r) => r.path !== path)));
    } catch (_) {}
  },

  isDark() {
    return document.documentElement.dataset.theme === 'dark';
  },

  toggleTheme() {
    const next = app.isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('lembar.theme', next);
    } catch (_) {}
    return next;
  },
};

// ---------- OS file drops ----------

let overlay = null;
function showDropOverlay(paths) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  const hint = current?.dropHint?.(pdfs.length) || (pdfs.length > 1 ? `${pdfs.length} PDF akan dibuka` : 'PDF akan dibuka');
  if (!overlay) {
    overlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, icon('upload', 32), h('div', { class: 'msg' }), h('span', { class: 'hint' }));
    document.body.append(overlay);
  }
  overlay.querySelector('.msg').textContent = pdfs.length ? 'Lepaskan untuk membuka' : 'Hanya file PDF yang bisa dibuka';
  overlay.querySelector('.hint').textContent = pdfs.length ? hint : '';
}
function hideDropOverlay() {
  overlay?.remove();
  overlay = null;
}

backend.onFileDrop({
  enter: showDropOverlay,
  leave: hideDropOverlay,
  drop: async (paths) => {
    hideDropOverlay();
    if (!paths.length) return;
    if (document.querySelector('.modal-backdrop, .busy')) return;
    if (current?.onDrop) return current.onDrop(paths);
    app.openPaths(paths);
  },
});

backend.onOpenFiles(async () => {
  const paths = await backend.takePendingFiles();
  if (paths.length) app.openPaths(paths);
});

backend.onCloseRequested(
  () => Boolean(current?.isDirty?.()),
  () => confirmDialog({ title: 'Tutup Lembar?', message: 'Ada perubahan yang belum disimpan.', confirm: 'Tutup tanpa menyimpan', danger: true }),
);

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

// Keep the theme in sync with the OS unless the user picked one.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved = null;
  try {
    saved = localStorage.getItem('lembar.theme');
  } catch (_) {}
  if (!saved) document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
});

// Block the webview's own shortcuts that would navigate away or reload.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'F5') || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R' || e.key === 'p'))) e.preventDefault();
});
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, [contenteditable]')) e.preventDefault();
});

await app.go('home', { force: true });
if (!backend.hasBackend) toast('Mode pratinjau: buka Lembar sebagai aplikasi desktop untuk membuka file.', { ms: 8000 });
const pending = await backend.takePendingFiles().catch(() => []);
if (pending.length) app.openPaths(pending);
