//! PDF engine behind Lembar.
//!
//! Everything works on in-memory bytes so the desktop shell (or any other
//! front end) decides where files come from and where they go:
//!
//! * [`compose`] builds a new document from pages of one or more documents.
//!   Merging, splitting, reordering and deleting pages are all special cases.
//! * [`list_images`] finds every image XObject drawn on each page together
//!   with its on-page box, so a UI can offer "replace this image".
//! * [`apply_edits`] writes text edits, image replacements and new images
//!   into an existing document without touching the rest of its content.

mod compose;
mod edit;
mod error;
mod geometry;
mod images;
mod load;
mod ranges;
mod winansi;

pub use compose::{compose, PageRef};
pub use edit::{apply_edits, Cover, EditSet, FontFamily, ImagePlacement, ImageReplacement, TextEdit};
pub use error::{Error, Result};
pub use images::{list_images, ImageHit};
pub use load::{load, page_count, save, Source};
pub use ranges::parse_ranges;
pub use winansi::can_encode;

/// The parsed document type every function here works on.
pub use lopdf::Document;
