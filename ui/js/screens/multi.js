import { h, icon, grip, dirname } from '../dom.js';
import * as backend from '../backend.js';
import { ThumbnailQueue, attachThumb } from '../pdf.js';
import { savedDialog, toastError, withBusy } from '../ui.js';
import { makeSortable, moveItem } from '../sortable.js';

/** Several PDFs were opened at once: list them and ask what to do. */
export function multiScreen({ docs: initial }, app) {
  let docs = initial.slice();
  const thumbs = new ThumbnailQueue(3);
  const title = h('h1', {});
  const subtitle = h('p', {});
  const table = h('div', { class: 'file-table', role: 'list', 'aria-label': 'File yang akan diproses' });
  const actions = h('div', { class: 'actions-row multi-col' });

  function render() {
    const pages = docs.reduce((n, d) => n + d.pages, 0);
    title.textContent = `${docs.length} PDF siap`;
    subtitle.textContent = `${pages} halaman total · seret untuk mengatur urutan`;
    table.replaceChildren(...docs.map((d, i) => {
      if (!d.miniThumb) {
        d.miniThumb = h('div', { class: 'mini-thumb' });
        attachThumb(thumbs, d.miniThumb, d.pdf, 0, 26);
      }
      const holder = d.miniThumb;
      return h('div', { class: 'file-row', role: 'listitem' },
        grip(),
        h('span', { class: 'idx' }, i + 1),
        holder,
        h('span', { class: 'name', title: d.path }, d.name),
        h('span', { class: 'meta' }, `${d.pages} hlm`),
        h('button', { class: 'icon-btn muted', 'aria-label': `Hapus ${d.name}`, onClick: () => remove(d) }, icon('close', 16)));
    }));
    if (!docs.length) {
      table.append(h('div', { class: 'recent-empty', style: { padding: '48px' } }, 'Semua file sudah dihapus. Tarik PDF lagi ke sini.'));
    }
    actions.replaceChildren(
      h('span', { class: 'label' }, 'Mau diapakan?'),
      h('button', { class: 'btn tall', disabled: !docs.length, onClick: () => app.go('editor', { queue: docs }) }, 'Edit satu per satu'),
      h('button', { class: 'btn tall', disabled: !docs.length, onClick: splitEach }, 'Pecah tiap file'),
      h('button', { class: 'btn tall primary', disabled: docs.length < 1, onClick: () => app.go('merge', { docs }) },
        icon('merge', 16, 2), 'Gabung jadi satu'));
  }

  function remove(doc) {
    docs = docs.filter((d) => d !== doc);
    app.release(doc);
    render();
  }

  async function add(paths) {
    const known = new Set(docs.map((d) => d.path));
    const fresh = await app.loadDocs(paths.filter((p) => !known.has(p)));
    app.adopt(fresh);
    docs = docs.concat(fresh);
    render();
  }

  async function splitEach() {
    try {
      const folder = await backend.pickFolder(dirname(docs[0].path));
      if (!folder) return;
      const files = await withBusy('Memecah PDF…', async (setLabel) => {
        const out = [];
        for (const [i, d] of docs.entries()) {
          setLabel(`Memecah ${i + 1} dari ${docs.length}: ${d.name}`);
          const groups = Array.from({ length: d.pages }, (_, p) => [p]);
          out.push(...(await backend.splitPdf({ path: d.path, password: d.password }, groups, folder, '{name}_{n}')));
        }
        return out;
      });
      const choice = await savedDialog({
        files,
        title: `${files.length} file tersimpan`,
        message: 'Setiap halaman sekarang jadi file sendiri. File asli tidak diubah.',
      });
      if (choice === 'done') app.go('home');
    } catch (e) {
      toastError(e);
    }
  }

  const el = h('div', { class: 'screen' },
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Kembali ke beranda', onClick: () => app.go('home') }, icon('back')),
      h('span', { class: 'title grow' }, 'File baru masuk')),
    h('main', { class: 'multi-main' },
      h('div', { class: 'multi-col multi-head' },
        h('div', {}, title, subtitle),
        h('button', { class: 'btn', onClick: async () => { const p = await backend.pickPdfs().catch(toastError); if (p?.length) add(p); } },
          icon('plus', 16, 2), 'Tambah file')),
      h('div', { class: 'multi-col', style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, table),
      actions));

  const unsort = makeSortable(table, {
    items: '.file-row',
    axis: 'y',
    onMove: (from, to) => { docs = moveItem(docs, from, to); render(); },
  });

  render();
  return {
    el,
    title: 'File baru masuk',
    get docs() { return docs; },
    onDrop: (paths) => add(paths),
    dropHint: (n) => `${n} PDF akan ditambahkan ke daftar`,
    dispose: () => { unsort(); thumbs.dispose(); },
  };
}
