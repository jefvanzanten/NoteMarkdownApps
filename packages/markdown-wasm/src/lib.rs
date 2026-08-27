#![cfg_attr(not(any(test, target_arch = "wasm32")), allow(dead_code))]

use pulldown_cmark::{CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd, html::push_html};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderHeading {
    level: u8,
    text: String,
    id: String,
    source_start: usize,
    source_end: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderResult {
    html: String,
    headings: Vec<RenderHeading>,
    links: Vec<String>,
    images: Vec<String>,
    code_languages: Vec<String>,
}

/// Returns the GFM-compatible parser options enabled by NoteMarkdown.
///
/// # Returns
/// The parser feature set shared by native tests and WASM rendering.
fn parser_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
}

/// Produces a stable, unique heading anchor.
///
/// # Arguments
/// * `text` - Visible heading text.
/// * `used` - Anchor counts already allocated in this document.
///
/// # Returns
/// A GitHub-like lowercase anchor with a numeric collision suffix.
fn heading_slug(text: &str, used: &mut HashMap<String, usize>) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for character in text.to_lowercase().chars() {
        if character.is_alphanumeric() || character == '_' {
            slug.push(character);
            previous_dash = false;
        } else if (character.is_whitespace() || character == '-')
            && !previous_dash
            && !slug.is_empty()
        {
            slug.push('-');
            previous_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug.push_str("section");
    }
    let count = used.entry(slug.clone()).or_insert(0);
    let unique = if *count == 0 {
        slug.clone()
    } else {
        format!("{slug}-{count}")
    };
    *count += 1;
    unique
}

/// Determines whether a Markdown destination may be emitted into preview HTML.
///
/// # Arguments
/// * `destination` - Authored link or image target.
/// * `is_image` - Whether the destination belongs to an image.
///
/// # Returns
/// `true` for approved web links, anchors, and provider-relative assets.
fn is_safe_destination(destination: &str, is_image: bool) -> bool {
    let trimmed = destination.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return true;
    }
    if trimmed.starts_with("//") || trimmed.chars().any(char::is_control) {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return !is_image;
    }
    if lower.starts_with("mailto:") {
        return !is_image;
    }
    !trimmed.contains(':') && !trimmed.starts_with('/')
}

/// Replaces unsafe destinations without preserving an executable scheme.
///
/// # Arguments
/// * `destination` - Authored Markdown destination.
/// * `is_image` - Whether the destination belongs to an image.
///
/// # Returns
/// The original safe value or a harmless anchor.
fn safe_destination(destination: CowStr<'_>, is_image: bool) -> CowStr<'static> {
    if is_safe_destination(destination.as_ref(), is_image) {
        CowStr::Boxed(destination.into_string().into_boxed_str())
    } else {
        CowStr::Borrowed("#")
    }
}

/// Extracts metadata in one offset-aware pass before HTML generation.
///
/// # Arguments
/// * `markdown` - UTF-8 Markdown source.
///
/// # Returns
/// Heading, link, image, and code-language metadata.
fn collect_metadata(markdown: &str) -> (Vec<RenderHeading>, Vec<String>, Vec<String>, Vec<String>) {
    let mut headings = Vec::new();
    let mut links = Vec::new();
    let mut images = Vec::new();
    let mut languages = HashSet::new();
    let mut used_slugs = HashMap::new();
    let mut current_heading: Option<(u8, usize, String)> = None;

    for (event, range) in Parser::new_ext(markdown, parser_options()).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current_heading = Some((level as u8, range.start, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, source_start, text)) = current_heading.take() {
                    let id = heading_slug(&text, &mut used_slugs);
                    headings.push(RenderHeading {
                        level,
                        text,
                        id,
                        source_start,
                        source_end: range.end,
                    });
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, _, heading_text)) = &mut current_heading {
                    heading_text.push_str(text.as_ref());
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => links.push(dest_url.to_string()),
            Event::Start(Tag::Image { dest_url, .. }) => images.push(dest_url.to_string()),
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(language))) => {
                let language = language.trim().to_ascii_lowercase();
                if !language.is_empty() {
                    languages.insert(language);
                }
            }
            _ => {}
        }
    }

    let mut code_languages: Vec<String> = languages.into_iter().collect();
    code_languages.sort();
    (headings, links, images, code_languages)
}

/// Converts Markdown into safe GFM HTML and coarse preview metadata.
///
/// # Arguments
/// * `markdown` - UTF-8 Markdown source.
///
/// # Returns
/// A serializable render result with raw HTML escaped and unsafe URLs removed.
fn render_markdown(markdown: &str) -> RenderResult {
    let (headings, links, images, code_languages) = collect_metadata(markdown);
    let heading_ids: Vec<String> = headings.iter().map(|heading| heading.id.clone()).collect();
    let mut heading_index = 0usize;
    let events = Parser::new_ext(markdown, parser_options()).map(|event| match event {
        Event::Html(html) | Event::InlineHtml(html) => Event::Text(html),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: safe_destination(dest_url, false),
            title: CowStr::Boxed(title.into_string().into_boxed_str()),
            id: CowStr::Boxed(id.into_string().into_boxed_str()),
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: safe_destination(dest_url, true),
            title: CowStr::Boxed(title.into_string().into_boxed_str()),
            id: CowStr::Boxed(id.into_string().into_boxed_str()),
        }),
        Event::Start(Tag::Heading {
            level,
            classes,
            attrs,
            ..
        }) => {
            let heading_id = heading_ids
                .get(heading_index)
                .cloned()
                .unwrap_or_else(|| format!("section-{heading_index}"));
            heading_index += 1;
            Event::Start(Tag::Heading {
                level,
                id: Some(CowStr::Boxed(heading_id.into_boxed_str())),
                classes,
                attrs,
            })
        }
        other => other,
    });
    let mut html = String::with_capacity(markdown.len());
    push_html(&mut html, events);
    RenderResult {
        html,
        headings,
        links,
        images,
        code_languages,
    }
}

/// Serializes one Markdown render for the coarse WASM ABI.
///
/// # Arguments
/// * `markdown` - UTF-8 Markdown source.
///
/// # Returns
/// JSON bytes containing safe HTML and metadata.
#[allow(dead_code)]
fn render_json(markdown: &str) -> Vec<u8> {
    serde_json::to_vec(&render_markdown(markdown)).expect("render result must be serializable")
}

/// Allocates input memory that JavaScript can fill before a render call.
///
/// # Arguments
/// * `length` - Number of UTF-8 input bytes.
///
/// # Returns
/// Pointer into linear WASM memory.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    let mut buffer = vec![0_u8; length].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Renders one owned UTF-8 input buffer and leaks the output for JS to read.
///
/// # Arguments
/// * `pointer` - Input allocation returned by `allocate`.
/// * `length` - Number of initialized UTF-8 bytes.
///
/// # Returns
/// Packed output pointer in the high 32 bits and output length in the low 32 bits.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn render(pointer: *mut u8, length: usize) -> u64 {
    let input_slice = std::ptr::slice_from_raw_parts_mut(pointer, length);
    let bytes = unsafe { Box::from_raw(input_slice) }.into_vec();
    let output = match String::from_utf8(bytes) {
        Ok(markdown) => render_json(&markdown),
        Err(error) => serde_json::to_vec(&serde_json::json!({
            "html": "",
            "headings": [],
            "links": [],
            "images": [],
            "codeLanguages": [],
            "error": error.to_string(),
        }))
        .expect("error result must be serializable"),
    };
    let output = output.into_boxed_slice();
    let output_length = output.len() as u64;
    let output_pointer = output.as_ptr() as u64;
    std::mem::forget(output);
    (output_pointer << 32) | output_length
}

/// Releases an output allocation after JavaScript has copied it.
///
/// # Arguments
/// * `pointer` - Output pointer unpacked from `render`.
/// * `length` - Output length unpacked from `render`.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deallocate(pointer: *mut u8, length: usize) {
    let output_slice = std::ptr::slice_from_raw_parts_mut(pointer, length);
    unsafe {
        drop(Box::from_raw(output_slice));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies enabled GFM features and heading anchors.
    #[test]
    fn renders_gfm_and_heading_anchors() {
        let result =
            render_markdown("# Hello world\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done");
        assert!(result.html.contains("id=\"hello-world\""));
        assert!(result.html.contains("<table>"));
        assert!(result.html.contains("type=\"checkbox\""));
    }

    /// Verifies that authored HTML and executable URLs cannot become active preview markup.
    #[test]
    fn suppresses_unsafe_content() {
        let result = render_markdown(
            "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![x](data:image/svg+xml,bad)",
        );
        assert!(!result.html.contains("<script>"));
        assert!(!result.html.contains("javascript:"));
        assert!(!result.html.contains("data:image"));
        assert!(result.html.contains("&lt;script&gt;"));
    }

    /// Verifies language metadata used for lazy browser highlighting.
    #[test]
    fn extracts_code_languages() {
        let result = render_markdown("```typescript\nconst value = 1;\n```");
        assert_eq!(result.code_languages, vec!["typescript"]);
    }
}
