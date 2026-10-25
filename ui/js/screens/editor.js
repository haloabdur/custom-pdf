import { h, icon, dirname, stem } from '../dom.js';
import * as backend from '../backend.js';
import { ThumbnailQueue, attachThumb } from '../pdf.js';
import { toast, toastError, withBusy, savedDialog, confirmDialog } from '../ui.js';
import {
  FONT_CSS, FONT_LABEL, baselineOffset, buildRuns, sampleColors, hexToRgb01, unsupportedChars,
} from '../text-runs.js';

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MAX_RENDERED = 24; // canvases kept in memory; older ones are dropped
const HISTORY_LIMIT = 200;

let nextId = 1;
const newId = () => `e${nextId++}`;

/**
 * Edit model (all coordinates in PDF user space of the page):
 *  text:    { id, type:'text', page, runKey?, x, y, size, angle, font, bold, italic, color, text,
 *             lineHeight, cover?: { points, color }, orig?: {...}, origFont? }
 *  image:   { id, type:'image', page, cx, cy, w, h, angle, source }
 *  replace: { id, type:'replace', page, object, bbox, boxWidth, boxHeight, source }
 */
export function editorScreen({ queue, index = 0 }, app) {
  const doc = queue[index];
  const pdf = doc.pdf;
  const pageCount = doc.pages;

  const state = {
    tool: 'text',
    zoom: 1,
    edits: [],
    undo: [],
    redo: [],
    savedSnapshot: '[]',
    dest: null,
    selectedId: null,
    activePage: 0,
    imageHits: [], // from the backend
  };
  const pages = []; // per page: { shell, canvas, layer, page, base, viewport, rendered, runs, task }
  const renderedOrder = [];
  const imageUrls = new Map(); // source path -> blob URL
  const elements = new Map(); // edit id -> element
  let toolbar = null;
  let disposed = false;
  // The text box being typed in: its id, its text when focus arrived, and
  // whether it was created by this focus (creation already added an undo step).
  let editing = null;

  // ---------- header ----------
  const status = h('span', { class: 'status clean' }, h('i'), h('span', { class: 'label' }, 'Belum ada perubahan'));
  const toolButtons = {};
  const toolDefs = [
    ['select', 'cursor', 'Pilih', 'V'],
    ['text', 'text', 'Teks', 'T'],
    ['image', 'image', 'Gambar', 'G'],
  ];
  const tools = h('div', { class: 'segmented', role: 'toolbar', 'aria-label': 'Alat' },
    toolDefs.map(([id, ico, label, key]) => {
      const b = h('button', { 'aria-pressed': 'false', title: `${label} (${key})`, onClick: () => setTool(id) }, icon(ico, 16), label);
      toolButtons[id] = b;
      return b;
    }));
  const undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Urungkan', title: 'Urungkan (Ctrl+Z)', onClick: undo }, icon('undo', 18));
  const redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Ulangi', title: 'Ulangi (Ctrl+Shift+Z)', onClick: redo }, icon('redo', 18));
  const saveBtn = h('button', { class: 'btn primary', style: { marginLeft: '8px' }, title: 'Simpan (Ctrl+S)', onClick: () => save() },
    icon('download', 16, 2), 'Simpan PDF');
  const queueNav = queue.length > 1
    ? h('span', { class: 'queue-nav' },
        h('button', { class: 'icon-btn', 'aria-label': 'File sebelumnya', disabled: index === 0, onClick: () => app.go('editor', { queue, index: index - 1 }) }, icon('chevronLeft', 16)),
        `${index + 1}/${queue.length}`,
        h('button', { class: 'icon-btn', 'aria-label': 'File berikutnya', disabled: index === queue.length - 1, onClick: () => app.go('editor', { queue, index: index + 1 }) }, icon('chevronRight', 16)))
    : null;

  const header = h('header', { class: 'topbar editor-top' },
    h('div', { class: 'left' },
      h('button', { class: 'icon-btn', 'aria-label': 'Kembali ke beranda', onClick: () => app.go('home') }, icon('back')),
      h('span', { class: 'title', style: { overflow: 'hidden', textOverflow: 'ellipsis' }, title: doc.path }, doc.name),
      queueNav,
      status),
    tools,
    h('div', { class: 'right' }, undoBtn, redoBtn, saveBtn));

  // ---------- body ----------
  const thumbsEl = h('nav', { class: 'thumbs', 'aria-label': 'Halaman' });
  const pagesEl = h('div', { class: 'pages' });
  const scroller = h('div', { class: 'viewer-scroll' }, pagesEl);
  const zoomVal = h('span', { class: 'val' }, '100%');
  const pageVal = h('span', { class: 'pg' }, `1 / ${pageCount}`);
  const zoombar = h('div', { class: 'zoombar' },
    h('button', { 'aria-label': 'Perkecil', title: 'Perkecil (Ctrl −)', onClick: () => stepZoom(-1) }, '−'),
    zoomVal,
    h('button', { 'aria-label': 'Perbesar', title: 'Perbesar (Ctrl +)', onClick: () => stepZoom(1) }, '+'),
    h('button', { 'aria-label': 'Sesuaikan lebar', title: 'Sesuaikan lebar', onClick: fitWidth }, icon('fit', 16)),
    h('span', { class: 'sep' }),
    pageVal);
  const viewer = h('section', { class: `viewer tool-${state.tool}`, 'aria-label': 'Halaman yang diedit' }, scroller, zoombar);

  const el = h('div', { class: 'screen' }, header, h('div', { class: 'editor-body' }, thumbsEl, viewer));

  const thumbQueue = new ThumbnailQueue(2);
  const thumbButtons = [];
  for (let i = 0; i < pageCount; i++) {
    const paper = h('div', { class: 'paper' });
    const b = h('button', { class: `thumb${i === 0 ? ' active' : ''}`, 'aria-label': `Halaman ${i + 1}`, onClick: () => scrollToPage(i) },
      paper, h('span', {}, i + 1));
    thumbButtons.push(b);
    thumbsEl.append(b);
    attachThumb(thumbQueue, paper, pdf, i, 100);
  }

  // ---------- pages ----------
  const pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = Number(e.target.dataset.index);
      pages[i].visible = e.isIntersecting;
      if (e.isIntersecting) renderPage(i);
    }
  }, { root: scroller, rootMargin: '600px 0px' });

  async function setupPages() {
    for (let i = 0; i < pageCount; i++) {
      const page = await pdf.getPage(i + 1);
      if (disposed) return;
      const base = page.getViewport({ scale: 1 });
      const canvas = h('canvas');
      const layer = h('div', { class: 'layer' });
      const shell = h('div', { class: 'page', dataset: { index: String(i) } }, canvas, layer);
      layer.addEventListener('pointerdown', (e) => onLayerPointerDown(e, i));
      pages[i] = { shell, canvas, layer, page, base, viewport: null, rendered: 0, runs: null, task: null, visible: false };
      sizePage(i);
      pagesEl.append(shell);
      if (i === 0) {
        fitWidth(true);
      }
      pageObserver.observe(shell);
    }
  }

  function sizePage(i) {
    const p = pages[i];
    p.viewport = p.page.getViewport({ scale: state.zoom });
    p.shell.style.width = `${Math.floor(p.viewport.width)}px`;
    p.shell.style.height = `${Math.floor(p.viewport.height)}px`;
  }

  async function renderPage(i) {
    const p = pages[i];
    if (!p || p.rendered === state.zoom) {
      if (p && !p.runs) await ensureRuns(i);
      return;
    }
    p.task?.cancel();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = p.page.getViewport({ scale: state.zoom * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const zoomAtStart = state.zoom;
    p.task = p.page.render({ canvasContext: canvas.getContext('2d', { alpha: false, willReadFrequently: true }), viewport: vp, background: '#ffffff' });
    try {
      await p.task.promise;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e);
      return;
    }
    if (disposed || zoomAtStart !== state.zoom) return;
    canvas.className = '';
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
    p.rendered = state.zoom;
    trackRendered(i);
    await ensureRuns(i);
    renderLayer(i);
  }

  function trackRendered(i) {
    const at = renderedOrder.indexOf(i);
    if (at >= 0) renderedOrder.splice(at, 1);
    renderedOrder.push(i);
    while (renderedOrder.length > MAX_RENDERED) {
      const old = renderedOrder.shift();
      const p = pages[old];
      if (p.visible) { renderedOrder.push(old); break; }
      const blank = h('canvas');
      p.canvas.replaceWith(blank);
      p.canvas = blank;
      p.rendered = 0;
    }
  }

  async function ensureRuns(i) {
    const p = pages[i];
    if (p.runs) return;
    try {
      const tc = await p.page.getTextContent();
      p.runs = buildRuns(tc, p.page, i);
    } catch (e) {
      console.error(e);
      p.runs = [];
    }
  }

  // ---------- geometry ----------
  const toView = (i, x, y) => {
    const [vx, vy] = pages[i].viewport.convertToViewportPoint(x, y);
    return { x: vx, y: vy };
  };
  const toPdf = (i, vx, vy) => pages[i].viewport.convertToPdfPoint(vx, vy);

  /** CSS box for a PDF quad given as [bottom-left, bottom-right, top-right, top-left]. */
  function quadBox(i, pts) {
    const p0 = toView(i, ...pts[0]);
    const p1 = toView(i, ...pts[1]);
    const p3 = toView(i, ...pts[3]);
    return {
      left: p3.x, top: p3.y,
      width: Math.hypot(p1.x - p0.x, p1.y - p0.y),
      height: Math.hypot(p0.x - p3.x, p0.y - p3.y),
      rot: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    };
  }

  function placeBox(node, b) {
    Object.assign(node.style, {
      left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`,
      transform: b.rot ? `rotate(${b.rot}rad)` : '',
    });
  }

  function rectBox(i, [x0, y0, x1, y1]) {
    const a = toView(i, x0, y0), b = toView(i, x1, y1);
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), rot: 0 };
  }

  /** Angle (rad) on screen of a direction given in degrees in PDF space. */
  function viewAngle(i, x, y, deg) {
    const r = (deg * Math.PI) / 180;
    const a = toView(i, x, y);
    const b = toView(i, x + Math.cos(r), y + Math.sin(r));
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // ---------- layer rendering ----------
  function renderLayer(i) {
    const p = pages[i];
    if (!p?.viewport) return;
    const scale = state.zoom;
    const layer = p.layer;
    const nodes = [];

    // Hit targets for the current tool.
    if (state.tool === 'text' && p.runs) {
      const editedRuns = new Set(state.edits.filter((e) => e.type === 'text' && e.runKey).map((e) => e.runKey));
      for (const run of p.runs) {
        if (editedRuns.has(run.key)) continue;
        const hit = h('div', { class: 'hit text', title: run.text });
        placeBox(hit, quadBox(i, run.cover));
        hit.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          startRunEdit(i, run, e.clientX, e.clientY);
        });
        nodes.push(hit);
      }
    }
    if (state.tool === 'image') {
      for (const hit of state.imageHits.filter((x) => x.page === i)) {
        const node = h('div', { class: 'hit image', title: 'Klik untuk mengganti gambar' },
          h('span', { class: 'replace-chip' }, icon('swap', 13, 2), 'Ganti gambar'));
        placeBox(node, rectBox(i, hit.bbox));
        node.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          replaceImage(hit);
        });
        nodes.push(node);
      }
    }

    // Covers and edits.
    for (const edit of state.edits) {
      if (edit.type === 'replace') {
        for (const hit of state.imageHits.filter((x) => x.page === i && sameObject(x.object, edit.object))) {
          const node = imageNode(edit, `${edit.id}:${hit.bbox.join(',')}`, true);
          placeBox(node, rectBox(i, hit.bbox));
          nodes.push(node);
        }
        continue;
      }
      if (edit.page !== i) continue;
      if (edit.type === 'text') {
        if (edit.cover) {
          const cover = h('div', { class: 'cover', style: { background: edit.cover.color } });
          placeBox(cover, quadBox(i, edit.cover.points));
          nodes.push(cover);
        }
        if (edit.deleted) continue;
        const node = textNode(edit);
        const size = edit.size * scale;
        const theta = viewAngle(i, edit.x, edit.y, edit.angle);
        const o = toView(i, edit.x, edit.y);
        Object.assign(node.style, {
          left: `${o.x}px`,
          top: `${o.y}px`,
          fontFamily: FONT_CSS[edit.font],
          fontWeight: edit.bold ? '700' : '400',
          fontStyle: edit.italic ? 'italic' : 'normal',
          fontSize: `${size}px`,
          lineHeight: String(edit.lineHeight),
          color: edit.color,
          transform: `rotate(${theta}rad) translateY(${-baselineOffset(edit.font, edit.lineHeight) * size}px)`,
        });
        node.classList.toggle('selected', state.selectedId === edit.id);
        nodes.push(node);
      } else if (edit.type === 'image') {
        const node = imageNode(edit, edit.id, false);
        const c = toView(i, edit.cx, edit.cy);
        const w = edit.w * scale, hgt = edit.h * scale;
        placeBox(node, { left: c.x - w / 2, top: c.y - hgt / 2, width: w, height: hgt, rot: 0 });
        node.classList.toggle('selected', state.selectedId === edit.id);
        nodes.push(node);
      }
    }

    // Update in place: detaching a focused text box would end the editing.
    const want = new Set(nodes);
    if (toolbar && toolbar.page === i) want.add(toolbar.el);
    for (const child of [...layer.children]) if (!want.has(child)) child.remove();
    for (const n of want) if (n.parentNode !== layer) layer.append(n);
    layer.classList.toggle('blank', state.tool === 'text' || state.tool === 'image');
    for (const [key, node] of elements) {
      if (!state.edits.some((e) => e.id === node.dataset.edit && !(e.type === 'text' && e.deleted))) elements.delete(key);
    }
  }

  function renderAllLayers() {
    pages.forEach((p, i) => { if (p?.viewport && p.runs) renderLayer(i); });
    if (toolbar) positionToolbar();
  }

  const sameObject = (a, b) => a[0] === b[0] && a[1] === b[1];

  function textNode(edit) {
    let node = elements.get(edit.id);
    if (node) {
      if (node.innerText.replace(/\n$/, '') !== edit.text && document.activeElement !== node) node.textContent = edit.text;
      return node;
    }
    node = h('div', { class: 'edit-text', spellcheck: false, dataset: { edit: edit.id, placeholder: 'Ketik teks…' } });
    try {
      node.contentEditable = 'plaintext-only';
    } catch (_) {
      node.contentEditable = 'true';
    }
    if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
    node.textContent = edit.text;
    node.addEventListener('focus', () => {
      if (editing?.id !== edit.id) editing = { id: edit.id, before: findEdit(edit.id)?.text ?? '', fresh: false };
      select(edit.id);
    });
    node.addEventListener('input', () => {
      const e = findEdit(edit.id);
      if (e) e.text = node.innerText.replace(/\n$/, '');
      updateStatus();
    });
    node.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const text = ev.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text);
    });
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); node.blur(); }
    });
    node.addEventListener('blur', (ev) => leaveText(ev.relatedTarget));
    node.addEventListener('pointerdown', (ev) => {
      if (state.tool === 'select') {
        ev.preventDefault();
        startDrag(ev, edit.id);
      } else {
        ev.stopPropagation();
      }
    });
    elements.set(edit.id, node);
    return node;
  }

  function imageNode(edit, key, replacement) {
    let node = elements.get(key);
    if (node) return node;
    const img = h('img', { alt: '', draggable: false });
    imageUrl(edit.source).then((url) => { img.src = url; }).catch(toastError);
    node = h('div', { class: `edit-image${replacement ? ' replacement' : ''}`, dataset: { edit: edit.id } }, img);
    if (!replacement) {
      const handle = h('span', { class: 'handle', 'aria-hidden': 'true' });
      handle.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); ev.preventDefault(); startResize(ev, edit.id); });
      node.append(handle);
      node.addEventListener('pointerdown', (ev) => {
        if (state.tool === 'text') return;
        ev.stopPropagation();
        ev.preventDefault();
        startDrag(ev, edit.id);
      });
    } else {
      node.style.pointerEvents = 'none';
    }
    elements.set(key, node);
    return node;
  }

  async function imageUrl(path) {
    if (!imageUrls.has(path)) {
      const bytes = await backend.readImage(path);
      imageUrls.set(path, URL.createObjectURL(new Blob([bytes])));
    }
    return imageUrls.get(path);
  }

  // ---------- text editing ----------
  function startRunEdit(i, run, clientX, clientY) {
    const p = pages[i];
    const box = quadBox(i, run.cover);
    const ratio = p.canvas.width / p.viewport.width;
    const sampleBox = { left: box.left * ratio, top: box.top * ratio, width: Math.max(box.width, 2) * ratio, height: Math.max(box.height, 2) * ratio };
    const { bg, fg } = sampleColors(p.canvas, sampleBox);
    const edit = {
      id: newId(), type: 'text', page: i, runKey: run.key,
      x: run.x, y: run.y, size: round(run.size), angle: run.angle,
      font: run.font, bold: run.bold, italic: run.italic, color: fg,
      text: run.text, lineHeight: 1.2,
      cover: { points: run.cover, color: bg },
      orig: { text: run.text, font: run.font, bold: run.bold, italic: run.italic, size: round(run.size), color: fg },
      origFont: run.displayName,
    };
    pushHistory();
    state.edits.push(edit);
    editing = { id: edit.id, before: edit.text, fresh: true };
    renderLayer(i);
    focusText(edit.id, clientX, clientY);
  }

  function startNewText(i, vx, vy) {
    const p = pages[i];
    const size = 12;
    const lh = 1.2;
    const angle = p.page.rotate || 0;
    // The click marks the top-left of the new text; move down to its baseline.
    const off = baselineOffset('sans', lh) * size * state.zoom;
    const [x, y] = toPdf(i, vx, vy + off);
    const edit = {
      id: newId(), type: 'text', page: i, x, y, size, angle, font: 'sans', bold: false, italic: false,
      color: '#000000', text: '', lineHeight: lh, cover: null,
    };
    pushHistory();
    state.edits.push(edit);
    editing = { id: edit.id, before: '', fresh: true };
    renderLayer(i);
    focusText(edit.id);
  }

  function focusText(id, clientX, clientY) {
    const node = elements.get(id);
    if (!node) return;
    node.focus({ preventScroll: true });
    const sel = window.getSelection();
    let range = null;
    if (clientX != null && document.caretRangeFromPoint) range = document.caretRangeFromPoint(clientX, clientY);
    if (!range || !node.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Focus left a text box (or its toolbar); finish unless it moved between the two. */
  function leaveText(next) {
    if (!editing) return;
    const node = elements.get(editing.id);
    if (next && (next === node || toolbar?.el.contains(next))) return;
    const { id, before, fresh } = editing;
    editing = null;
    finishTextEdit(id, before, fresh);
  }

  function finishTextEdit(id, before, fresh) {
    const edit = findEdit(id);
    if (!edit) return;
    if ((!edit.runKey && !edit.text.trim()) || (edit.runKey && isUnchanged(edit))) {
      // Nothing changed (or an empty new box): forget the edit, and the undo
      // step its creation added.
      state.edits = state.edits.filter((e) => e !== edit);
      dropLastHistoryIfSame();
      if (state.selectedId === id) select(null);
    } else if (!fresh && before !== edit.text) {
      pushHistory(snapshotWith(id, before));
    }
    renderLayer(edit.page);
    updateStatus();
  }

  function isUnchanged(e) {
    const o = e.orig;
    return !e.deleted && o && e.text === o.text && e.font === o.font && e.bold === o.bold && e.italic === o.italic &&
      e.size === o.size && e.color.toLowerCase() === o.color.toLowerCase() && e.x === findRunOrigin(e)[0] && e.y === findRunOrigin(e)[1];
  }

  function findRunOrigin(e) {
    const run = pages[e.page]?.runs?.find((r) => r.key === e.runKey);
    return run ? [run.x, run.y] : [e.x, e.y];
  }

  // ---------- images ----------
  async function replaceImage(hit) {
    try {
      const source = await backend.pickImage();
      if (!source) return;
      await imageUrl(source);
      pushHistory();
      const existing = state.edits.find((e) => e.type === 'replace' && sameObject(e.object, hit.object));
      if (existing) {
        existing.source = source;
        for (const k of [...elements.keys()]) if (k.startsWith(`${existing.id}:`)) elements.delete(k);
      } else {
        state.edits.push({
          id: newId(), type: 'replace', page: hit.page, object: hit.object, bbox: hit.bbox,
          boxWidth: hit.width, boxHeight: hit.height, source,
        });
      }
      renderAllLayers();
      updateStatus();
      const shared = state.imageHits.filter((x) => sameObject(x.object, hit.object)).length;
      if (shared > 1) toast(`Gambar ini dipakai di ${shared} tempat — semuanya ikut diganti.`);
    } catch (e) {
      toastError(e);
    }
  }

  async function addImage(i, vx, vy) {
    try {
      const source = await backend.pickImage();
      if (!source) return;
      const url = await imageUrl(source);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('Gambar tidak bisa dibaca.'));
        im.src = url;
      });
      const p = pages[i];
      const pageW = Math.min(p.base.width, p.base.height);
      const w = Math.min(200, pageW * 0.5, img.naturalWidth);
      const hgt = (w * img.naturalHeight) / img.naturalWidth;
      const [cx, cy] = toPdf(i, vx, vy);
      const edit = { id: newId(), type: 'image', page: i, cx, cy, w, h: hgt, angle: p.page.rotate || 0, source };
      pushHistory();
      state.edits.push(edit);
      select(edit.id);
      renderLayer(i);
      updateStatus();
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- pointer interactions ----------
  function onLayerPointerDown(e, i) {
    if (e.button !== 0 || e.target !== pages[i].layer) return;
    const r = pages[i].layer.getBoundingClientRect();
    const vx = e.clientX - r.left, vy = e.clientY - r.top;
    if (document.activeElement?.classList?.contains('edit-text')) {
      // First click outside a text box only finishes editing.
      document.activeElement.blur();
      e.preventDefault();
      return;
    }
    if (state.tool === 'text') {
      e.preventDefault();
      startNewText(i, vx, vy);
    } else if (state.tool === 'image') {
      e.preventDefault();
      addImage(i, vx, vy);
    } else {
      select(null);
    }
  }

  function startDrag(ev, id) {
    const edit = findEdit(id);
    if (!edit) return;
    select(id);
    const i = edit.page;
    const node = elements.get(id);
    const startX = ev.clientX, startY = ev.clientY;
    const snapshot = serialize();
    const orig = { ...edit };
    let moved = false;
    const move = (e) => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (edit.type === 'text') {
        const o = toView(i, orig.x, orig.y);
        [edit.x, edit.y] = toPdf(i, o.x + dx, o.y + dy);
      } else {
        const c = toView(i, orig.cx, orig.cy);
        [edit.cx, edit.cy] = toPdf(i, c.x + dx, c.y + dy);
      }
      renderLayer(i);
      positionToolbar();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        pushHistory(snapshot);
        updateStatus();
      }
      node?.focus?.({ preventScroll: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(ev, id) {
    const edit = findEdit(id);
    if (!edit) return;
    select(id);
    const startX = ev.clientX;
    const snapshot = serialize();
    const w0 = edit.w, h0 = edit.h;
    const move = (e) => {
      const dx = (e.clientX - startX) / state.zoom;
      const w = Math.max(8, w0 + dx * 2);
      edit.w = w;
      edit.h = (w * h0) / w0;
      renderLayer(edit.page);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      pushHistory(snapshot);
      updateStatus();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- selection & toolbar ----------
  function select(id) {
    if (state.selectedId === id) return;
    const prev = findEdit(state.selectedId);
    state.selectedId = id;
    if (prev) renderLayer(prev.page);
    const edit = findEdit(id);
    if (edit) renderLayer(edit.page);
    buildToolbar();
  }

  function buildToolbar() {
    if (toolbar) {
      toolbar.el.remove();
      toolbar = null;
    }
    const edit = findEdit(state.selectedId);
    if (!edit || (edit.type === 'text' && edit.deleted)) return;
    const elTb = h('div', { class: 'text-toolbar', role: 'toolbar', 'aria-label': 'Format teks' });
    elTb.addEventListener('focusout', (e) => leaveText(e.relatedTarget));
    // Keep focus in the text box when clicking buttons.
    elTb.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target.closest('button')) e.preventDefault();
    });
    const apply = (fn) => {
      const snap = serialize();
      fn(edit);
      pushHistory(snap);
      renderLayer(edit.page);
      positionToolbar();
      updateStatus();
    };
    const del = h('button', { 'aria-label': 'Hapus', title: 'Hapus (Del)', onClick: () => removeEdit(edit.id) }, icon('trash', 15));
    if (edit.type === 'text') {
      const fontSel = h('select', { 'aria-label': 'Font', onChange: (e) => apply((x) => { x.font = e.target.value; }) },
        Object.entries(FONT_LABEL).map(([v, label]) => h('option', { value: v, selected: edit.font === v }, label)));
      const sizeIn = h('input', { type: 'number', min: '4', max: '200', step: '0.5', value: String(edit.size), 'aria-label': 'Ukuran huruf' });
      sizeIn.addEventListener('change', () => {
        const v = Math.min(200, Math.max(4, Number(sizeIn.value) || edit.size));
        apply((x) => { x.size = v; });
      });
      const toggle = (key) => (e) => {
        apply((x) => { x[key] = !x[key]; });
        e.currentTarget.setAttribute('aria-pressed', String(edit[key]));
      };
      const boldBtn = h('button', { 'aria-label': 'Tebal', 'aria-pressed': String(edit.bold), style: { fontWeight: '700' }, onClick: toggle('bold') }, 'B');
      const italicBtn = h('button', { 'aria-label': 'Miring', 'aria-pressed': String(edit.italic), style: { fontStyle: 'italic', fontFamily: 'Georgia, serif' }, onClick: toggle('italic') }, 'I');
      const color = h('input', { type: 'color', value: edit.color, 'aria-label': 'Warna teks' });
      color.addEventListener('change', () => apply((x) => { x.color = color.value; }));
      elTb.append(fontSel, sizeIn, boldBtn, italicBtn, color, h('span', { class: 'sep' }), del);
      if (edit.origFont) {
        elTb.append(h('span', { class: 'sep' }),
          h('span', { class: 'orig', title: 'Teks hasil edit memakai font standar PDF yang paling mirip dengan font asli. Posisi, ukuran dan warna mengikuti teks asli.' },
            icon('check', 12, 2.4), `Mirip font asli: ${edit.origFont}`));
      }
    } else {
      elTb.append(h('span', { class: 'orig', style: { color: '#fff' } }, 'Seret untuk pindah · tarik sudut'), h('span', { class: 'sep' }), del);
    }
    toolbar = { el: elTb, page: edit.page, id: edit.id };
    pages[edit.page]?.layer.append(elTb);
    positionToolbar();
  }

  function positionToolbar() {
    if (!toolbar) return;
    const node = elements.get(toolbar.id);
    const p = pages[toolbar.page];
    if (!node || !p) return;
    const lr = p.layer.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const tbH = 38;
    let top = nr.top - lr.top - tbH - 10;
    if (top < 4) top = nr.bottom - lr.top + 10;
    const left = Math.max(4, Math.min(nr.left - lr.left, lr.width - toolbar.el.offsetWidth - 4));
    Object.assign(toolbar.el.style, { top: `${top}px`, left: `${left}px` });
  }

  function removeEdit(id) {
    const edit = findEdit(id);
    if (!edit) return;
    editing = null;
    pushHistory();
    if (edit.type === 'text' && edit.runKey) {
      // Deleting original text keeps the cover so the text disappears.
      edit.deleted = true;
      edit.text = '';
      elements.delete(id);
    } else {
      state.edits = state.edits.filter((e) => e !== edit);
      elements.delete(id);
    }
    select(null);
    renderAllLayers();
    updateStatus();
  }

  // ---------- history ----------
  function serialize() {
    return JSON.stringify(state.edits);
  }

  function snapshotWith(id, text) {
    return JSON.stringify(state.edits.map((e) => (e.id === id ? { ...e, text } : e)));
  }

  function pushHistory(snapshot = serialize()) {
    state.undo.push(snapshot);
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo = [];
    updateStatus();
  }

  function dropLastHistoryIfSame() {
    if (state.undo.length && state.undo[state.undo.length - 1] === serialize()) state.undo.pop();
  }

  function restore(snapshot) {
    editing = null;
    document.activeElement?.blur?.();
    state.edits = JSON.parse(snapshot);
    elements.clear();
    state.selectedId = null;
    buildToolbar();
    renderAllLayers();
    updateStatus();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(serialize());
    restore(state.undo.pop());
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(serialize());
    restore(state.redo.pop());
  }

  const findEdit = (id) => state.edits.find((e) => e.id === id);
  const isDirty = () => serialize() !== state.savedSnapshot && state.edits.some(meaningful);
  const meaningful = (e) => e.type !== 'text' || e.deleted || !e.runKey || !isUnchanged(e);

  function updateStatus() {
    const dirty = isDirty();
    const n = state.edits.filter(meaningful).length;
    status.className = `status ${dirty ? '' : state.dest ? 'saved' : 'clean'}`;
    status.querySelector('.label').textContent = dirty ? `${n} perubahan` : state.dest ? 'Tersimpan' : 'Belum ada perubahan';
    undoBtn.disabled = !state.undo.length;
    redoBtn.disabled = !state.redo.length;
  }

  // ---------- tools, zoom, navigation ----------
  function setTool(tool) {
    document.activeElement?.blur?.();
    state.tool = tool;
    viewer.className = `viewer tool-${tool}`;
    for (const [id, b] of Object.entries(toolButtons)) b.setAttribute('aria-pressed', String(id === tool));
    if (tool !== 'select') select(null);
    renderAllLayers();
  }

  function setZoom(z, anchor) {
    z = Math.min(4, Math.max(0.25, z));
    if (Math.abs(z - state.zoom) < 0.001) return;
    const sc = scroller;
    const ax = anchor?.x ?? sc.clientWidth / 2;
    const ay = anchor?.y ?? sc.clientHeight / 2;
    const fx = (sc.scrollLeft + ax) / Math.max(1, sc.scrollWidth);
    const fy = (sc.scrollTop + ay) / Math.max(1, sc.scrollHeight);
    state.zoom = z;
    zoomVal.textContent = `${Math.round(z * 100)}%`;
    pages.forEach((p, i) => { if (p) sizePage(i); });
    sc.scrollLeft = fx * sc.scrollWidth - ax;
    sc.scrollTop = fy * sc.scrollHeight - ay;
    pages.forEach((p, i) => {
      if (!p) return;
      renderLayer(i);
      if (p.visible) renderPage(i);
    });
    positionToolbar();
  }

  function stepZoom(dir) {
    const z = state.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
    if (next) setZoom(next);
  }

  function fitWidth(initial = false) {
    const first = pages[0];
    if (!first) return;
    const widest = Math.max(...pages.filter(Boolean).map((p) => p.page.getViewport({ scale: 1 }).width));
    const avail = scroller.clientWidth - 64;
    let z = avail / widest;
    if (initial === true) z = Math.min(z, 1.25);
    setZoom(Math.max(0.25, Math.min(4, z)));
    if (initial === true) zoomVal.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function scrollToPage(i) {
    pages[i]?.shell.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function trackActivePage() {
    const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    let best = state.activePage, bestD = Infinity;
    pages.forEach((p, i) => {
      if (!p) return;
      const r = p.shell.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== state.activePage) {
      thumbButtons[state.activePage]?.classList.remove('active');
      state.activePage = best;
      thumbButtons[best]?.classList.add('active');
      thumbButtons[best]?.scrollIntoView({ block: 'nearest' });
    }
    pageVal.textContent = `${state.activePage + 1} / ${pageCount}`;
  }

  scroller.addEventListener('scroll', () => requestAnimationFrame(trackActivePage), { passive: true });
  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });

  function onKey(e) {
    if (document.querySelector('.modal-backdrop, .busy')) return;
    const mod = e.ctrlKey || e.metaKey;
    const typing = e.target.closest?.('input, select, [contenteditable]');
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save({ saveAs: e.shiftKey }); return; }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); stepZoom(1); return; }
    if (mod && e.key === '-') { e.preventDefault(); stepZoom(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); fitWidth(); return; }
    if (typing) return;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); removeEdit(state.selectedId); return; }
    if (e.key === 'Escape') { select(null); return; }
    if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 't' || e.key === 'T') setTool('text');
    else if (e.key === 'g' || e.key === 'G' || e.key === 'i' || e.key === 'I') setTool('image');
    else if (e.key === 'PageDown') scrollToPage(Math.min(pageCount - 1, state.activePage + 1));
    else if (e.key === 'PageUp') scrollToPage(Math.max(0, state.activePage - 1));
  }

  // ---------- saving ----------
  function payload() {
    const texts = [];
    const images = [];
    const replacements = [];
    for (const e of state.edits) {
      if (e.type === 'text') {
        if (e.runKey && !e.deleted && isUnchanged(e)) continue;
        texts.push({
          page: e.page, text: e.deleted ? '' : e.text, x: e.x, y: e.y, size: e.size, angle: e.angle,
          font: e.font, bold: e.bold, italic: e.italic, color: hexToRgb01(e.color), lineHeight: e.lineHeight,
          cover: e.cover ? { points: e.cover.points, color: hexToRgb01(e.cover.color) } : null,
        });
      } else if (e.type === 'image') {
        images.push({ page: e.page, x: e.cx - e.w / 2, y: e.cy - e.h / 2, width: e.w, height: e.h, angle: e.angle, source: e.source });
      } else if (e.type === 'replace') {
        replacements.push({ object: e.object, boxWidth: e.boxWidth, boxHeight: e.boxHeight, source: e.source });
      }
    }
    return { texts, images, replacements };
  }

  async function save({ saveAs = false } = {}) {
    document.activeElement?.blur?.();
    const data = payload();
    const bad = unsupportedChars(data.texts.map((t) => t.text).join(''));
    if (bad.length) {
      const ok = await confirmDialog({
        title: 'Ada karakter yang tidak didukung',
        message: `Karakter ${bad.slice(0, 12).join(' ')} tidak ada di font standar PDF dan akan tampil sebagai “?”. Tetap simpan?`,
        confirm: 'Tetap simpan',
      });
      if (!ok) return;
    }
    try {
      let dest = state.dest;
      const firstSave = !dest;
      if (!dest || saveAs) {
        dest = await backend.pickSavePath(`${stem(doc.name)}_edit.pdf`, dirname(doc.path));
        if (!dest) return;
      }
      const file = await withBusy('Menyimpan PDF…', () => backend.saveEdits({ path: doc.path, password: doc.password }, dest, data));
      const overwritten = file.path === doc.path;
      state.dest = file.path;
      state.savedSnapshot = serialize();
      updateStatus();
      app.remember({ path: file.path, name: file.name, pages: file.pages });
      if (!firstSave && !saveAs && !overwritten) {
        toast(`Tersimpan ke ${file.name}`);
        return;
      }
      const hasNext = index < queue.length - 1;
      const choice = await savedDialog({
        files: [file],
        message: overwritten ? 'File asli sudah diperbarui.' : 'File asli tidak diubah. Hasil edit disimpan sebagai file baru.',
        continueLabel: 'Lanjut edit',
        nextLabel: hasNext ? 'Lanjut ke file berikutnya' : null,
      });
      if (choice === 'next') return app.go('editor', { queue, index: index + 1, force: true });
      if (choice === 'done') return app.go('home', { force: true });
      if (overwritten) {
        // The file on disk now contains the edits; reopen it so they are not applied twice.
        const fresh = await app.loadDoc(doc.path);
        app.adopt([fresh]);
        const q = queue.slice();
        q[index] = fresh;
        app.go('editor', { queue: q, index, force: true });
      }
    } catch (e) {
      toastError(e);
    }
  }

  async function loadImageHits() {
    try {
      state.imageHits = await backend.listImages({ path: doc.path, password: doc.password });
      if (state.tool === 'image') renderAllLayers();
    } catch (e) {
      console.warn('list_images failed', e);
    }
  }

  const round = (v) => Math.round(v * 100) / 100;
  const onResize = () => positionToolbar();

  setTool(state.tool);
  updateStatus();

  return {
    el,
    title: doc.name,
    docs: queue,
    isDirty,
    mounted() {
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      setupPages().then(trackActivePage).catch(toastError);
      if (backend.hasBackend) loadImageHits();
    },
    onDrop: async (paths) => {
      const docs = await app.loadDocs(paths);
      if (!docs.length) return;
      app.adopt(docs);
      if (docs.length === 1) app.go('editor', { queue: docs });
      else app.go('multi', { docs });
    },
    dropHint: (n) => (n > 1 ? `${n} PDF akan dibuka` : 'PDF ini akan dibuka di editor'),
    dispose() {
      disposed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      pageObserver.disconnect();
      thumbQueue.dispose();
      pages.forEach((p) => p?.task?.cancel());
      for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    },
  };
}
