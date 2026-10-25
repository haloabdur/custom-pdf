use std::io::Cursor;

use image::{ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use lembar_core::*;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

/// A document whose pages each say their own label, e.g. "A1", "A2". The
/// first page also draws an image and links to the last page. Resources live
/// on the Pages node, so pages inherit them.
fn sample(prefix: &str, pages: usize) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let img = RgbImage::from_pixel(4, 2, Rgb([200, 10, 10]));
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 2,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        img.into_raw(),
    ));
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
        "XObject" => dictionary! { "Im1" => image_id },
    });

    let mut kids = Vec::new();
    let mut page_ids = Vec::new();
    for i in 0..pages {
        let mut ops = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 24.into()]),
            Operation::new("Td", vec![72.into(), 700.into()]),
            Operation::new("Tj", vec![Object::string_literal(format!("{prefix}{}", i + 1))]),
            Operation::new("ET", vec![]),
        ];
        if i == 0 {
            // Leaves a transform behind on purpose (no q/Q).
            ops.push(Operation::new("cm", vec![200.into(), 0.into(), 0.into(), 100.into(), 50.into(), 300.into()]));
            ops.push(Operation::new("Do", vec!["Im1".into()]));
        }
        let content = Content { operations: ops };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
        });
        kids.push(page_id.into());
        page_ids.push(page_id);
    }
    if pages > 1 {
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Dest" => vec![Object::Reference(*page_ids.last().unwrap()), "Fit".into()],
        });
        doc.get_dictionary_mut(page_ids[0]).unwrap().set("Annots", vec![link.into()]);
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => pages as i64,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn reload(bytes: &[u8]) -> Document {
    load(Source::new(bytes)).expect("output must load")
}

fn page_labels(doc: &Document) -> Vec<String> {
    doc.get_pages()
        .values()
        .map(|&id| {
            let content = Content::decode(&doc.get_page_content(id)).unwrap();
            content
                .operations
                .iter()
                .find(|op| op.operator == "Tj")
                .map(|op| String::from_utf8_lossy(op.operands[0].as_str().unwrap()).into_owned())
                .unwrap_or_default()
        })
        .collect()
}

fn all_stream_text(doc: &Document) -> String {
    doc.objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .map(|s| String::from_utf8_lossy(&s.decompressed_content().unwrap_or_else(|_| s.content.clone())).into_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

fn png(w: u32, h: u32, alpha: u8) -> Vec<u8> {
    let img = RgbaImage::from_pixel(w, h, Rgba([0, 120, 255, alpha]));
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png).unwrap();
    out.into_inner()
}

#[test]
fn merges_reorders_and_duplicates() {
    let a = sample("A", 3);
    let b = sample("B", 2);
    let docs = vec![reload(&a), reload(&b)];
    let order = [PageRef::new(1, 0), PageRef::new(0, 2), PageRef::new(0, 0), PageRef::new(0, 0)];
    let mut out = compose(docs, &order).unwrap();
    let bytes = save(&mut out).unwrap();
    let doc = reload(&bytes);
    assert_eq!(page_labels(&doc), ["B1", "A3", "A1", "A1"]);
    // Every page kept its inherited size and resources.
    for id in doc.get_pages().values() {
        let page = doc.get_dictionary(*id).unwrap();
        assert!(page.has(b"MediaBox"));
        assert!(page.has(b"Resources"));
    }
    // The duplicate carries no annotations of its own.
    let ids: Vec<_> = doc.get_pages().into_values().collect();
    assert!(doc.get_dictionary(ids[2]).unwrap().has(b"Annots"));
    assert!(!doc.get_dictionary(ids[3]).unwrap().has(b"Annots"));
}

#[test]
fn split_drops_pages_that_are_left_out() {
    let a = sample("A", 4);
    // Page 1 links to page 4; extracting page 1 alone must not pull page 4 in.
    let mut out = compose(vec![reload(&a)], &[PageRef::new(0, 0)]).unwrap();
    let bytes = save(&mut out).unwrap();
    let doc = reload(&bytes);
    assert_eq!(page_labels(&doc), ["A1"]);
    let text = all_stream_text(&doc);
    assert!(text.contains("(A1)"));
    for gone in ["(A2)", "(A3)", "(A4)"] {
        assert!(!text.contains(gone), "{gone} should have been dropped");
    }
}

#[test]
fn rejects_bad_requests() {
    let a = sample("A", 2);
    assert!(matches!(compose(vec![reload(&a)], &[]), Err(Error::NoPages)));
    assert!(matches!(compose(vec![reload(&a)], &[PageRef::new(0, 5)]), Err(Error::PageOutOfRange { .. })));
    assert!(matches!(compose(vec![reload(&a)], &[PageRef::new(3, 0)]), Err(Error::SourceOutOfRange(3))));
    assert!(matches!(load(Source::new(b"hello")), Err(Error::NotPdf)));
}

#[test]
fn opens_encrypted_files_with_a_password() {
    let mut doc = reload(&sample("A", 2));
    let id = Object::string_literal(b"0123456789abcdef".to_vec());
    doc.trailer.set("ID", vec![id.clone(), id]);
    let state = lopdf::EncryptionState::try_from(lopdf::EncryptionVersion::V2 {
        document: &doc,
        owner_password: "pemilik",
        user_password: "rahasia",
        key_length: 128,
        permissions: lopdf::Permissions::all(),
    })
    .unwrap();
    doc.encrypt(&state).unwrap();
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();

    assert!(matches!(load(Source::new(&bytes)), Err(Error::PasswordRequired)));
    assert!(matches!(load(Source::with_password(&bytes, Some("salah"))), Err(Error::WrongPassword)));
    let doc = load(Source::with_password(&bytes, Some("rahasia"))).unwrap();
    let mut out = compose(vec![doc], &[PageRef::new(0, 1)]).unwrap();
    let plain = save(&mut out).unwrap();
    assert_eq!(page_labels(&reload(&plain)), ["A2"], "output is readable without a password");
}

#[test]
fn finds_images_with_their_boxes() {
    let doc = reload(&sample("A", 2));
    let hits = list_images(&doc);
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert_eq!(hit.page, 0);
    assert_eq!(hit.bbox, [50.0, 300.0, 250.0, 400.0]);
    assert_eq!((hit.width, hit.height), (200.0, 100.0));
    assert_eq!((hit.pixel_width, hit.pixel_height), (4, 2));
}

#[test]
fn applies_text_and_image_edits() {
    let mut doc = reload(&sample("A", 2));
    let target = list_images(&doc)[0].clone();
    let edits = EditSet {
        texts: vec![TextEdit {
            page: 0,
            text: "Halo “dunia”\nbaris dua".into(),
            x: 72.0,
            y: 700.0,
            size: 24.0,
            angle: 0.0,
            font: FontFamily::Serif,
            bold: true,
            italic: false,
            color: [0.1, 0.2, 0.3],
            line_height: 1.2,
            cover: Some(Cover {
                points: vec![[70.0, 690.0], [130.0, 690.0], [130.0, 725.0], [70.0, 725.0]],
                color: [1.0, 1.0, 1.0],
            }),
        }],
        images: vec![ImagePlacement {
            page: 1,
            x: 100.0,
            y: 100.0,
            width: 120.0,
            height: 60.0,
            angle: 0.0,
            data: png(40, 20, 128),
        }],
        replacements: vec![ImageReplacement {
            object: target.object,
            box_width: target.width,
            box_height: target.height,
            // A square picture into a 2:1 box gets cropped to 2:1.
            data: png(64, 64, 255),
        }],
    };
    apply_edits(&mut doc, &edits).unwrap();
    let bytes = save(&mut doc).unwrap();
    let doc = reload(&bytes);

    let pages: Vec<_> = doc.get_pages().into_values().collect();
    let page1 = String::from_utf8_lossy(&doc.get_page_content(pages[0])).into_owned();
    // The original content is still there, untouched, followed by ours.
    assert!(page1.contains("(A1) Tj"));
    assert!(page1.contains("1 1 1 rg"));
    assert!(page1.contains("<48616C6F209364756E696194> Tj"));
    assert!(page1.contains("T* <626172697320647561> Tj"));
    let fonts = doc.get_page_fonts(pages[0]).unwrap();
    assert!(fonts.values().any(|f| f.get(b"BaseFont").unwrap().as_name().unwrap() == b"Times-Bold"));

    let hits = list_images(&doc);
    let replaced = hits.iter().find(|h| h.page == 0).unwrap();
    assert_eq!(replaced.bbox, [50.0, 300.0, 250.0, 400.0], "box is unchanged");
    assert_eq!((replaced.pixel_width, replaced.pixel_height), (64, 32), "cropped to the box aspect");

    // Page 2 gained the placed image, with a soft mask for its transparency.
    let placed = hits.iter().find(|h| h.page == 1).unwrap();
    assert_eq!(placed.bbox, [100.0, 100.0, 220.0, 160.0]);
    let stream = doc.get_object((placed.object.0, placed.object.1)).unwrap().as_stream().unwrap();
    assert!(stream.dict.has(b"SMask"));
}

#[test]
fn editing_twice_keeps_earlier_edits() {
    let edit = |label: &str| EditSet {
        texts: vec![TextEdit {
            page: 0,
            text: label.into(),
            x: 10.0,
            y: 10.0,
            size: 10.0,
            angle: 0.0,
            font: FontFamily::Mono,
            bold: false,
            italic: false,
            color: [0.0; 3],
            line_height: 1.2,
            cover: None,
        }],
        ..Default::default()
    };
    let mut doc = reload(&sample("A", 1));
    apply_edits(&mut doc, &edit("one")).unwrap();
    let first = save(&mut doc).unwrap();

    let mut doc = reload(&first);
    let mut second = edit("two");
    second.texts[0].font = FontFamily::Sans;
    apply_edits(&mut doc, &second).unwrap();
    let bytes = save(&mut doc).unwrap();
    let doc = reload(&bytes);
    let page = *doc.get_pages().values().next().unwrap();
    let fonts = doc.get_page_fonts(page).unwrap();
    let bases: Vec<_> = fonts.values().map(|f| f.get(b"BaseFont").unwrap().as_name().unwrap().to_vec()).collect();
    assert!(bases.contains(&b"Courier".to_vec()), "first edit's font survives: {bases:?}");
    assert!(bases.contains(&b"Helvetica".to_vec()));
}

#[test]
fn split_ranges_end_to_end() {
    let a = sample("A", 5);
    let groups = parse_ranges("1-2, 5, 4-3", 5).unwrap();
    let labels: Vec<Vec<String>> = groups
        .iter()
        .map(|g| {
            let order: Vec<_> = g.iter().map(|&p| PageRef::new(0, p)).collect();
            let mut out = compose(vec![reload(&a)], &order).unwrap();
            page_labels(&reload(&save(&mut out).unwrap()))
        })
        .collect();
    assert_eq!(labels, vec![vec!["A1", "A2"], vec!["A5"], vec!["A4", "A3"]]);
}
