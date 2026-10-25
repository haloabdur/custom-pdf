use lopdf::{Document, LoadOptions};

use crate::{Error, Result};

/// One input document: its bytes and, when it is encrypted, the password.
#[derive(Debug, Clone, Copy)]
pub struct Source<'a> {
    pub bytes: &'a [u8],
    pub password: Option<&'a str>,
}

impl<'a> Source<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, password: None }
    }

    pub fn with_password(bytes: &'a [u8], password: Option<&'a str>) -> Self {
        Self { bytes, password }
    }
}

/// Refuses anything that does not carry a `%PDF-` header in its first KiB,
/// which is where every PDF reader looks for it.
fn looks_like_pdf(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    head.windows(5).any(|w| w == b"%PDF-")
}

/// Parses a document. Encrypted files open with the empty user password or
/// with `password`; the decrypted copy is what every later step works on.
pub fn load(source: Source<'_>) -> Result<Document> {
    if !looks_like_pdf(source.bytes) {
        return Err(Error::NotPdf);
    }
    let mut options = match source.password {
        Some(pw) if !pw.is_empty() => LoadOptions::with_password(pw),
        _ => LoadOptions::default(),
    };
    // Guard against decompression bombs in object/xref streams.
    options.max_decompressed_size = Some(512 * 1024 * 1024);
    let doc = Document::load_mem_with_options(source.bytes, options).map_err(|e| match e {
        lopdf::Error::InvalidPassword => Error::WrongPassword,
        other => Error::Pdf(other),
    })?;
    if doc.is_encrypted() {
        return Err(if source.password.is_some_and(|p| !p.is_empty()) {
            Error::WrongPassword
        } else {
            Error::PasswordRequired
        });
    }
    if doc.get_pages().is_empty() {
        return Err(Error::NoPages);
    }
    Ok(doc)
}

pub fn page_count(source: Source<'_>) -> Result<u32> {
    Ok(load(source)?.get_pages().len() as u32)
}

/// Serialises a document, dropping objects nothing refers to any more and
/// compressing streams that are still stored raw.
pub fn save(doc: &mut Document) -> Result<Vec<u8>> {
    doc.trailer.remove(b"Encrypt");
    doc.prune_objects();
    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out)
}
