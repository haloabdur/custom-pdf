// pdf.js wrapper: opening documents (with password prompts) and rendering
// pages or thumbnails into canvases.

import * as pdfjs from '../vendor/pdfjs/pdf.min.js';

const VENDOR = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.js`;

export { pdfjs };

export class PasswordCancelled extends Error {
  constructor() {
    super('Dibatalkan');
  }
}

/**
 * Opens a PDF from bytes. `askPassword(retry)` is called for encrypted files
 * and resolves to a password, or null to give up.
 */
export async function openPdf(bytes, askPassword) {
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${VENDOR}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
  });
  let password = null;
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) {
      cancelled = true;
      task.destroy();
    } else {
      password = pw;
      update(pw);
    }
  };
  try {
    const doc = await task.promise;
    return { doc, password };
  } catch (e) {
    if (cancelled) throw new PasswordCancelled();
    throw new Error(e?.name === 'InvalidPDFException' ? 'File ini bukan PDF yang valid atau rusak.' : e?.message || String(e));
  }
}

/**
 * Renders thumbnails lazily as they scroll into view, a couple at a time.
 */
export class ThumbnailQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.observer.unobserve(e.target);
        const job = e.target.__thumbJob;
        if (job) this.push(job);
      }
    }, { rootMargin: '400px' });
  }

  /** Renders page `pageIndex` of `doc` into `holder` (a sized element) when visible. */
  watch(holder, doc, pageIndex, cssWidth) {
    holder.__thumbJob = { holder, doc, pageIndex, cssWidth };
    this.observer.observe(holder);
  }

  push(job) {
    this.queue.push(job);
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (!job.holder.isConnected) continue;
      this.active++;
      renderThumb(job).catch(() => {}).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  dispose() {
    this.observer.disconnect();
    this.queue = [];
  }
}

const sizeCache = new WeakMap();

/** Width/height ratio of a page as displayed (rotation applied). */
export async function pageAspect(doc, pageIndex) {
  let m = sizeCache.get(doc);
  if (!m) sizeCache.set(doc, (m = new Map()));
  if (!m.has(pageIndex)) {
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    m.set(pageIndex, vp.width / vp.height);
  }
  return m.get(pageIndex);
}

async function renderThumb({ holder, doc, pageIndex, cssWidth }) {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp, background: '#ffffff' }).promise;
  if (!holder.isConnected) return;
  holder.replaceChildren(canvas);
}

/** Sizes a thumbnail holder to the page's aspect, then queues it. */
export async function attachThumb(queue, holder, doc, pageIndex, cssWidth) {
  try {
    const aspect = await pageAspect(doc, pageIndex);
    holder.style.width = `${cssWidth}px`;
    holder.style.height = `${Math.round(cssWidth / aspect)}px`;
  } catch (_) {
    holder.style.height = `${Math.round(cssWidth * 1.414)}px`;
  }
  queue.watch(holder, doc, pageIndex, cssWidth);
}
