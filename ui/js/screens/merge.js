import { h, icon, grip, dirname, TAG_COLORS, tagLetter } from '../dom.js';
import * as backend from '../backend.js';
import { ThumbnailQueue, attachThumb } from '../pdf.js';
import { savedDialog, toastError, withBusy } from '../ui.js';
import { makeSortable, moveItem } from '../sortable.js';

export function mergeScreen({ docs: initial = [] }, app) {
  let tagCounter = 0;
  let files = [];
  let pages = [];
  let changedOrder = false;
  const thumbs = new ThumbnailQueue(3);

  const cta = h('button', { class: 'btn primary', onClick: save });
  const fileList = h('div', { class: 'scroll', role: 'list', 'aria-label': 'Urutan file' });
  const grid = h('div', { class: 'page-grid', role: 'list', 'aria-label': 'Urutan halaman hasil' });
  const nameInput = h('input', { class: 'input', id: 'merge-name', value: 'gabungan.pdf', spellcheck: false });
  const resetBtn = h('button', { class: 'btn', onClick: resetOrder, title: 'Kembalikan urutan halaman sesuai urutan file' }, icon('reset', 16), 'Atur ulang');
  const headHint = h('span', {}, 'Seret halaman untuk menyusun ulang');

  function addDocs(docs) {
    for (const doc of docs) {
      if (files.some((f) => f.doc.path === doc.path)) continue;
      const i = tagCounter++;
      const file = { doc, tag: tagLetter(i), color: TAG_COLORS[i % TAG_COLORS.length] };
      files.push(file);
      for (let p = 0; p < doc.pages; p++) pages.push({ file, page: p, key: `${doc.id}:${p}:${Math.random()}` });
    }
    render();
  }

  /** Every page of every file, in file order — removed pages come back. */
  function resetOrder() {
    pages = files.flatMap((file) =>
      Array.from({ length: file.doc.pages }, (_, p) => pages.find((x) => x.file === file && x.page === p) || { file, page: p, key: `${file.doc.id}:${p}:${Math.random()}` }));
    changedOrder = false;
    render();
  }

  function removeFile(file) {
    files = files.filter((f) => f !== file);
    pages = pages.filter((p) => p.file !== file);
    app.release(file.doc);
    render();
  }

  function render() {
    cta.replaceChildren(icon('download', 16, 2), pages.length ? `Gabungkan · ${pages.length} halaman` : 'Gabungkan');
    cta.disabled = pages.length === 0;
    resetBtn.style.visibility = changedOrder ? 'visible' : 'hidden';
    headHint.textContent = pages.length ? 'Seret halaman untuk menyusun ulang · arahkan ke halaman lalu klik × untuk membuang' : '';

    fileList.replaceChildren(
      ...files.map((f) =>
        h('div', { class: 'file-card', role: 'listitem' },
          grip(),
          h('span', { class: 'tag', style: { background: f.color } }, f.tag),
          h('div', { class: 'info' },
            h('b', { title: f.doc.path }, f.doc.name),
            h('span', {}, `${f.doc.pages} halaman`)),
          h('button', { class: 'icon-btn muted', 'aria-label': `Hapus ${f.doc.name}`, onClick: () => removeFile(f) }, icon('close', 16)))),
      h('button', { class: 'add-slot', onClick: pickMore }, icon('plus', 16, 2), 'Tambah PDF'));

    grid.replaceChildren(...pages.map((p, i) => {
      // Thumbnails are kept on the page entry so reordering never re-renders them.
      if (!p.paper) {
        p.paper = h('div', { class: 'paper' });
        attachThumb(thumbs, p.paper, p.file.doc.pdf, p.page, 124);
      }
      const paper = p.paper;
      return h('div', { class: 'page-tile', role: 'listitem', 'aria-label': `Halaman ${i + 1}: ${p.file.tag}${p.page + 1}` },
        h('div', { style: { position: 'relative' } },
          paper,
          h('span', { class: 'badge', style: { background: p.file.color } }, `${p.file.tag}${p.page + 1}`),
          h('button', {
            class: 'remove', 'aria-label': `Buang halaman ${i + 1}`,
            onClick: () => { pages = pages.filter((x) => x !== p); changedOrder = true; render(); },
          }, icon('close', 14, 2.2))),
        h('span', { class: 'num' }, i + 1));
    }));
    if (!pages.length) {
      grid.append(h('div', { class: 'recent-empty', style: { gridColumn: '1 / -1' } }, files.length ? 'Semua halaman dibuang. Klik “Atur ulang” untuk mengembalikan.' : 'Tambahkan PDF untuk mulai menggabungkan.'));
      if (files.length) resetBtn.style.visibility = 'visible';
    }
  }

  async function pickMore() {
    try {
      const paths = await backend.pickPdfs();
      if (!paths.length) return;
      const docs = await app.loadDocs(paths);
      app.adopt(docs);
      addDocs(docs);
    } catch (e) {
      toastError(e);
    }
  }

  async function save() {
    if (!pages.length) return;
    try {
      const used = files.filter((f) => pages.some((p) => p.file === f));
      const dest = await backend.pickSavePath(nameInput.value.trim() || 'gabungan.pdf', dirname(used[0].doc.path));
      if (!dest) return;
      const inputs = used.map((f) => ({ path: f.doc.path, password: f.doc.password }));
      const order = pages.map((p) => ({ source: used.indexOf(p.file), page: p.page }));
      const file = await withBusy('Menggabungkan PDF…', () => backend.mergePdfs(inputs, order, dest));
      const choice = await savedDialog({ files: [file], message: `${used.length} file digabung. File asli tidak diubah.` });
      if (choice === 'done') app.go('home');
    } catch (e) {
      toastError(e);
    }
  }

  const el = h('div', { class: 'screen' },
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Kembali ke beranda', onClick: () => app.go('home') }, icon('back')),
      h('span', { class: 'title grow' }, 'Gabung PDF'),
      cta),
    h('div', { class: 'split-layout' },
      h('aside', { class: 'side', style: { overflow: 'hidden' } },
        h('h2', {}, 'File (urutan digabung)'),
        fileList,
        h('div', { class: 'foot field' },
          h('label', { for: 'merge-name' }, 'Nama file hasil'),
          nameInput)),
      h('section', { class: 'stage' },
        h('div', { class: 'stage-head' },
          h('h2', {}, 'Urutan halaman hasil'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, headHint, resetBtn)),
        h('div', { class: 'stage-body' }, grid))));

  const unsortFiles = makeSortable(fileList, {
    items: '.file-card',
    axis: 'y',
    onMove: (from, to) => {
      files = moveItem(files, from, to);
      // Keep each file's pages together, in the new file order.
      pages = files.flatMap((f) => pages.filter((p) => p.file === f));
      render();
    },
  });
  const unsortPages = makeSortable(grid, {
    items: '.page-tile',
    axis: 'x',
    onMove: (from, to) => { pages = moveItem(pages, from, to); changedOrder = true; render(); },
  });

  addDocs(initial);
  return {
    el,
    title: 'Gabung PDF',
    get docs() { return files.map((f) => f.doc); },
    onDrop: async (paths) => {
      const docs = await app.loadDocs(paths);
      app.adopt(docs);
      addDocs(docs);
    },
    dropHint: (n) => `${n} PDF akan ditambahkan ke gabungan`,
    dispose: () => { unsortFiles(); unsortPages(); thumbs.dispose(); },
  };
}
