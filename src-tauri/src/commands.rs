//! Commands the web UI calls. Paths come from the user's own file dialogs or
//! drops; heavy PDF work runs off the main thread.

use std::fs;
use std::path::{Path, PathBuf};

use lembar_core::{Document, EditSet, ImageHit, ImagePlacement, ImageReplacement, PageRef, Source, TextEdit};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::PendingFiles;

type CmdResult<T> = Result<T, String>;

/// Largest PDF the app will open. Far beyond normal documents, but keeps a
/// mistaken multi-gigabyte pick from exhausting memory.
const MAX_PDF_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn read_limited(path: &Path, limit: u64) -> CmdResult<Vec<u8>> {
    let meta = fs::metadata(path).map_err(|e| format!("tidak bisa membuka {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} bukan file", path.display()));
    }
    if meta.len() > limit {
        return Err(format!("{} terlalu besar", path.display()));
    }
    fs::read(path).map_err(|e| format!("tidak bisa membaca {}: {e}", path.display()))
}

/// Writes next to the destination first and renames into place, so a crash
/// or a full disk never leaves a half-written PDF where the user expects one.
fn write_atomic(dest: &Path, bytes: &[u8]) -> CmdResult<()> {
    let dir = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(err)?;
    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "output.pdf".into());
    let tmp = dir.join(format!(".{name}.lembar-tmp"));
    fs::write(&tmp, bytes).map_err(|e| format!("gagal menulis {}: {e}", dest.display()))?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("gagal menyimpan {}: {e}", dest.display())
    })
}

fn with_pdf_extension(path: PathBuf) -> PathBuf {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        path
    } else {
        let mut s = path.into_os_string();
        s.push(".pdf");
        PathBuf::from(s)
    }
}

/// `dir/name.pdf`, or `dir/name (2).pdf` and so on if that already exists.
fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.pdf"));
    if !first.exists() {
        return first;
    }
    (2..).map(|i| dir.join(format!("{stem} ({i}).pdf"))).find(|p| !p.exists()).expect("an unused name exists")
}

/// Removes characters no file system accepts in a name.
fn safe_stem(s: &str) -> String {
    let cleaned: String =
        s.chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                    '-'
                } else {
                    c
                }
            })
            .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "dokumen".into()
    } else {
        trimmed
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
    pub name: String,
    pub pages: u32,
    pub bytes: u64,
}

fn saved(path: &Path, pages: u32, bytes: usize) -> SavedFile {
    SavedFile {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        pages,
        bytes: bytes as u64,
    }
}

#[tauri::command]
pub fn take_pending_files(state: State<'_, PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
pub async fn read_pdf(path: String) -> CmdResult<Response> {
    blocking(move || {
        let bytes = read_limited(Path::new(&path), MAX_PDF_BYTES)?;
        if !bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
            return Err(format!("{} bukan file PDF", Path::new(&path).display()));
        }
        Ok(Response::new(bytes))
    })
    .await
}

#[tauri::command]
pub async fn read_image(path: String) -> CmdResult<Response> {
    blocking(move || {
        let p = Path::new(&path);
        let ok = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str()));
        if !ok {
            return Err("format gambar tidak didukung (pakai JPG, PNG, WebP, GIF atau BMP)".into());
        }
        Ok(Response::new(read_limited(p, MAX_IMAGE_BYTES)?))
    })
    .await
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
pub async fn pick_pdfs(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .set_title("Pilih PDF")
        .add_filter("PDF", &["pdf", "PDF"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub async fn pick_image(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Pilih gambar")
        .add_filter("Gambar", &IMAGE_EXTENSIONS)
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_save_path(app: AppHandle, default_name: String, directory: Option<String>) -> Option<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Simpan PDF")
        .add_filter("PDF", &["pdf"])
        .set_file_name(safe_stem(default_name.strip_suffix(".pdf").unwrap_or(&default_name)) + ".pdf");
    if let Some(dir) = directory.filter(|d| Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| with_pdf_extension(p).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, directory: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Pilih folder tujuan");
    if let Some(dir) = directory.filter(|d| Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Debug, Deserialize)]
pub struct Input {
    pub path: String,
    #[serde(default)]
    pub password: Option<String>,
}

fn file_label(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn load_input(input: &Input) -> CmdResult<Document> {
    let bytes = read_limited(Path::new(&input.path), MAX_PDF_BYTES)?;
    lembar_core::load(Source::with_password(&bytes, input.password.as_deref()))
        .map_err(|e| format!("{}: {e}", file_label(&input.path)))
}

fn save_doc(doc: &mut Document, dest: &Path) -> CmdResult<SavedFile> {
    let pages = doc.get_pages().len() as u32;
    let bytes = lembar_core::save(doc).map_err(err)?;
    write_atomic(dest, &bytes)?;
    Ok(saved(dest, pages, bytes.len()))
}

#[tauri::command]
pub async fn list_images(input: Input) -> CmdResult<Vec<ImageHit>> {
    blocking(move || Ok(lembar_core::list_images(&load_input(&input)?))).await
}

#[tauri::command]
pub fn parse_ranges(input: String, page_count: u32) -> CmdResult<Vec<Vec<u32>>> {
    lembar_core::parse_ranges(&input, page_count).map_err(err)
}

/// A new image, read from `source` when the edit is saved.
#[derive(Debug, Deserialize)]
pub struct PlacementIn {
    #[serde(flatten)]
    pub placement: ImagePlacement,
    pub source: String,
}

/// A replacement picture for an existing image, read from `source`.
#[derive(Debug, Deserialize)]
pub struct ReplacementIn {
    #[serde(flatten)]
    pub replacement: ImageReplacement,
    pub source: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct EditsIn {
    pub texts: Vec<TextEdit>,
    pub images: Vec<PlacementIn>,
    pub replacements: Vec<ReplacementIn>,
}

#[tauri::command]
pub async fn save_edits(input: Input, dest: String, edits: EditsIn) -> CmdResult<SavedFile> {
    blocking(move || {
        let mut set = EditSet { texts: edits.texts, ..Default::default() };
        for p in edits.images {
            let mut placement = p.placement;
            placement.data = read_limited(Path::new(&p.source), MAX_IMAGE_BYTES)?;
            set.images.push(placement);
        }
        for r in edits.replacements {
            let mut replacement = r.replacement;
            replacement.data = read_limited(Path::new(&r.source), MAX_IMAGE_BYTES)?;
            set.replacements.push(replacement);
        }
        // Loaded fully into memory first, so saving over the original is safe.
        let mut doc = load_input(&input)?;
        lembar_core::apply_edits(&mut doc, &set).map_err(err)?;
        save_doc(&mut doc, &with_pdf_extension(PathBuf::from(dest)))
    })
    .await
}

#[tauri::command]
pub async fn merge_pdfs(inputs: Vec<Input>, order: Vec<PageRef>, dest: String) -> CmdResult<SavedFile> {
    blocking(move || {
        let docs = inputs.iter().map(load_input).collect::<CmdResult<Vec<_>>>()?;
        let mut doc = lembar_core::compose(docs, &order).map_err(err)?;
        save_doc(&mut doc, &with_pdf_extension(PathBuf::from(dest)))
    })
    .await
}

/// Splits one PDF into one file per group of zero-based page indices.
/// `pattern` names the files: `{name}` is the source's name, `{n}` the
/// group's number. Existing files are never overwritten.
#[tauri::command]
pub async fn split_pdf(
    input: Input,
    groups: Vec<Vec<u32>>,
    folder: String,
    pattern: String,
) -> CmdResult<Vec<SavedFile>> {
    blocking(move || {
        if groups.iter().all(|g| g.is_empty()) {
            return Err(lembar_core::Error::NoPages.to_string());
        }
        let bytes = read_limited(Path::new(&input.path), MAX_PDF_BYTES)?;
        let source = Source::with_password(&bytes, input.password.as_deref());
        // Fail on a bad page number before writing anything.
        let count = lembar_core::page_count(source).map_err(|e| format!("{}: {e}", file_label(&input.path)))?;
        if let Some(&bad) = groups.iter().flatten().find(|&&p| p >= count) {
            return Err(lembar_core::Error::PageOutOfRange { page: bad + 1, count }.to_string());
        }

        let name = Path::new(&input.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let pattern = if pattern.trim().is_empty() { "{name}_{n}".to_string() } else { pattern };
        let pattern = pattern.trim().trim_end_matches(".pdf").trim_end_matches(".PDF").to_string();
        let folder = PathBuf::from(folder);
        let width = groups.len().to_string().len();

        let mut out = Vec::new();
        for (i, group) in groups.iter().filter(|g| !g.is_empty()).enumerate() {
            let order: Vec<PageRef> = group.iter().map(|&p| PageRef::new(0, p)).collect();
            let doc = lembar_core::load(source).map_err(err)?;
            let mut part = lembar_core::compose(vec![doc], &order).map_err(err)?;
            let n = format!("{:0width$}", i + 1);
            let mut stem = pattern.replace("{name}", &name).replace("{n}", &n);
            if !pattern.contains("{n}") && groups.len() > 1 {
                stem = format!("{stem}_{n}");
            }
            let dest = unique_path(&folder, &safe_stem(&stem));
            out.push(save_doc(&mut part, &dest)?);
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub fn reveal(path: String) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_files_safely() {
        assert_eq!(safe_stem("a/b:c?"), "a-b-c-");
        assert_eq!(safe_stem("  ..  "), "dokumen");
        assert_eq!(with_pdf_extension("x".into()), PathBuf::from("x.pdf"));
        assert_eq!(with_pdf_extension("x.PDF".into()), PathBuf::from("x.PDF"));
    }

    #[test]
    fn never_overwrites_when_splitting() {
        let dir = std::env::temp_dir().join(format!("lembar-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.pdf"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a"), dir.join("a (2).pdf"));
        assert_eq!(unique_path(&dir, "b"), dir.join("b.pdf"));
        write_atomic(&dir.join("c.pdf"), b"hello").unwrap();
        assert_eq!(fs::read(dir.join("c.pdf")).unwrap(), b"hello");
        fs::remove_dir_all(&dir).unwrap();
    }
}
