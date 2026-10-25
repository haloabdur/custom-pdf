use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("file ini bukan PDF yang valid")]
    NotPdf,
    #[error("PDF ini dilindungi kata sandi")]
    PasswordRequired,
    #[error("kata sandi PDF salah")]
    WrongPassword,
    #[error("PDF tidak bisa dibaca: {0}")]
    Pdf(#[from] lopdf::Error),
    #[error("gambar tidak bisa dibaca: {0}")]
    Image(#[from] image::ImageError),
    #[error("halaman {page} tidak ada (dokumen hanya punya {count} halaman)")]
    PageOutOfRange { page: u32, count: u32 },
    #[error("dokumen sumber #{0} tidak ada")]
    SourceOutOfRange(usize),
    #[error("tidak ada halaman yang dipilih")]
    NoPages,
    #[error("objek {0} {1} bukan gambar")]
    NotAnImage(u32, u16),
    #[error("rentang halaman tidak valid: {0}")]
    InvalidRange(String),
    #[error("gagal menulis: {0}")]
    Io(#[from] std::io::Error),
}
