mod commands;

use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

/// PDFs the app was asked to open (command line, "Open with…", or a file
/// dropped on the dock icon) that the window has not picked up yet.
#[derive(Default)]
pub struct PendingFiles(pub Mutex<Vec<String>>);

fn pdf_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter_map(|a| {
        let path = if let Some(rest) = a.strip_prefix("file://") { PathBuf::from(rest) } else { PathBuf::from(&a) };
        let is_pdf = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        (is_pdf && path.is_file()).then(|| path.to_string_lossy().into_owned())
    })
    .collect()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFiles(Mutex::new(pdf_args(std::env::args().skip(1)))))
        .invoke_handler(tauri::generate_handler![
            commands::take_pending_files,
            commands::read_pdf,
            commands::read_image,
            commands::file_exists,
            commands::pick_pdfs,
            commands::pick_image,
            commands::pick_save_path,
            commands::pick_folder,
            commands::list_images,
            commands::parse_ranges,
            commands::save_edits,
            commands::merge_pdfs,
            commands::split_pdf,
            commands::reveal,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Lembar");

    app.run(|_handle, _event| {
        // macOS delivers "Open with…" as an event rather than arguments.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if !files.is_empty() {
                if let Some(state) = _handle.try_state::<PendingFiles>() {
                    state.0.lock().unwrap().extend(files.iter().cloned());
                }
                let _ = _handle.emit("open-files", files);
            }
        }
    });
}
