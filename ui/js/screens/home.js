import { h, icon, relativeTime } from '../dom.js';
import { fileExists } from '../backend.js';
import { toast } from '../ui.js';

export function homeScreen(_params, app) {
  const themeBtn = h('button', { class: 'icon-btn muted', onClick: () => { app.toggleTheme(); paintTheme(); } });
  const paintTheme = () => {
    const dark = app.isDark();
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    themeBtn.setAttribute('aria-label', dark ? 'Ganti ke mode terang' : 'Ganti ke mode gelap');
    themeBtn.title = themeBtn.getAttribute('aria-label');
  };
  paintTheme();

  const card = (ico, title, desc, intent) =>
    h('button', { class: 'mode-card', onClick: () => app.pickAndOpen(intent) },
      h('div', { class: 'ico' }, icon(ico)),
      h('div', {}, h('b', {}, title), h('span', {}, desc)));

  const list = h('div', { class: 'recent-list', role: 'list' });
  const renderRecent = () => {
    const items = app.recents();
    list.replaceChildren(
      ...(items.length
        ? items.map((r) =>
            h('div', { class: 'recent-item', role: 'listitem' },
              h('span', { class: 'muted', style: { display: 'flex' } }, icon('file', 18)),
              h('button', {
                class: 'name', title: r.path,
                style: { border: 0, background: 'transparent', textAlign: 'left', height: '100%', padding: 0 },
                onClick: () => openRecent(r),
              }, r.name),
              h('span', { class: 'meta mono' }, `${r.pages} hlm`),
              h('span', { class: 'meta', style: { width: '110px', textAlign: 'right' } }, relativeTime(r.at)),
              h('button', {
                class: 'icon-btn muted forget', 'aria-label': `Hapus ${r.name} dari daftar`, title: 'Hapus dari daftar',
                onClick: () => { app.forget(r.path); renderRecent(); },
              }, icon('close', 16))))
        : [h('div', { class: 'recent-empty' }, 'Belum ada file. PDF yang Anda buka akan muncul di sini.')]),
    );
  };

  async function openRecent(r) {
    if (!(await fileExists(r.path).catch(() => false))) {
      toast(`${r.name} sudah tidak ada di lokasi semula.`, { error: true });
      app.forget(r.path);
      renderRecent();
      return;
    }
    app.openPaths([r.path]);
  }

  renderRecent();

  const drop = h('button', { class: 'dropzone', onClick: () => app.pickAndOpen() },
    h('div', { class: 'badge' }, icon('upload', 26)),
    h('h1', {}, 'Tarik PDF ke sini'),
    h('p', {}, 'Satu file untuk diedit, atau beberapa sekaligus untuk digabung'),
    h('span', { class: 'fake-btn' }, 'Pilih file…'));

  const el = h('div', { class: 'screen' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand grow' }, icon('file', 26), h('span', {}, 'Lembar')),
      themeBtn),
    h('main', { class: 'home-main' },
      h('div', { class: 'home-col', style: { flexShrink: 0 } }, drop),
      h('div', { class: 'home-col mode-cards' },
        card('edit', 'Edit', 'Ubah teks & gambar, template tetap utuh', 'auto'),
        card('merge', 'Gabung', 'Satukan 2 PDF atau lebih jadi satu file', 'merge'),
        card('split', 'Pecah', 'Pisahkan halaman jadi file sendiri', 'split')),
      h('section', { class: 'home-col recent' },
        h('h2', {}, 'Terakhir dibuka'),
        list)),
    h('footer', { class: 'privacy' }, icon('lock', 14), 'Semua diproses di perangkat ini — file tidak pernah di-upload'));

  return {
    el,
    title: '',
    mounted: () => window.addEventListener('focus', renderRecent),
    dispose: () => window.removeEventListener('focus', renderRecent),
  };
}
