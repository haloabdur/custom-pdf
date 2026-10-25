use std::fmt::Write as _;

use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::images::{add_image, image_xobject, page_resources, replace_image};
use crate::{winansi, Error, Result};

/// Everything to write into a document in one save.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditSet {
    pub texts: Vec<TextEdit>,
    pub images: Vec<ImagePlacement>,
    pub replacements: Vec<ImageReplacement>,
}

impl EditSet {
    pub fn is_empty(&self) -> bool {
        self.texts.is_empty() && self.images.is_empty() && self.replacements.is_empty()
    }
}

/// The standard PDF font families. They need no embedding, so edited text
/// stays small and renders the same in every viewer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontFamily {
    #[default]
    Sans,
    Serif,
    Mono,
}

impl FontFamily {
    fn base_font(self, bold: bool, italic: bool) -> &'static str {
        match (self, bold, italic) {
            (FontFamily::Sans, false, false) => "Helvetica",
            (FontFamily::Sans, true, false) => "Helvetica-Bold",
            (FontFamily::Sans, false, true) => "Helvetica-Oblique",
            (FontFamily::Sans, true, true) => "Helvetica-BoldOblique",
            (FontFamily::Serif, false, false) => "Times-Roman",
            (FontFamily::Serif, true, false) => "Times-Bold",
            (FontFamily::Serif, false, true) => "Times-Italic",
            (FontFamily::Serif, true, true) => "Times-BoldItalic",
            (FontFamily::Mono, false, false) => "Courier",
            (FontFamily::Mono, true, false) => "Courier-Bold",
            (FontFamily::Mono, false, true) => "Courier-Oblique",
            (FontFamily::Mono, true, true) => "Courier-BoldOblique",
        }
    }
}

/// A filled polygon painted under an edit to hide what was there before.
#[derive(Debug, Clone, Deserialize)]
pub struct Cover {
    /// Corners in user space.
    pub points: Vec<[f32; 2]>,
    /// RGB, each 0–1.
    pub color: [f32; 3],
}

/// Text to draw, optionally over a cover that hides the original text.
/// An empty `text` with a cover deletes the original.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    /// Zero-based page index.
    pub page: u32,
    pub text: String,
    /// Baseline origin of the first line, in user space.
    pub x: f32,
    pub y: f32,
    /// Font size in points.
    pub size: f32,
    /// Counter-clockwise rotation of the baseline, in degrees.
    #[serde(default)]
    pub angle: f32,
    #[serde(default)]
    pub font: FontFamily,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    /// RGB, each 0–1.
    #[serde(default)]
    pub color: [f32; 3],
    /// Distance between baselines as a multiple of `size`.
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default)]
    pub cover: Option<Cover>,
}

fn default_line_height() -> f32 {
    1.2
}

/// A new image drawn into the box with lower-left corner (`x`, `y`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePlacement {
    pub page: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Counter-clockwise rotation around the box centre, in degrees.
    #[serde(default)]
    pub angle: f32,
    /// Encoded image file (JPEG, PNG, WebP, GIF or BMP).
    #[serde(skip)]
    pub data: Vec<u8>,
}

/// Replaces the picture of an existing image XObject. The new picture is
/// cropped to the aspect of the box it is drawn in, so the layout is kept.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReplacement {
    pub object: (u32, u16),
    /// Drawn size of the box, used for the crop.
    pub box_width: f32,
    pub box_height: f32,
    #[serde(skip)]
    pub data: Vec<u8>,
}

/// Writes `edits` into `doc`. Existing page content is wrapped in `q … Q` and
/// left byte-for-byte as it was; new drawing goes in an extra content stream
/// appended to each touched page.
pub fn apply_edits(doc: &mut Document, edits: &EditSet) -> Result<()> {
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let count = pages.len() as u32;
    // Resource names must not clash with ones an earlier save added; the
    // highest object id only grows from save to save, so it makes a fresh tag.
    let tag = doc.max_id;
    let page_id = |page: u32| -> Result<ObjectId> {
        pages.get(page as usize).copied().ok_or(Error::PageOutOfRange { page: page + 1, count })
    };

    for r in &edits.replacements {
        let id = (r.object.0, r.object.1);
        let is_image = doc
            .get_object(id)
            .and_then(Object::as_stream)
            .map(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image"))
            .unwrap_or(false);
        if !is_image {
            return Err(Error::NotAnImage(id.0, id.1));
        }
        let aspect = if r.box_height > 0.0 { Some(r.box_width / r.box_height) } else { None };
        let (image, mask) = image_xobject(&r.data, aspect)?;
        replace_image(doc, id, image, mask);
    }

    // Group drawing per page, in page order, so each page gets one stream.
    let mut per_page: Vec<PageDraw> = (0..count).map(|_| PageDraw::default()).collect();

    // Covers first so no edit's text or image ends up underneath another
    // edit's cover.
    for t in &edits.texts {
        page_id(t.page)?;
        if let Some(cover) = &t.cover {
            write_cover(&mut per_page[t.page as usize].ops, cover);
        }
    }
    for (i, img) in edits.images.iter().enumerate() {
        page_id(img.page)?;
        let (image, mask) = image_xobject(&img.data, None)?;
        let id = add_image(doc, image, mask);
        let name = format!("Lb{tag}Im{i}");
        let ops = &mut per_page[img.page as usize].ops;
        let (cos, sin) = rotation(img.angle);
        let (cx, cy) = (img.x + img.width / 2.0, img.y + img.height / 2.0);
        // Scale the unit square to the box, rotate about its centre.
        let _ = writeln!(ops, "q");
        let _ = writeln!(ops, "{} {} {} {} {} {} cm", n(cos), n(sin), n(-sin), n(cos), n(cx), n(cy));
        let _ =
            writeln!(ops, "{} 0 0 {} {} {} cm", n(img.width), n(img.height), n(-img.width / 2.0), n(-img.height / 2.0));
        let _ = writeln!(ops, "/{name} Do\nQ");
        per_page[img.page as usize].images.push((name, id));
    }
    for t in &edits.texts {
        if t.text.trim().is_empty() {
            continue;
        }
        let entry = &mut per_page[t.page as usize];
        let base_font = t.font.base_font(t.bold, t.italic);
        let font_name = match entry.fonts.iter().find(|(_, b)| *b == base_font) {
            Some((name, _)) => name.clone(),
            None => {
                let name = format!("Lb{tag}F{}", entry.fonts.len());
                entry.fonts.push((name.clone(), base_font));
                name
            }
        };
        write_text(&mut entry.ops, t, &font_name);
    }

    for (index, PageDraw { ops, fonts, images }) in per_page.into_iter().enumerate() {
        if ops.is_empty() {
            continue;
        }
        let page = pages[index];
        add_resources(doc, page, &fonts, &images)?;
        isolate_existing_content(doc, page)?;
        let mut stream = Stream::new(dictionary! {}, format!("q\n{ops}Q\n").into_bytes());
        let _ = stream.compress();
        let id = doc.add_object(stream);
        append_content(doc, page, id)?;
    }
    Ok(())
}

/// What one page gets drawn on top of its existing content.
#[derive(Default)]
struct PageDraw {
    ops: String,
    /// Resource name and standard font name.
    fonts: Vec<(String, &'static str)>,
    /// Resource name and image XObject.
    images: Vec<(String, ObjectId)>,
}

fn rotation(degrees: f32) -> (f32, f32) {
    let r = degrees.to_radians();
    let (sin, cos) = r.sin_cos();
    // Snap near-axis values so straight text stays exactly straight.
    let snap = |v: f32| if v.abs() < 1e-5 { 0.0 } else { v };
    (snap(cos), snap(sin))
}

/// Formats a number compactly for a content stream.
fn n(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn rgb(c: [f32; 3]) -> String {
    let [r, g, b] = c.map(|v| v.clamp(0.0, 1.0));
    format!("{} {} {}", n(r), n(g), n(b))
}

fn write_cover(ops: &mut String, cover: &Cover) {
    if cover.points.len() < 3 {
        return;
    }
    let _ = writeln!(ops, "q {} rg", rgb(cover.color));
    for (i, [x, y]) in cover.points.iter().enumerate() {
        let _ = writeln!(ops, "{} {} {}", n(*x), n(*y), if i == 0 { "m" } else { "l" });
    }
    let _ = writeln!(ops, "h f Q");
}

fn write_text(ops: &mut String, t: &TextEdit, font: &str) {
    let (cos, sin) = rotation(t.angle);
    let size = t.size.max(1.0);
    let _ = writeln!(ops, "q {} rg BT", rgb(t.color));
    let _ = writeln!(ops, "/{font} {} Tf {} TL", n(size), n(size * t.line_height.max(0.5)));
    let _ = writeln!(ops, "{} {} {} {} {} {} Tm", n(cos), n(sin), n(-sin), n(cos), n(t.x), n(t.y));
    for (i, line) in t.text.lines().enumerate() {
        if i > 0 {
            ops.push_str("T* ");
        }
        ops.push('<');
        for b in winansi::encode(line) {
            let _ = write!(ops, "{b:02X}");
        }
        ops.push_str("> Tj\n");
    }
    let _ = writeln!(ops, "ET Q");
}

/// Adds fonts and images to the page's resources. Shared resource
/// dictionaries are copied onto the page first so other pages are unaffected.
fn add_resources(
    doc: &mut Document,
    page: ObjectId,
    fonts: &[(String, &'static str)],
    images: &[(String, ObjectId)],
) -> Result<()> {
    let mut resources = page_resources(doc, page).unwrap_or_default();

    let mut font_dict = resources
        .get(b"Font")
        .ok()
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok().cloned())
        .unwrap_or_default();
    for (name, base) in fonts {
        let id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => *base,
            "Encoding" => "WinAnsiEncoding",
        });
        font_dict.set(name.as_bytes().to_vec(), id);
    }
    if !fonts.is_empty() {
        resources.set("Font", font_dict);
    }

    let mut xobject_dict = resources
        .get(b"XObject")
        .ok()
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok().cloned())
        .unwrap_or_default();
    for (name, id) in images {
        xobject_dict.set(name.as_bytes().to_vec(), *id);
    }
    if !images.is_empty() {
        resources.set("XObject", xobject_dict);
    }

    // Older readers want the procedure sets to list what the page uses.
    if let Ok(procs) = resources.get(b"ProcSet").and_then(|o| doc.dereference(o)).and_then(|(_, o)| o.as_array()) {
        let mut procs = procs.clone();
        for want in [&b"Text"[..], b"ImageB", b"ImageC"] {
            if !procs.iter().any(|p| p.as_name().ok() == Some(want)) {
                procs.push(Object::Name(want.to_vec()));
            }
        }
        resources.set("ProcSet", procs);
    }

    doc.get_dictionary_mut(page)?.set("Resources", resources);
    Ok(())
}

/// Wraps the page's current content in `q … Q` so any graphics state it
/// leaves behind (a transform, a clip, a colour) cannot leak into ours.
fn isolate_existing_content(doc: &mut Document, page: ObjectId) -> Result<()> {
    let existing = doc.get_page_contents(page);
    let open = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
    let close = doc.add_object(Stream::new(dictionary! {}, b"\nQ\n".to_vec()));
    let mut list: Vec<Object> = Vec::with_capacity(existing.len() + 2);
    list.push(open.into());
    list.extend(existing.into_iter().map(Object::Reference));
    list.push(close.into());
    doc.get_dictionary_mut(page)?.set("Contents", list);
    Ok(())
}

fn append_content(doc: &mut Document, page: ObjectId, stream: ObjectId) -> Result<()> {
    let page = doc.get_dictionary_mut(page)?;
    let mut list = match page.get(b"Contents") {
        Ok(Object::Array(items)) => items.clone(),
        Ok(other) => vec![other.clone()],
        Err(_) => Vec::new(),
    };
    list.push(stream.into());
    page.set("Contents", list);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::n;

    #[test]
    fn formats_numbers_compactly() {
        assert_eq!(n(1.0), "1");
        assert_eq!(n(0.5), "0.5");
        assert_eq!(n(-0.0), "0");
        assert_eq!(n(12.34567), "12.3457");
        assert_eq!(n(f32::NAN), "0");
    }
}
