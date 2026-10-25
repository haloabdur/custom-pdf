// Calls into the Rust side. Everything goes through Tauri's invoke().

const T = window.__TAURI__;

export const hasBackend = Boolean(T?.core?.invoke);

export function invoke(cmd, args) {
  if (!hasBackend) return Promise.reject(new Error('Lembar harus dijalankan sebagai aplikasi desktop.'));
  return T.core.invoke(cmd, args).catch((e) => {
    throw e instanceof Error ? e : new Error(String(e));
  });
}

export async function readPdf(path) {
  return new Uint8Array(await invoke('read_pdf', { path }));
}

export async function readImage(path) {
  return new Uint8Array(await invoke('read_image', { path }));
}

export const fileExists = (path) => invoke('file_exists', { path });
export const pickPdfs = () => invoke('pick_pdfs');
export const pickImage = () => invoke('pick_image');
export const pickSavePath = (defaultName, directory) => invoke('pick_save_path', { defaultName, directory });
export const pickFolder = (directory) => invoke('pick_folder', { directory });
export const listImages = (input) => invoke('list_images', { input });
export const parseRanges = (input, pageCount) => invoke('parse_ranges', { input, pageCount });
export const saveEdits = (input, dest, edits) => invoke('save_edits', { input, dest, edits });
export const mergePdfs = (inputs, order, dest) => invoke('merge_pdfs', { inputs, order, dest });
export const splitPdf = (input, groups, folder, pattern) => invoke('split_pdf', { input, groups, folder, pattern });
export const reveal = (path) => invoke('reveal', { path });
export const takePendingFiles = () => (hasBackend ? invoke('take_pending_files') : Promise.resolve([]));

/** Files dragged onto the window from the OS. */
export function onFileDrop({ enter, leave, drop }) {
  const win = T?.webviewWindow?.getCurrentWebviewWindow?.();
  if (!win) return;
  win.onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === 'enter' || p.type === 'over') enter?.(p.paths || []);
    else if (p.type === 'leave') leave?.();
    else if (p.type === 'drop') drop?.(p.paths || []);
  });
}

/** Files the OS asks us to open while running ("Open with…" on macOS). */
export function onOpenFiles(handler) {
  T?.event?.listen?.('open-files', () => handler());
}

/** Lets the app veto closing the window (unsaved changes). */
export function onCloseRequested(shouldBlock, confirmClose) {
  const win = T?.window?.getCurrentWindow?.();
  if (!win) return;
  win.onCloseRequested(async (event) => {
    if (!shouldBlock()) return;
    event.preventDefault();
    if (await confirmClose()) await win.destroy();
  });
}

export function setTitle(title) {
  T?.window?.getCurrentWindow?.().setTitle(title).catch(() => {});
}
