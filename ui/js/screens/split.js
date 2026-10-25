import { h, icon, dirname, stem } from '../dom.js';
import * as backend from '../backend.js';
import { ThumbnailQueue, attachThumb } from '../pdf.js';
import { savedDialog, toastError, withBusy } from '../ui.js';

const PALETTE = ['var(--accent)', 'var(--tag-b)', 'var(--tag-c)', 'var(--tag-d)'];

export function splitScreen({ doc }, app) {
  const count = doc.pages;
  const defaultRanges = count >= 3
    ? (() => {
        const third = Math.ceil(count / 3);
        const parts = [];
        for (let a = 1; a <= count; a += third) parts.push(a === Math.min(a + third - 1, count) ? `${a}` : `${a}-${Math.min(a + third - 1, count)}`);
        return parts.join(', ');
      })()
    : count === 2 ? '1, 2' : '1';
  const state = {
    mode: count > 1 ? 'range' : 'pick',
    ranges: defaultRanges,
    groups: [],
    rangeError: '',
    picked: new Set([0]),
  };
  const thumbs = new ThumbnailQueue(3);
  const papers = Array.from({ length: count }, (_, i) => {
    const paper = h('div', { class: 'paper' });
    attachThumb(thumbs, paper, doc.pdf, i, 124);
    return paper;
  });

  const cta = h('button', { class: 'btn primary', onClick: run });
  const modeList = h('div', { role: 'radiogroup', 'aria-label': 'Cara memecah', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const rangeInput = h('input', { class: 'input mono', id: 'ranges', value: state.ranges, spellcheck: false, placeholder: 'mis. 1-3, 5, 7-' });
  const rangeHint = h('span', { class: 'hint' });
  const rangeField = h('div', { class: 'field' }, h('label', { for: 'ranges' }, 'Rentang halaman'), rangeInput, rangeHint);
  const patternInput = h('input', { class: 'input mono', id: 'pattern', value: `${stem(doc.name)}_{n}`, spellcheck: false });
  const grid = h('div', { class: 'page-grid', role: 'list', 'aria-label': 'Halaman' });
  const hint = h('span', {});
  const chips = h('div', { class: 'chips' });
  const outCount = h('span', { class: 'muted', style: { flexShrink: 0, fontSize: '13px' } });

  const MODES = [
    { id: 'each', title: 'Setiap halaman', desc: 'Satu halaman jadi satu file' },
    { id: 'range', title: 'Per rentang', desc: 'Tentukan kelompok halaman sendiri' },
    { id: 'pick', title: 'Ambil halaman tertentu', desc: 'Pilih halaman, simpan jadi satu file' },
  ];

  let rangeTimer = 0;
  rangeInput.addEventListener('input', () => {
    state.ranges = rangeInput.value;
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(updateRanges, 200);
  });

  async function updateRanges() {
    try {
      state.groups = await backend.parseRanges(state.ranges, count);
      state.rangeError = '';
    } catch (e) {
      state.groups = [];
      state.rangeError = e.message;
    }
    render();
  }

  function groups() {
    if (state.mode === 'each') return Array.from({ length: count }, (_, i) => [i]);
    if (state.mode === 'range') return state.groups;
    return [[...state.picked].sort((a, b) => a - b)].filter((g) => g.length);
  }

  function render() {
    const gs = groups();
    const groupOf = new Map();
    gs.forEach((g, gi) => g.forEach((p) => { if (!groupOf.has(p)) groupOf.set(p, gi); }));

    modeList.replaceChildren(...MODES.map((m) =>
      h('button', {
        class: 'mode-option', role: 'radio', 'aria-checked': String(state.mode === m.id),
        onClick: () => { state.mode = m.id; render(); },
      },
      h('span', { class: 'dot' }),
      h('span', {}, h('b', {}, m.title), h('span', {}, m.desc)))));

    rangeField.style.display = state.mode === 'range' ? '' : 'none';
    rangeInput.classList.toggle('invalid', Boolean(state.rangeError));
    rangeHint.className = `hint${state.rangeError ? ' error' : ''}`;
    rangeHint.textContent = state.rangeError || 'Pisahkan dengan koma. Tiap bagian jadi satu file.';

    const isPick = state.mode === 'pick';
    hint.textContent = isPick
      ? `Klik halaman untuk memilih · ${state.picked.size} dipilih`
      : 'Warna menunjukkan file tujuan tiap halaman';

    grid.replaceChildren(...papers.map((paper, i) => {
      const g = groupOf.get(i);
      const color = g == null ? null : PALETTE[g % PALETTE.length];
      const picked = state.picked.has(i);
      paper.style.boxShadow = color ? `0 0 0 2px ${color}` : '';
      const tile = h(isPick ? 'button' : 'div', {
        class: `page-tile${isPick ? ' clickable' : ''}${isPick && picked ? ' picked' : ''}${(isPick && !picked) || (!isPick && g == null) ? ' dim' : ''}`,
        role: isPick ? 'checkbox' : 'listitem',
        'aria-checked': isPick ? String(picked) : null,
        'aria-label': `Halaman ${i + 1}`,
        onClick: isPick ? () => { picked ? state.picked.delete(i) : state.picked.add(i); render(); } : null,
      },
      h('div', { style: { position: 'relative' } },
        paper,
        !isPick && g != null && h('span', { class: 'badge', style: { background: color, fontFamily: 'var(--font)' } }, `File ${g + 1}`),
        isPick && h('span', { class: 'check' }, picked && icon('check', 13, 3))),
      h('span', { class: 'num' }, i + 1));
      return tile;
    }));

    const name = (n) => patternInput.value.replace('{name}', stem(doc.name)).replace('{n}', String(n).padStart(String(gs.length).length, '0'));
    const label = (g) => {
      if (g.length === 1) return `hlm ${g[0] + 1}`;
      const contiguous = g.every((p, k) => k === 0 || p === g[k - 1] + 1);
      return contiguous ? `hlm ${g[0] + 1}–${g[g.length - 1] + 1}` : `hlm ${g.map((p) => p + 1).join(', ')}`;
    };
    chips.replaceChildren(...gs.slice(0, 200).map((g, gi) =>
      h('span', { class: 'chip' },
        h('i', { style: { background: PALETTE[gi % PALETTE.length] } }),
        h('span', { class: 'mono', style: { fontSize: '12px' } }, `${name(gi + 1)}.pdf`.replace(/\.pdf\.pdf$/i, '.pdf')),
        h('span', { class: 'muted' }, label(g)))));
    if (gs.length > 200) chips.append(h('span', { class: 'chip muted' }, `+${gs.length - 200} file lagi`));
    outCount.textContent = `Hasil · ${gs.length} file`;

    cta.replaceChildren(icon('download', 16, 2), gs.length === 1 ? 'Simpan 1 file' : `Pecah jadi ${gs.length} file`);
    cta.disabled = gs.length === 0;
  }

  patternInput.addEventListener('input', render);

  async function run() {
    const gs = groups();
    if (!gs.length) return;
    try {
      const folder = await backend.pickFolder(dirname(doc.path));
      if (!folder) return;
      const files = await withBusy('Memecah PDF…', () =>
        backend.splitPdf({ path: doc.path, password: doc.password }, gs, folder, patternInput.value));
      const choice = await savedDialog({
        files,
        title: files.length === 1 ? 'PDF berhasil disimpan' : `${files.length} file tersimpan`,
        message: 'File asli tidak diubah.',
      });
      if (choice === 'done') app.go('home');
    } catch (e) {
      toastError(e);
    }
  }

  const el = h('div', { class: 'screen' },
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Kembali ke beranda', onClick: () => app.go('home') }, icon('back')),
      h('span', { class: 'title' }, 'Pecah PDF'),
      h('span', { class: 'sub grow', title: doc.path }, `${doc.name} · ${count} halaman`),
      cta),
    h('div', { class: 'split-layout' },
      h('aside', { class: 'side' },
        h('h2', {}, 'Cara memecah'),
        modeList,
        rangeField,
        h('div', { class: 'field', style: { marginTop: 'auto', paddingTop: '12px' } },
          h('label', { for: 'pattern' }, 'Nama file hasil'),
          patternInput,
          h('span', { class: 'hint' }, '{n} diganti nomor urut file, {name} nama file asli'))),
      h('section', { class: 'stage' },
        h('div', { class: 'stage-head' }, h('h2', {}, 'Pratinjau'), hint),
        h('div', { class: 'stage-body' }, grid),
        h('div', { class: 'stage-foot' }, outCount, chips))));

  updateRanges();
  render();
  return {
    el,
    title: 'Pecah PDF',
    docs: [doc],
    onDrop: async (paths) => {
      const docs = await app.loadDocs(paths.slice(0, 1));
      if (docs.length) { app.adopt(docs); app.go('split', { doc: docs[0] }); }
    },
    dropHint: () => 'PDF ini akan dibuka untuk dipecah',
    dispose: () => { thumbs.dispose(); clearTimeout(rangeTimer); },
  };
}
