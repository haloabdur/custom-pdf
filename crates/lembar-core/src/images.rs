use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use lopdf::content::Content;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use serde::Serialize;

use crate::geometry::Matrix;
use crate::Result;

/// An image drawn on a page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageHit {
    /// Zero-based page index.
    pub page: u32,
    /// The image XObject (object number, generation).
    pub object: (u32, u16),
    /// `[x0, y0, x1, y1]` in the page's user space.
    pub bbox: [f32; 4],
    /// Drawn size in points, before any rotation.
    pub width: f32,
    pub height: f32,
    /// Pixel size of the stored image.
    pub pixel_width: u32,
    pub pixel_height: u32,
}

const MAX_FORM_DEPTH: usize = 8;

/// Finds every image XObject drawn on every page, including inside form
/// XObjects. Inline images (`BI … EI`) are not reported.
pub fn list_images(doc: &Document) -> Vec<ImageHit> {
    let mut hits = Vec::new();
    for (index, (_, page_id)) in doc.get_pages().into_iter().enumerate() {
        let Some(resources) = page_resources(doc, page_id) else { continue };
        let content = doc.get_page_content(page_id);
        scan(doc, &content, &resources, Matrix::IDENTITY, index as u32, 0, &mut hits);
    }
    hits
}

/// The Resources dictionary a page draws with, following inheritance.
pub(crate) fn page_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    let mut node = doc.get_dictionary(page_id).ok()?;
    for _ in 0..32 {
        if let Ok(res) = node.get(b"Resources") {
            return doc.dereference(res).ok()?.1.as_dict().ok().cloned();
        }
        let parent = node.get(b"Parent").and_then(Object::as_reference).ok()?;
        node = doc.get_dictionary(parent).ok()?;
    }
    None
}

fn scan(
    doc: &Document,
    content: &[u8],
    resources: &Dictionary,
    base: Matrix,
    page: u32,
    depth: usize,
    hits: &mut Vec<ImageHit>,
) {
    let Ok(content) = Content::decode(content) else { return };
    let xobjects =
        resources.get(b"XObject").ok().and_then(|o| doc.dereference(o).ok()).and_then(|(_, o)| o.as_dict().ok());

    let mut ctm = base;
    let mut stack: Vec<Matrix> = Vec::new();
    for op in content.operations {
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(base),
            "cm" if op.operands.len() == 6 => {
                let mut m = [0.0; 6];
                for (slot, o) in m.iter_mut().zip(&op.operands) {
                    *slot = o.as_float().unwrap_or(0.0);
                }
                ctm = Matrix(m).then(ctm);
            }
            "Do" => {
                let (Some(xobjects), Some(name)) = (xobjects, op.operands.first().and_then(|o| o.as_name().ok()))
                else {
                    continue;
                };
                let Ok(id) = xobjects.get(name).and_then(Object::as_reference) else { continue };
                let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
                match stream.dict.get(b"Subtype").and_then(Object::as_name) {
                    Ok(b"Image") => {
                        if stream.dict.get(b"ImageMask").and_then(Object::as_bool).unwrap_or(false) {
                            continue;
                        }
                        let (width, height) = ctm.scale();
                        hits.push(ImageHit {
                            page,
                            object: id,
                            bbox: ctm.unit_square_bounds(),
                            width,
                            height,
                            pixel_width: dict_u32(&stream.dict, b"Width"),
                            pixel_height: dict_u32(&stream.dict, b"Height"),
                        });
                    }
                    Ok(b"Form") if depth < MAX_FORM_DEPTH => {
                        let matrix = stream
                            .dict
                            .get(b"Matrix")
                            .and_then(Object::as_array)
                            .ok()
                            .filter(|a| a.len() == 6)
                            .map(|a| {
                                let mut m = [0.0; 6];
                                for (slot, o) in m.iter_mut().zip(a) {
                                    *slot = o.as_float().unwrap_or(0.0);
                                }
                                Matrix(m)
                            })
                            .unwrap_or(Matrix::IDENTITY);
                        let form_resources = stream
                            .dict
                            .get(b"Resources")
                            .ok()
                            .and_then(|o| doc.dereference(o).ok())
                            .and_then(|(_, o)| o.as_dict().ok())
                            .unwrap_or(resources);
                        let Ok(body) = stream.decompressed_content().or_else(|_| Ok::<_, ()>(stream.content.clone()))
                        else {
                            continue;
                        };
                        scan(doc, &body, form_resources, matrix.then(ctm), page, depth + 1, hits);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

fn dict_u32(dict: &Dictionary, key: &[u8]) -> u32 {
    dict.get(key).and_then(Object::as_i64).unwrap_or(0).max(0) as u32
}

/// Longest side, in pixels, an inserted image is stored at.
const MAX_SIDE: u32 = 4096;

/// Decodes `data` (JPEG, PNG, WebP, GIF or BMP), honours EXIF orientation and,
/// when `aspect` (width / height) is given, crops it centred to that aspect
/// so it fills a box exactly. Returns the image XObject and, for images with
/// transparency, its soft mask; the caller stores the mask and links it.
pub(crate) fn image_xobject(data: &[u8], aspect: Option<f32>) -> Result<(Stream, Option<Stream>)> {
    let mut decoder = ImageReader::new(Cursor::new(data)).with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);

    if let Some(aspect) = aspect.filter(|a| a.is_finite() && *a > 0.0) {
        let (w, h) = img.dimensions();
        let current = w as f32 / h as f32;
        if (current - aspect).abs() / aspect > 0.01 {
            let (cw, ch) = if current > aspect {
                (((h as f32) * aspect).round().max(1.0) as u32, h)
            } else {
                (w, ((w as f32) / aspect).round().max(1.0) as u32)
            };
            img = img.crop_imm((w - cw) / 2, (h - ch) / 2, cw, ch);
        }
    }
    if img.width().max(img.height()) > MAX_SIDE {
        img = img.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Lanczos3);
    }

    let (w, h) = img.dimensions();
    let has_alpha = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255);

    if has_alpha {
        let rgba = img.to_rgba8();
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        let mut alpha = Vec::with_capacity((w * h) as usize);
        for p in rgba.pixels() {
            rgb.extend_from_slice(&p.0[..3]);
            alpha.push(p.0[3]);
        }
        let mut mask = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => w as i64,
                "Height" => h as i64,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            alpha,
        );
        let _ = mask.compress();
        let mut image = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => w as i64,
                "Height" => h as i64,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Interpolate" => true,
            },
            rgb,
        );
        let _ = image.compress();
        Ok((image, Some(mask)))
    } else {
        let rgb = img.to_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90).encode_image(&rgb)?;
        let image = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => w as i64,
                "Height" => h as i64,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
                "Interpolate" => true,
            },
            jpeg,
        )
        .with_compression(false);
        Ok((image, None))
    }
}

/// Stores an image (and its mask) in `doc`, returning the image's id.
pub(crate) fn add_image(doc: &mut Document, image: Stream, mask: Option<Stream>) -> ObjectId {
    let mut image = image;
    if let Some(mask) = mask {
        let mask_id = doc.add_object(mask);
        image.dict.set("SMask", mask_id);
    }
    doc.add_object(image)
}

/// Swaps the contents of image XObject `id` for `image`, keeping its id so
/// every place that draws it shows the new picture in the same box.
pub(crate) fn replace_image(doc: &mut Document, id: ObjectId, image: Stream, mask: Option<Stream>) {
    let mut image = image;
    if let Some(mask) = mask {
        let mask_id = doc.add_object(mask);
        image.dict.set("SMask", mask_id);
    }
    doc.objects.insert(id, Object::Stream(image));
}
