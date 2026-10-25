use std::collections::{BTreeMap, HashSet};

use lopdf::{dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// A page to place in the output: page `page` (zero-based) of source `source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRef {
    pub source: usize,
    pub page: u32,
}

impl PageRef {
    pub fn new(source: usize, page: u32) -> Self {
        Self { source, page }
    }
}

/// Keys a page may inherit from its ancestors in the page tree. They are
/// copied onto the page itself before it is moved under a new parent.
const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Builds a new document containing exactly the pages in `order`, in that
/// order. A page may appear more than once. Everything a chosen page draws
/// (fonts, images, annotations) comes along; the rest of each source is
/// dropped, including links that point at pages left out.
pub fn compose(sources: Vec<Document>, order: &[PageRef]) -> Result<Document> {
    if order.is_empty() {
        return Err(Error::NoPages);
    }

    let mut out = Document::with_version("1.7");
    let mut next_id = 1;
    // Per source: its pages' new ids, in page order.
    let mut page_ids: Vec<Vec<ObjectId>> = Vec::with_capacity(sources.len());
    // Object ids that belonged to the old page trees (pages and Pages nodes)
    // and old catalogs; references to the ones we don't keep get cut.
    let mut old_structure: HashSet<ObjectId> = HashSet::new();
    let mut highest_version = out.version.clone();

    for mut doc in sources {
        if doc.version > highest_version {
            highest_version = doc.version.clone();
        }
        flatten_inherited(&mut doc);
        doc.renumber_objects_with(next_id);
        next_id = doc.max_id + 1;

        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        for &id in &pages {
            collect_tree_nodes(&doc, id, &mut old_structure);
        }
        if let Ok(root) = doc.trailer.get(b"Root").and_then(Object::as_reference) {
            old_structure.insert(root);
        }
        page_ids.push(pages);
        out.objects.extend(doc.objects);
    }
    out.version = highest_version;
    out.max_id = next_id - 1;

    let pages_id = out.new_object_id();
    let mut kids = Vec::with_capacity(order.len());
    let mut used: HashSet<ObjectId> = HashSet::new();

    for r in order {
        let pages = page_ids.get(r.source).ok_or(Error::SourceOutOfRange(r.source))?;
        let &orig =
            pages.get(r.page as usize).ok_or(Error::PageOutOfRange { page: r.page + 1, count: pages.len() as u32 })?;
        let id = if used.insert(orig) {
            orig
        } else {
            // Same page again: a shallow copy shares contents and resources,
            // but annotations belong to exactly one page, so the copy has none.
            let mut copy = out.get_dictionary(orig)?.clone();
            copy.remove(b"Annots");
            copy.remove(b"StructParents");
            out.add_object(copy)
        };
        let page = out.get_dictionary_mut(id)?;
        page.set("Parent", pages_id);
        page.remove(b"StructParents");
        kids.push(Object::Reference(id));
    }

    let kept: HashSet<ObjectId> = kids.iter().filter_map(|k| k.as_reference().ok()).collect();
    let cut: HashSet<ObjectId> = old_structure.difference(&kept).copied().collect();
    cut_references(&mut out, &cut);
    for id in &cut {
        out.objects.remove(id);
    }

    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Count" => kids.len() as i64,
            "Kids" => kids,
        }),
    );
    let catalog_id = out.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    out.trailer.set("Root", catalog_id);
    Ok(out)
}

/// Copies inherited attributes down onto every page so that each page is
/// self-contained.
fn flatten_inherited(doc: &mut Document) {
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    for page_id in pages {
        let mut found: BTreeMap<&[u8], Object> = BTreeMap::new();
        let Ok(page) = doc.get_dictionary(page_id) else { continue };
        let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
        let mut seen = HashSet::new();
        while let Some(pid) = parent {
            if !seen.insert(pid) {
                break;
            }
            let Ok(node) = doc.get_dictionary(pid) else { break };
            for key in INHERITABLE {
                if !page.has(key) && !found.contains_key(key) {
                    if let Ok(v) = node.get(key) {
                        found.insert(key, v.clone());
                    }
                }
            }
            parent = node.get(b"Parent").and_then(Object::as_reference).ok();
        }
        if !found.is_empty() {
            if let Ok(page) = doc.get_dictionary_mut(page_id) {
                for (k, v) in found {
                    page.set(k.to_vec(), v);
                }
            }
        }
    }
}

fn collect_tree_nodes(doc: &Document, page: ObjectId, into: &mut HashSet<ObjectId>) {
    let mut cur = Some(page);
    while let Some(id) = cur {
        if !into.insert(id) && id != page {
            break;
        }
        cur = doc.get_dictionary(id).ok().and_then(|d| d.get(b"Parent").and_then(Object::as_reference).ok());
    }
}

/// Replaces every reference to an id in `cut` with `null`, so dropped pages
/// and page-tree nodes are not dragged back in through links or form fields.
fn cut_references(doc: &mut Document, cut: &HashSet<ObjectId>) {
    fn walk(obj: &mut Object, cut: &HashSet<ObjectId>) {
        match obj {
            Object::Reference(id) if cut.contains(id) => *obj = Object::Null,
            Object::Array(items) => items.iter_mut().for_each(|o| walk(o, cut)),
            Object::Dictionary(d) => d.iter_mut().for_each(|(_, v)| walk(v, cut)),
            Object::Stream(s) => s.dict.iter_mut().for_each(|(_, v)| walk(v, cut)),
            _ => {}
        }
    }
    for (id, obj) in doc.objects.iter_mut() {
        if !cut.contains(id) {
            walk(obj, cut);
        }
    }
}
