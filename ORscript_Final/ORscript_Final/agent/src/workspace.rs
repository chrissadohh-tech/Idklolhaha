// SPDX-License-Identifier: GPL-3.0-or-later
// workspace.rs - OR LOCAL engine (AgentScript).
//
// Native Rust port of OpenRender's workspace_mcp.py: full control over ONE
// local folder ("the workspace") - list/tree/read/write/edit/move/delete,
// glob + content search, and terminal execution - served to the extension
// over the same legacy WS protocol as the roblox engine (port 17615).
//
// Safety model (mirrors OpenRender, no Python involved):
//   * every path resolves against the workspace root; absolute paths and any
//     ".." climb that escapes the root are refused BEFORE touching the disk;
//   * the deepest EXISTING ancestor is canonicalized so symlink/junction
//     escapes are caught too (not-yet-existing targets resolve via parent);
//   * the root itself can never be deleted or moved;
//   * reads cap at 2 MB, text results clip at 40 K chars, command output at
//     8 K per stream, run_command hard-times-out (60 s default / 600 s max).
//
// All I/O is tokio-async; writes are byte-exact (no newline translation).
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const MAX_TEXT_CHARS: usize = 40_000;
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// Cap for the extension's binary (screenshot) read. A 1000px viewport PNG is
/// well under this; the ceiling just stops a stray 100 MB file from being
/// base64'd over the socket.
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_RUN_OUTPUT: usize = 8_000;
const DEFAULT_RUN_TIMEOUT: u64 = 60;
const MAX_RUN_TIMEOUT: u64 = 600;
const GREP_MAX_RESULTS: usize = 100;
const TREE_DEFAULT_DEPTH: usize = 3;
const TREE_MAX_DEPTH: usize = 8;
const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", "dist", "build", ".next", "coverage",
];

pub struct Workspace {
    /// Canonicalized root - every sandbox check compares against this.
    canon_root: PathBuf,
    /// FULL PC ACCESS mode: when set, absolute paths anywhere on the machine
    /// are allowed (the sandbox only guards the default workspace-relative
    /// behavior). Flipped at runtime via POST /api/local-full. Shared with the
    /// GUI status window so the badge is always live.
    full_access: Arc<AtomicBool>,
}

impl Workspace {
    /// Resolve the workspace root from (in order) an explicit override,
    /// OR_WORKSPACE_ROOT / ROBLOXSCRIPT_WORKSPACE_ROOT, or USERPROFILE/ORWorkspace.
    /// The folder is created when missing so a fresh install just works.
    pub fn new(override_dir: Option<&str>) -> anyhow::Result<Self> {
        let chosen = override_dir
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| std::env::var("OR_WORKSPACE_ROOT").ok())
            .or_else(|| std::env::var("ROBLOXSCRIPT_WORKSPACE_ROOT").ok())
            .unwrap_or_else(|| {
                let home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".to_string());
                Path::new(&home).join("ORWorkspace").to_string_lossy().to_string()
            });
        let root = PathBuf::from(chosen);
        std::fs::create_dir_all(&root)
            .map_err(|e| anyhow::anyhow!("workspace root {} unavailable: {e}", root.display()))?;
        let canon_root = std::fs::canonicalize(&root)
            .map_err(|e| anyhow::anyhow!("cannot canonicalize {}: {e}", root.display()))?;
        tracing::info!("workspace root: {}", canon_root.display());
        Ok(Self { canon_root, full_access: Arc::new(AtomicBool::new(false)) })
    }

    pub fn root_display(&self) -> String { deverbatim_string(&self.canon_root) }

    pub fn ready(&self) -> bool { self.canon_root.is_dir() }

    pub fn full_access(&self) -> bool { self.full_access.load(Ordering::Relaxed) }

    /// Handle to share with the GUI so its FULL badge mirrors live state.
    pub fn full_flag(&self) -> Arc<AtomicBool> { Arc::clone(&self.full_access) }

    pub fn set_full_access(&self, on: bool) {
        self.full_access.store(on, Ordering::Relaxed);
        tracing::info!("FULL PC ACCESS {}", if on { "ENABLED" } else { "disabled" });
    }

    /// Sandbox core. `rel` must be relative; ".." may not climb above the
    /// root; the deepest existing ancestor is canonicalized against the
    /// canonical root to defeat symlink/junction escapes.
    /// In FULL PC ACCESS mode absolute paths anywhere are allowed.
    fn resolve_path(&self, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
        let raw = rel.trim();
        if raw.is_empty() || raw == "." || raw == "/" || raw == "\\" {
            return Ok(self.canon_root.clone());
        }
        // FULL ACCESS: absolute paths bypass the sandbox entirely. Relative
        // paths still anchor at the workspace root (a sane default cwd).
        if self.full_access.load(Ordering::Relaxed)
            && (Path::new(raw).is_absolute() || is_windows_absolute(raw) || raw.starts_with('/'))
        {
            let p = PathBuf::from(raw);
            if must_exist && !p.exists() {
                return Err(format!("'{raw}' does not exist"));
            }
            return Ok(p);
        }
        let raw = raw.replace('\\', "/");
        if raw.is_empty() { return Ok(self.canon_root.clone()); }
        if raw.starts_with('/') || Path::new(&raw).is_absolute() || is_windows_absolute(&raw) {
            return Err(format!("paths must be relative to the workspace root, got '{raw}'"));
        }
        // Lexical walk: reject escapes without touching the filesystem.
        let mut depth: i64 = 0;
        for comp in Path::new(&raw).components() {
            match comp {
                Component::Normal(_) => depth += 1,
                Component::CurDir => {}
                Component::ParentDir => {
                    depth -= 1;
                    if depth < 0 {
                        return Err(format!("path '{raw}' is outside the workspace"));
                    }
                }
                _ => return Err(format!("path '{raw}' is outside the workspace")),
            }
        }
        let joined = self.canon_root.join(&raw);
        // Symlink/junction defense on the existing part of the path.
        let mut probe = joined.clone();
        let mut tail: Vec<PathBuf> = Vec::new();
        while !probe.exists() && probe != self.canon_root {
            match (probe.file_name().map(|n| n.to_os_string()), probe.parent().map(Path::to_path_buf)) {
                (Some(name), Some(parent)) => {
                    tail.push(PathBuf::from(name));
                    probe = parent;
                }
                _ => break,
            }
        }
        if probe.exists() {
            let canon = std::fs::canonicalize(&probe)
                .map_err(|e| format!("cannot resolve '{}': {e}", rel.trim()))?;
            if !canon.starts_with(&self.canon_root) {
                return Err(format!("path '{}' is outside the workspace", rel.trim()));
            }
        }
        let mut final_path = probe;
        for seg in tail.iter().rev() { final_path.push(seg); }
        if must_exist && !final_path.exists() {
            return Err(format!("'{}' does not exist in the workspace", rel.trim()));
        }
        Ok(final_path)
    }

    fn display(&self, p: &Path) -> String {
        // Compare with the verbatim (\\?\) prefix stripped on BOTH sides:
        // fs::canonicalize yields verbatim paths but glob/readdir do not.
        let base = deverbatim_string(&self.canon_root).replace('\\', "/");
        let ps = deverbatim_string(p).replace('\\', "/");
        if ps == base { return ".".to_string(); }
        ps.strip_prefix(&format!("{base}/")).unwrap_or(&ps).to_string()
    }
}

/// Strip Windows verbatim prefixes so users never see "\\?\C:\...".
fn deverbatim_string(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") { return format!(r"\\{rest}"); }
    if let Some(rest) = s.strip_prefix(r"\\?\") { return rest.to_string(); }
    s
}

/// Windows drive-letter check ("C:/...") that Path::is_absolute misses when
/// the input arrived with forward slashes.
fn is_windows_absolute(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit { return text.to_string(); }
    let mut cut = limit;
    while cut > 0 && !text.is_char_boundary(cut) { cut -= 1; }
    format!("{}\n... [output truncated at {limit} characters]", &text[..cut])
}

fn human_size(n: f64) -> String {
    for unit in ["B", "KB", "MB", "GB", "TB"] {
        if n < 1024.0 || unit == "TB" {
            return if unit == "B" { format!("{n} B") } else { format!("{n:.1} {unit}") };
        }
    }
    format!("{n} B")
}

async fn read_text(path: &Path) -> Result<(String, bool), String> {
    let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    match String::from_utf8(data) {
        Ok(text) => Ok((text, false)),
        Err(_) => Ok((String::new(), true)), // non-UTF-8 -> treat as binary
    }
}

fn require_file(ws: &Workspace, p: &Path) -> Result<(), String> {
    if !p.exists() { return Err(format!("'{}' does not exist", ws.display(p))); }
    if p.is_dir() { return Err(format!("'{}' is a folder, not a file", ws.display(p))); }
    Ok(())
}

fn detect_eol(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

fn normalize_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn count_lines(text: &str) -> usize {
    text.chars().filter(|c| *c == '\n').count()
    + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

// ── lenient argument coercion ────────────────────────────────────────────
// Models frequently send numbers as strings ("offset": "5") or booleans as
// strings ("replace_all": "true"). Coerce instead of erroring so a whole
// round-trip isn't wasted on a type mismatch.

fn j_bool(args: &serde_json::Value, key: &str, default: bool) -> bool {
    match args.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => matches!(s.trim().to_lowercase().as_str(), "true" | "1" | "yes" | "on"),
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => default,
    }
}

fn j_u64(args: &serde_json::Value, key: &str, default: u64) -> u64 {
    match args.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(default),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().unwrap_or(default),
        _ => default,
    }
}

async fn dir_size_tree(dir: &Path, skip_ignored: bool) -> (usize, usize, u64) {
    let mut files = 0usize; let mut dirs = 0usize; let mut size = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&d).await { Ok(e) => e, Err(_) => continue };
        while let Ok(Some(e)) = entries.next_entry().await {
            let ft = match e.file_type().await { Ok(t) => t, Err(_) => continue };
            let name = e.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                if skip_ignored && IGNORED_DIRS.contains(&name.as_str()) { continue; }
                dirs += 1;
                stack.push(e.path());
            } else {
                files += 1;
                size += e.metadata().await.map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (files, dirs, size)
}

fn arg_str(args: &serde_json::Value, key: &str) -> Result<String, String> {
    let v = args.get(key).ok_or_else(|| format!("'{key}' is required"))?;
    let s = v.as_str().ok_or_else(|| format!("'{key}' must be a string"))?;
    if s.trim().is_empty() { return Err(format!("'{key}' is required")); }
    Ok(s.to_string())
}

/// Optional path parameter - empty/missing means the workspace root.
fn opt_path(args: &serde_json::Value) -> String {
    args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

// -- tools ---------------------------------------------------------------

pub async fn tool_workspace_info(ws: &Workspace, _args: &serde_json::Value) -> Result<String, String> {
    let (file_count, dir_count, total) = dir_size_tree(&ws.canon_root, true).await;
    let mut top: Vec<String> = Vec::new();
    let mut entries = tokio::fs::read_dir(&ws.canon_root).await.map_err(|e| e.to_string())?;
    while let Ok(Some(e)) = entries.next_entry().await {
        let name = e.file_name().to_string_lossy().to_string();
        let slash = if e.file_type().await.map(|t| t.is_dir()).unwrap_or(false) { "/" } else { "" };
        top.push(format!("{name}{slash}"));
    }
    top.sort_by_key(|a| a.to_lowercase());
    let mut out = format!(
        "Workspace root: {}\nContents: {file_count} files, {dir_count} folders ({})\n(common generated folders like node_modules/.git are excluded from counts)\n\nTop-level entries:\n",
        ws.root_display(), human_size(total as f64)
    );
    if top.is_empty() { out.push_str("  (empty folder)"); }
    else {
        for name in top.iter().take(100) { out.push_str(&format!("  {name}\n")); }
        let extra = top.len().saturating_sub(100);
        if extra > 0 { out.push_str(&format!("  ... and {extra} more (use list_directory)")); }
        else { out.pop(); } // drop trailing newline
    }
    Ok(out)
}

pub async fn tool_list_directory(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let p = ws.resolve_path(opt_path(args).as_str(), true)?;
    if !p.is_dir() { return Err(format!("'{}' is a file, not a folder", ws.display(&p))); }
    let mut entries: Vec<(String, bool)> = Vec::new();
    let mut rd = tokio::fs::read_dir(&p).await.map_err(|e| e.to_string())?;
    while let Ok(Some(e)) = rd.next_entry().await {
        let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        entries.push((e.file_name().to_string_lossy().to_string(), is_dir));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    if entries.is_empty() { return Ok(format!("{}/ is empty.", ws.display(&p))); }
    let mut lines = Vec::new();
    for (name, is_dir) in entries.iter().take(500) {
        if *is_dir {
            let n = count_dir_items(&p.join(name)).await;
            lines.push(format!("  [dir ] {name}/ ({n} items)"));
        } else {
            let size = tokio::fs::metadata(p.join(name)).await.map(|m| m.len()).unwrap_or(0);
            lines.push(format!("  [file] {name} ({})", human_size(size as f64)));
        }
    }
    if entries.len() > 500 { lines.push(format!("  ... and {} more", entries.len() - 500)); }
    Ok(format!("{}/:\n{}", ws.display(&p), lines.join("\n")))
}

async fn count_dir_items(d: &Path) -> usize {
    let Ok(mut rd) = tokio::fs::read_dir(d).await else { return 0 };
    let mut c = 0usize;
    while let Ok(Some(_)) = rd.next_entry().await { c += 1; }
    c
}

pub async fn tool_tree(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let p = ws.resolve_path(opt_path(args).as_str(), true)?;
    let depth = j_u64(args, "depth", TREE_DEFAULT_DEPTH as u64).clamp(1, TREE_MAX_DEPTH as u64) as usize;
    let mut out_lines = vec![format!("{}/", ws.display(&p))];
    tree_walk(&p, "", 1, depth, &mut out_lines).await;
    if out_lines.len() > 1500 {
        return Ok(clip(&out_lines.join("\n"), 30_000)
            + "\n... [tree truncated - use list_directory or a deeper/narrower path]");
    }
    Ok(out_lines.join("\n"))
}

async fn tree_walk(d: &Path, prefix: &str, level: usize, max_depth: usize, out: &mut Vec<String>) {
    if level > max_depth { return; }
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(d).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            let is_file = e.file_type().await.map(|t| t.is_file()).unwrap_or(false);
            if is_file || !IGNORED_DIRS.contains(&name.as_str()) {
                entries.push((e.path(), name));
            }
        }
    }
    // Directories first, then files; case-insensitive names (matches Python).
    let mut metas: Vec<((bool, String), PathBuf, String)> = Vec::new(); // sort key, path, name
    for (path, name) in entries {
        let is_dir = tokio::fs::metadata(&path).await.map(|m| m.is_dir()).unwrap_or(false);
        metas.push(((is_dir, name.to_lowercase()), path, name));
    }
    metas.sort_by(|a, b| b.0.cmp(&a.0));
    let n = metas.len();
    for (i, (_, path, name)) in metas.iter().enumerate() {
        let last = i + 1 == n;
        let branch = if last { "`-- " } else { "|-- " };
        let ext = if last { "    " } else { "|   " };
        // Directories recurse via an explicit boxed future (bounded by max_depth).
        let is_dir = tokio::fs::metadata(path).await.map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            out.push(format!("{prefix}{branch}{name}/"));
            Box::pin(tree_walk(path, &format!("{prefix}{ext}"), level + 1, max_depth, out)).await;
        } else {
            out.push(format!("{prefix}{branch}{name}"));
        }
    }
}

pub async fn tool_read_file(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let p = ws.resolve_path(arg_str(args, "path")?.as_str(), true)?;
    require_file(ws, &p)?;
    let size = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES {
        return Err(format!(
            "'{}' is {} - too large to read whole (limit {}). Read it in parts with offset/limit if you really need to, or grep_files to find the relevant section.",
            ws.display(&p), human_size(size as f64), human_size(MAX_READ_BYTES as f64)
        ));
    }
    let (text, binary) = read_text(&p).await?;
    if binary {
        return Ok(format!("{} looks like a BINARY file ({}); its content is not shown as text.", ws.display(&p), human_size(size as f64)));
    }
    // Mirror Python splitlines(): no phantom empty line for a trailing newline.
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.len() > 1 && lines.last() == Some(&"") { lines.pop(); }
    let total = lines.len();
    let start = j_u64(args, "offset", 1).max(1) as usize;
    let limit = j_u64(args, "limit", 2000).clamp(1, 4000) as usize;
    let chunk: Vec<String> = lines.iter()
        .skip(start - 1).take(limit)
        .enumerate()
        .map(|(i, ln)| format!("{:>5} | {}", start + i, ln))
        .collect();
    let header = format!("{}  ({total} line{}, {})", ws.display(&p), if total != 1 { "s" } else { "" }, human_size(size as f64));
    if chunk.is_empty() {
        return Ok(format!("{header}\n(no lines in range {start}-{})", start + limit - 1));
    }
    let end = start - 1 + chunk.len();
    let footer = if end < total { format!("\n... lines {}-{total} continue (use offset={})", end + 1, end + 1) } else { String::new() };
    Ok(clip(&format!("{header}\n{}{footer}", chunk.join("\n")), MAX_TEXT_CHARS))
}

pub async fn tool_write_file(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let rel = arg_str(args, "path")?;
    let content = args.get("content").ok_or("'content' is required (use \"\" for an empty file)")?
        .as_str().ok_or("'content' must be a string")?;
    let p = ws.resolve_path(rel.as_str(), false)?;
    if p.exists() && p.is_dir() {
        return Err(format!("'{}' is a folder - cannot overwrite it with a file", ws.display(&p)));
    }
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("cannot create parents: {e}"))?;
        // In FULL PC ACCESS mode the parent may legitimately live anywhere.
        if !ws.full_access() {
            let canon_parent = std::fs::canonicalize(parent)
                .map_err(|e| format!("cannot resolve parent: {e}"))?;
            if !canon_parent.starts_with(&ws.canon_root) {
                return Err("cannot create entries outside the workspace".into());
            }
        }
    }
    let existed = p.exists();
    tokio::fs::write(&p, content.as_bytes()).await.map_err(|e| format!("write failed: {e}"))?;
    let action = if existed { "Overwrote" } else { "Created" };
    Ok(format!("{action} {} ({} chars, ~{} lines).", ws.display(&p), content.chars().count(), count_lines(content)))
}

pub async fn tool_edit_file(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let rel = arg_str(args, "path")?;
    let old = args.get("old_string").and_then(|v| v.as_str()).ok_or("'old_string' and 'new_string' are required")?;
    let new = args.get("new_string").and_then(|v| v.as_str()).ok_or("'old_string' and 'new_string' are required")?;
    if old == new { return Err("old_string and new_string are identical - nothing to change".into()); }
    let replace_all = j_bool(args, "replace_all", false);
    let p = ws.resolve_path(rel.as_str(), true)?;
    require_file(ws, &p)?;
    let size = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES { return Err(format!("'{}' is too large to edit ({})", ws.display(&p), human_size(size as f64))); }
    let (text, _bin) = read_text(&p).await?;
    // Match in LF-normalized space but preserve the file's own EOL on write.
    let eol = detect_eol(&text);
    let normalized = normalize_lf(&text);
    let old_norm = normalize_lf(old);
    let new_norm = normalize_lf(new);
    let count = normalized.matches(&old_norm).count();
    if count == 0 {
        let probe: String = old_norm.chars().take(60).collect();
        let near = normalized.find(&probe);
        let hint = if let Some(near) = near {
            let window = &normalized[near..];
            let diff_at = window.chars().zip(old_norm.chars())
                .position(|(a, b)| a != b)
                .unwrap_or(window.chars().count().min(old_norm.chars().count()));
            format!(" A similar passage exists around character {near}: your old_string first differs at position {diff_at}. Re-read the file with read_file and copy the EXACT text.")
        } else { String::new() };
        return Err(format!("old_string not found in {} (searched verbatim).{hint}", ws.display(&p)));
    }
    if count > 1 && !replace_all {
        let snippet = normalized.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        let snippet: String = snippet.trim().chars().take(60).collect();
        return Err(format!(
            "old_string matches {count} places in {}. Add surrounding context so it is UNIQUE, or pass replace_all:true to change every occurrence.{}",
            ws.display(&p),
            if snippet.is_empty() { String::new() } else { format!(" First line: {snippet}") }
        ));
    }
    let occurrences = if replace_all { count } else { 1 };
    let replaced = if replace_all { normalized.replace(&old_norm, &new_norm) }
        else { normalized.replacen(&old_norm, &new_norm, 1) };
    let new_text = if eol != "\n" { replaced.replace('\n', eol) } else { replaced };
    tokio::fs::write(&p, new_text.as_bytes()).await.map_err(|e| format!("write failed: {e}"))?;
    let where_ = if replace_all { format!("{occurrences} occurrences") } else { "first occurrence".to_string() };
    Ok(format!("Edited {}: replaced {where_} of old_string ({} chars -> {} chars).", ws.display(&p), old.chars().count(), new.chars().count()))
}

pub async fn tool_create_folder(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let rel = arg_str(args, "path")?;
    let p = ws.resolve_path(rel.as_str(), false)?;
    if p.exists() && p.is_file() {
        return Err(format!("'{}' exists as a FILE - cannot create a folder with that name", ws.display(&p)));
    }
    tokio::fs::create_dir_all(&p).await.map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(format!("Folder ready: {}/", ws.display(&p)))
}

pub async fn tool_delete_path(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let rel = arg_str(args, "path")?;
    let p = ws.resolve_path(rel.as_str(), true)?;
    if p == ws.canon_root { return Err("refusing to delete the workspace root itself".into()); }
    let display = ws.display(&p);
    if p.is_dir() {
        let (files, _, _) = dir_size_tree(&p, false).await;
        tokio::fs::remove_dir_all(&p).await.map_err(|e| format!("delete failed: {e}"))?;
        Ok(format!("Deleted folder {display}/ ({files} files removed)."))
    } else {
        tokio::fs::remove_file(&p).await.map_err(|e| format!("delete failed: {e}"))?;
        Ok(format!("Deleted file {display}."))
    }
}

pub async fn tool_move_path(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let src_rel = arg_str(args, "source")?;
    let dst_rel = arg_str(args, "destination")?;
    let src = ws.resolve_path(src_rel.as_str(), true)?;
    if src == ws.canon_root { return Err("refusing to move the workspace root itself".into()); }
    let mut dst = ws.resolve_path(dst_rel.as_str(), false)?;
    if dst.exists() && dst.is_dir() {
        dst = dst.join(src.file_name().ok_or("bad source name")?);
    }
    if dst.exists() { return Err(format!("destination '{}' already exists", ws.display(&dst))); }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("mkdir failed: {e}"))?;
    }
    move_any(&src, &dst).await?;
    Ok(format!("Moved {} -> {}.", ws.display(&src), ws.display(&dst)))
}

async fn move_any(src: &Path, dst: &Path) -> Result<(), String> {
    // Same-volume rename first (instant); fall back to copy+delete for
    // cross-drive moves (what Python's shutil.move does implicitly).
    if tokio::fs::rename(src, dst).await.is_ok() { return Ok(()); }
    if src.is_dir() {
        tokio::fs::create_dir_all(dst).await.map_err(|e| e.to_string())?;
        let mut rd = tokio::fs::read_dir(src).await.map_err(|e| e.to_string())?;
        while let Ok(Some(e)) = rd.next_entry().await {
            Box::pin(move_any(&e.path(), &dst.join(e.file_name()))).await?;
        }
        tokio::fs::remove_dir_all(src).await.map_err(|e| e.to_string())?;
    } else {
        tokio::fs::copy(src, dst).await.map_err(|e| e.to_string())?;
        tokio::fs::remove_file(src).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn tool_search_files(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern")?.trim().to_string();
    if pattern.is_empty() { return Err("'pattern' is required, e.g. \"**/*.py\"".into()); }
    let globbed = format!("{}/{}", ws.canon_root.to_string_lossy().replace('\\', "/"), pattern);
    let paths = glob::glob(&globbed).map_err(|e| format!("invalid pattern '{pattern}': {e}"))?;
    let mut matches: Vec<String> = Vec::new();
    for m in paths.flatten() {
        let tag = if m.is_dir() { "dir/" } else { "" };
        matches.push(format!("  {}{tag}", ws.display(&m)));
        if matches.len() >= GREP_MAX_RESULTS { break; }
    }
    if matches.is_empty() { return Ok(format!("No paths match \"{pattern}\".")); }
    let tail = if matches.len() < GREP_MAX_RESULTS { String::new() } else { format!("\n  ... stopped at {GREP_MAX_RESULTS} results") };
    Ok(format!("Paths matching \"{pattern}\" ({}):\n{}{tail}", matches.len(), matches.join("\n")))
}

pub async fn tool_grep_files(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let query = args.get("query").and_then(|q| q.as_str()).filter(|q| !q.is_empty())
        .ok_or("'query' is required")?;
    let include = args.get("include").and_then(|i| i.as_str()).filter(|i| !i.is_empty()).unwrap_or("**/*");
    let is_regex = args.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
    let ignore_case = args.get("ignore_case").and_then(|v| v.as_bool()).unwrap_or(true);
    let rx = if is_regex {
        Some(regex::RegexBuilder::new(query)
            .case_insensitive(ignore_case)
            .build()
            .map_err(|e| format!("invalid regex '{query}': {e}"))?)
    } else { None };
    let needle = query.to_lowercase();

    // Candidate files: honor include-glob, skip ignored dirs + oversized files.
    let mut candidates: Vec<PathBuf> = Vec::new();
    collect_files(&ws.canon_root, include, &mut candidates).await;

    let mut hits: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    'outer: for path in candidates {
        if hits.len() >= GREP_MAX_RESULTS { break; }
        if tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(u64::MAX) > MAX_READ_BYTES { continue; }
        let (text, binary) = match read_text(&path).await { Ok(t) => t, Err(_) => continue };
        if binary { continue; }
        scanned += 1;
        for (lineno, line) in text.split('\n').enumerate() {
            let ok = match &rx {
                Some(rx) => rx.is_match(line),
                None => line.to_lowercase().contains(&needle),
            };
            if ok {
                let trimmed = line.trim().chars().take(160).collect::<String>();
                hits.push(format!("  {}:{}: {}", ws.display(&path), lineno + 1, trimmed));
                if hits.len() >= GREP_MAX_RESULTS { break 'outer; }
            }
        }
    }
    if hits.is_empty() {
        let kind = if is_regex { "regex" } else { "text" };
        return Ok(format!("No matches for {kind} \"{query}\" (scanned {scanned} files matching \"{include}\")."));
    }
    let tail = if hits.len() < GREP_MAX_RESULTS { String::new() } else { format!("\n  ... stopped at {GREP_MAX_RESULTS} matches") };
    Ok(format!("Matches for \"{query}\" ({}, scanned {scanned} files):\n{}{tail}", hits.len(), hits.join("\n")))
}

async fn collect_files(dir: &Path, include: &str, out: &mut Vec<PathBuf>) {
    let matcher = glob::Pattern::new(include).ok();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&d).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !IGNORED_DIRS.contains(&name.as_str()) { stack.push(path); }
                continue;
            }
            if let Some(m) = &matcher {
                // Default glob semantics: '*' crosses separators, like OpenRender's.
                let rel = path.strip_prefix(dir).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if !m.matches(&rel) && !m.matches(&name) { continue; }
            }
            out.push(path);
            if out.len() >= 20_000 { return; }
        }
    }
}

pub async fn tool_run_command(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let command = arg_str(args, "command")?.trim().to_string();
    if command.is_empty() {
        return Err("'command' is required, e.g. \"python main.py\" or \"npm install\"".into());
    }
    let timeout_secs = j_u64(args, "timeout_seconds", DEFAULT_RUN_TIMEOUT).clamp(1, MAX_RUN_TIMEOUT);

    let t0 = Instant::now();
    let output = run_shell(&command, &ws.canon_root, timeout_secs).await;
    let elapsed = t0.elapsed().as_secs_f64();
    let proc_out = match output {
        Ok(o) => o,
        Err(RunErr::Spawn(e)) => return Err(format!("could not run command: {e}")),
        Err(RunErr::Timeout) => return Ok(format!(
            "Command TIMED OUT after {timeout_secs}s: {command}\nIt may still have had partial effects. For long-running servers/tests, run them differently (background job, shorter test subset) instead of blocking."
        )),
    };
    let mut stdout = String::from_utf8_lossy(&proc_out.stdout).trim().to_string();
    let mut stderr = String::from_utf8_lossy(&proc_out.stderr).trim().to_string();
    if stdout.chars().count() > MAX_RUN_OUTPUT {
        stdout = stdout.chars().take(MAX_RUN_OUTPUT).collect::<String>()
            + &format!("\n... [stdout truncated at {MAX_RUN_OUTPUT} chars]");
    }
    if stderr.chars().count() > MAX_RUN_OUTPUT {
        stderr = stderr.chars().take(MAX_RUN_OUTPUT).collect::<String>()
            + &format!("\n... [stderr truncated at {MAX_RUN_OUTPUT} chars]");
    }
    let code = proc_out.status.code().unwrap_or(-1);
    let mut parts = vec![
        format!("$ {command}"),
        format!("(ran in the workspace root, exit code {code}, {elapsed:.1}s)"),
    ];
    if !stdout.is_empty() { parts.push("--- stdout ---".to_string()); parts.push(stdout); }
    if !stderr.is_empty() { parts.push("--- stderr ---".to_string()); parts.push(stderr); }
    if code != 0 && proc_out.stderr.is_empty() {
        parts.push("(non-zero exit code with empty stderr - check stdout above)".to_string());
    }
    Ok(clip(&parts.join("\n"), MAX_TEXT_CHARS))
}

enum RunErr { Spawn(std::io::Error), Timeout }

#[cfg(windows)]
async fn run_shell(command: &str, cwd: &Path, timeout_secs: u64) -> Result<std::process::Output, RunErr> {
    use std::process::Stdio;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.args(["/C", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    finish(cmd, timeout_secs).await
}

#[cfg(not(windows))]
async fn run_shell(command: &str, cwd: &Path, timeout_secs: u64) -> Result<std::process::Output, RunErr> {
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    finish(cmd, timeout_secs).await
}

async fn finish(mut cmd: tokio::process::Command, timeout_secs: u64) -> Result<std::process::Output, RunErr> {
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await {
        Ok(Ok(o)) => Ok(o),
        Ok(Err(e)) => Err(RunErr::Spawn(e)),
        Err(_) => Err(RunErr::Timeout),
    }
}

// ── extended system tools (AgentScript+) ─────────────────────────────────

pub async fn tool_file_info(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let rel = arg_str(args, "path")?;
    let p = ws.resolve_path(rel.as_str(), true)?;
    let md = tokio::fs::metadata(&p).await.map_err(|e| format!("stat failed: {e}"))?;
    let kind = if md.is_dir() { "folder" } else { "file" };
    Ok(format!(
        "{} ({})\nsize: {}\nmodified: {:?}\ncreated: {:?}\nreadonly: {}",
        ws.display(&p),
        kind,
        human_size(md.len() as f64),
        md.modified().ok(),
        md.created().ok(),
        md.permissions().readonly(),
    ))
}

pub async fn tool_env_info(ws: &Workspace, _args: &serde_json::Value) -> Result<String, String> {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let host = sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string());
    let os = sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string());
    let mem_total = sys.total_memory();
    let mem_free = sys.available_memory();
    Ok(format!(
        "Host: {host}\nOS: {os}\nArch: {}\nCPUs: {}\nMemory: {} total, {} available\nUser: {}\nWorkspace root: {}\nFULL PC ACCESS: {}",
        std::env::consts::ARCH,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        human_size(mem_total as f64),
        human_size(mem_free as f64),
        whoami_fallback(),
        ws.root_display(),
        if ws.full_access() { "ON" } else { "off (workspace sandbox)" },
    ))
}

fn whoami_fallback() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "unknown".into())
}

pub async fn tool_process_list(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let limit = j_u64(args, "limit", 40).clamp(1, 300) as usize;
    let mut sys = sysinfo::System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut procs: Vec<(u32, String, u64)> = sys.processes().iter()
        .map(|(pid, p)| (pid.as_u32(), p.name().to_string_lossy().to_string(), p.memory()))
        .collect();
    procs.sort_by(|a, b| b.2.cmp(&a.2));
    let shown = procs.len().min(limit);
    let mut out = format!("{} running processes (top {shown} by memory):\n\n  PID     MEM       NAME", procs.len());
    for (pid, name, mem) in procs.iter().take(limit) {
        out.push_str(&format!("\n  {pid:<7} {:<9} {}", human_size(*mem as f64), name));
    }
    if ws.full_access() {
        out.push_str("\n\nKill one with process_kill {pid}.");
    } else {
        out.push_str("\n\n(FULL PC ACCESS is off - process_kill is unavailable.)");
    }
    Ok(out)
}

pub async fn tool_process_kill(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    if !ws.full_access() {
        return Err("process_kill requires FULL PC ACCESS mode (the user must enable it from the OR bar toggle). This is intentional: killing processes affects the whole machine.".into());
    }
    let pid = args.get("pid").and_then(|p| p.as_u64()).filter(|p| *p > 0)
        .or_else(|| args.get("pid").and_then(|p| p.as_str()).and_then(|s| s.trim().parse::<u64>().ok()))
        .ok_or("'pid' is required (a number)")?;
    if pid == std::process::id() as u64 {
        return Err("refusing to kill the AgentScript agent itself".into());
    }
    #[cfg(windows)]
    let ok = {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    #[cfg(not(windows))]
    let ok = {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if ok { Ok(format!("Killed process {pid}.")) }
    else { Err(format!("could not kill process {pid} (not found or access denied)")) }
}

pub async fn tool_open_path(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let target = arg_str(args, "path")?;
    let resolved;
    let lower = target.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        resolved = target.clone(); // URLs are safe to hand to the OS handler
    } else {
        let p = ws.resolve_path(target.as_str(), true)?;
        resolved = p.to_string_lossy().to_string();
    }
    #[cfg(windows)]
    let ok = {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &resolved])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
    };
    #[cfg(not(windows))]
    let ok = {
        std::process::Command::new("xdg-open").arg(&resolved).spawn().is_ok()
    };
    if ok { Ok(format!("Opened {resolved} with the default application.")) }
    else { Err(format!("could not open '{resolved}'")) }
}

const DOWNLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024;

pub async fn tool_download_file(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let url = arg_str(args, "url")?;
    if !url.to_lowercase().starts_with("http://") && !url.to_lowercase().starts_with("https://") {
        return Err("'url' must be an http(s) URL".into());
    }
    let dest_rel = arg_str(args, "path")?;
    let dest = ws.resolve_path(dest_rel.as_str(), false)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| format!("client error: {e}"))?;
    let resp = client.get(&url).send().await.map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let total = resp.content_length();
    if let Some(n) = total {
        if n > DOWNLOAD_MAX_BYTES {
            return Err(format!("file is {} - over the {} download cap", human_size(n as f64), human_size(DOWNLOAD_MAX_BYTES as f64)));
        }
    }
    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| format!("create failed: {e}"))?;
    use tokio::io::AsyncWriteExt;
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        written += chunk.len() as u64;
        if written > DOWNLOAD_MAX_BYTES {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(format!("download exceeded the {} cap mid-stream; aborted", human_size(DOWNLOAD_MAX_BYTES as f64)));
        }
        file.write_all(&chunk).await.map_err(|e| format!("write failed: {e}"))?;
    }
    file.flush().await.map_err(|e| format!("flush failed: {e}"))?;
    Ok(format!(
        "Downloaded {url} -> {} ({}{})",
        ws.display(&dest),
        human_size(written as f64),
        total.map(|n| format!(" of {}", human_size(n as f64))).unwrap_or_default(),
    ))
}

/// Extension-internal: read a BINARY file (a screenshot) as base64 so the
/// browser can attach it to the chat. `read_file` is line-numbered text and
/// would mangle binary, so this returns
/// `{"ok":true,"mimeType":...,"bytes":N,"data":"<base64>"}` instead.
///
/// Deliberately NOT part of `catalog()`: it is plumbing for the extension's
/// Blender viewport capture, not something the model should ever call.
pub async fn tool_read_file_base64(ws: &Workspace, args: &serde_json::Value) -> Result<String, String> {
    let p = ws.resolve_path(arg_str(args, "path")?.as_str(), true)?;
    require_file(ws, &p)?;
    let size = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "'{}' is {} - larger than the {} image-read cap.",
            ws.display(&p), human_size(size as f64), human_size(MAX_IMAGE_BYTES as f64)
        ));
    }
    let raw = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    let mime = match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(serde_json::json!({
        "ok": true, "mimeType": mime, "bytes": raw.len(), "data": base64(&raw),
    }).to_string())
}

/// Minimal RFC 4648 base64 encoder. Hand-rolled on purpose: adding a crate would
/// churn Cargo.lock and break offline `cargo build --release` runs.
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// -- dispatch ------------------------------------------------------------

pub async fn dispatch(ws: &Workspace, name: &str, args: serde_json::Value) -> Result<String, String> {
    let empty = serde_json::Value::Null;
    let a = if args.is_null() || !args.is_object() { &empty } else { &args };
    match name {
        "workspace_info" => tool_workspace_info(ws, a).await,
        "list_directory" => tool_list_directory(ws, a).await,
        "tree" => tool_tree(ws, a).await,
        "read_file" => tool_read_file(ws, a).await,
        // Extension-internal (see tool_read_file_base64) - kept out of catalog().
        "read_file_base64" => tool_read_file_base64(ws, a).await,
        "write_file" => tool_write_file(ws, a).await,
        "edit_file" => tool_edit_file(ws, a).await,
        "create_folder" => tool_create_folder(ws, a).await,
        "delete_path" => tool_delete_path(ws, a).await,
        "move_path" => tool_move_path(ws, a).await,
        "search_files" => tool_search_files(ws, a).await,
        "grep_files" => tool_grep_files(ws, a).await,
        "run_command" => tool_run_command(ws, a).await,
        "file_info" => tool_file_info(ws, a).await,
        "env_info" => tool_env_info(ws, a).await,
        "process_list" => tool_process_list(ws, a).await,
        "process_kill" => tool_process_kill(ws, a).await,
        "open_path" => tool_open_path(ws, a).await,
        "download_file" => tool_download_file(ws, a).await,
        other => Err(format!(
            "unknown tool '{other}'. Available AgentScript tools: workspace_info, list_directory, tree, \
read_file, write_file, edit_file, create_folder, delete_path, move_path, search_files, grep_files, \
run_command, file_info, env_info, process_list, process_kill (FULL mode), open_path, download_file. \
Call list_commands for full parameter details."
        )),
    }
}

fn schema(props: serde_json::Value, req: &[&str]) -> serde_json::Value {
    serde_json::json!({"type": "object", "properties": props, "required": req})
}

/// MCP-shaped catalog (same JSON shape the extension already consumes from
/// Studio's tools/list) so the browser side needs zero parser changes.
pub fn catalog() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({"name": "workspace_info", "description": "Overview of the connected project folder: absolute root path, file/folder counts, total size and top-level entries.", "inputSchema": schema(serde_json::json!({}), &[])}),
        serde_json::json!({"name": "list_directory", "description": "List one folder's entries with types and sizes.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}}), &[])}),
        serde_json::json!({"name": "tree", "description": "Recursive directory tree. Generated folders (.git, node_modules, __pycache__, dist...) are skipped.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}, "depth": {"type": "integer"}}), &[])}),
        serde_json::json!({"name": "read_file", "description": "Read a text file. Returns numbered lines as 'LINE | content'. Always read before editing so your old_string matches byte-for-byte.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}), &["path"])}),
        serde_json::json!({"name": "write_file", "description": "Create a file or OVERWRITE an existing one with complete new content. Parent folders are created automatically. Prefer edit_file for partial changes.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}, "content": {"type": "string"}}), &["path", "content"])}),
        serde_json::json!({"name": "edit_file", "description": "Exact-match string replacement inside a file. Replaces the FIRST match, or every match with replace_all:true. Fails loudly when old_string is missing or ambiguous.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}), &["path", "old_string", "new_string"])}),
        serde_json::json!({"name": "create_folder", "description": "Create a folder (and missing parents).", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}}), &["path"])}),
        serde_json::json!({"name": "delete_path", "description": "Permanently DELETE a file or folder (folders recursive). Confirm scope with the user before deleting anything broad.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}}), &["path"])}),
        serde_json::json!({"name": "move_path", "description": "Move or rename a file/folder. If destination is an existing folder, the source moves INSIDE it keeping its name.", "inputSchema": schema(serde_json::json!({"source": {"type": "string"}, "destination": {"type": "string"}}), &["source", "destination"])}),
        serde_json::json!({"name": "search_files", "description": "Find files/folders by NAME using glob patterns, e.g. \"**/*.py\", \"src/**/*.js\".", "inputSchema": schema(serde_json::json!({"pattern": {"type": "string"}}), &["pattern"])}),
        serde_json::json!({"name": "grep_files", "description": "Search INSIDE file contents. Case-insensitive substring by default; regex:true for regular expressions. Narrow with include globs like \"src/**/*.ts\".", "inputSchema": schema(serde_json::json!({"query": {"type": "string"}, "include": {"type": "string"}, "regex": {"type": "boolean"}, "ignore_case": {"type": "boolean"}}), &["query"])}),
        serde_json::json!({"name": "run_command", "description": "Run a terminal command in the workspace root: installs, builds, tests, git. Captures stdout/stderr and exit code. Blocks until done (hard timeout); never start interactive apps or dev servers.", "inputSchema": schema(serde_json::json!({"command": {"type": "string"}, "timeout_seconds": {"type": "integer"}, "cwd_note": {"type": "string", "description": "In FULL PC ACCESS mode use cd inside command to roam; relative paths resolve from the workspace root."}}), &["command"])}),
        serde_json::json!({"name": "file_info", "description": "Metadata for one path: kind, size, modified/created timestamps, readonly flag.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}}), &["path"])}),
        serde_json::json!({"name": "env_info", "description": "Machine overview: host, OS, arch, CPU count, memory, user, workspace root, and whether FULL PC ACCESS is on.", "inputSchema": schema(serde_json::json!({}), &[])}),
        serde_json::json!({"name": "process_list", "description": "List running processes sorted by memory (top N by limit, default 40). Read-only.", "inputSchema": schema(serde_json::json!({"limit": {"type": "integer"}}), &[])}),
        serde_json::json!({"name": "process_kill", "description": "Kill a process by PID. Requires FULL PC ACCESS mode - refused otherwise by design.", "inputSchema": schema(serde_json::json!({"pid": {"type": "integer"}}), &["pid"])}),
        serde_json::json!({"name": "open_path", "description": "Open a file/folder (workspace-relative, absolute in FULL mode) or an http(s) URL with the OS default application.", "inputSchema": schema(serde_json::json!({"path": {"type": "string"}}), &["path"])}),
        serde_json::json!({"name": "download_file", "description": "Download an http(s) URL to a path (200 MB cap, streamed). Path follows sandbox rules.", "inputSchema": schema(serde_json::json!({"url": {"type": "string"}, "path": {"type": "string"}}), &["url", "path"])}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws(tag: &str) -> Workspace {
        let dir = std::env::temp_dir().join(format!("rs-ws-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Workspace::new(Some(dir.to_str().unwrap())).unwrap()
    }

    // RFC 4648 test vectors - the hand-rolled encoder is what carries every
    // Blender viewport capture, so it is locked down explicitly.
    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0x00, 0x80]), "/wCA");
    }

    #[tokio::test]
    async fn read_file_base64_round_trips_a_binary_png() {
        let ws = temp_ws("b64");
        // 1x1 transparent PNG - exercises a real binary payload, not text.
        let png: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0xFF, 0xFE];
        tokio::fs::write(ws.canon_root.join("shot.png"), &png).await.unwrap();
        let out = tool_read_file_base64(&ws, &serde_json::json!({"path": "shot.png"})).await.unwrap();
        let j: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(j["mimeType"], "image/png");
        assert_eq!(j["bytes"].as_u64().unwrap() as usize, png.len());
        assert_eq!(j["data"], base64(&png));
        // The tool stays sandboxed like every other workspace tool.
        assert!(tool_read_file_base64(&ws, &serde_json::json!({"path": "../escape.png"})).await.is_err());
        assert!(tool_read_file_base64(&ws, &serde_json::json!({"path": "/etc/passwd"})).await.is_err());
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[test]
    fn sandbox_rejects_escapes_and_absolute() {
        let ws = temp_ws("esc");
        assert!(ws.resolve_path("../outside", false).is_err());
        assert!(ws.resolve_path("a/../../b", false).is_err());
        assert!(ws.resolve_path("/etc/passwd", false).is_err());
        assert!(ws.resolve_path("C:/Windows/system32", false).is_err());
        assert!(ws.resolve_path("fine/sub/path.txt", false).is_ok());
        let inside = ws.resolve_path("sub/../ok.txt", false).unwrap();
        assert!(inside.starts_with(&ws.canon_root));
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn write_read_edit_roundtrip_preserves_crlf() {
        let ws = temp_ws("edit");
        let args = serde_json::json!({"path": "notes/a.txt", "content": "one\r\ntwo\r\nthree\r\n"});
        tool_write_file(&ws, &args).await.unwrap();
        let edit = serde_json::json!({"path": "notes/a.txt", "old_string": "two", "new_string": "TWO!"});
        let msg = tool_edit_file(&ws, &edit).await.unwrap();
        assert!(msg.contains("first occurrence"), "{msg}");
        let data = std::fs::read_to_string(ws.canon_root.join("notes/a.txt")).unwrap();
        assert_eq!(data, "one\r\nTWO!\r\nthree\r\n");
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn edit_enforces_uniqueness_and_nearmiss_hint() {
        let ws = temp_ws("uniq");
        tool_write_file(&ws, &serde_json::json!({"path": "f.txt", "content": "alpha\nbeta\nalpha\n"})).await.unwrap();
        let dup = tool_edit_file(&ws, &serde_json::json!({"path": "f.txt", "old_string": "alpha", "new_string": "x"})).await;
        assert!(dup.unwrap_err().contains("matches 2 places"));
        let all = tool_edit_file(&ws, &serde_json::json!({"path": "f.txt", "old_string": "alpha", "new_string": "x", "replace_all": true})).await.unwrap();
        assert!(all.contains("2 occurrences"));
        // near-miss hint: wrong-case probe still points at the passage
        let miss = tool_edit_file(&ws, &serde_json::json!({"path": "f.txt", "old_string": "X", "new_string": "y"})).await;
        let msg = miss.unwrap_err();
        assert!(msg.contains("not found"), "{msg}");
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn delete_and_move_guard_the_root() {
        let ws = temp_ws("rootguard");
        let del = tool_delete_path(&ws, &serde_json::json!({"path": "."})).await.unwrap_err();
        assert!(del.contains("refusing to delete"));
        let mv = tool_move_path(&ws, &serde_json::json!({"source": ".", "destination": "x"})).await.unwrap_err();
        assert!(mv.contains("refusing to move"));
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn grep_search_tree_basics() {
        let ws = temp_ws("grep");
        tool_write_file(&ws, &serde_json::json!({"path": "src/main.py", "content": "def hello():\n    pass\n"})).await.unwrap();
        tool_write_file(&ws, &serde_json::json!({"path": "lib/other.js", "content": "function hello() {}\n"})).await.unwrap();
        let g = tool_grep_files(&ws, &serde_json::json!({"query": "hello"})).await.unwrap();
        assert!(g.contains("src/main.py:1") && g.contains("lib/other.js:1"), "{g}");
        let s = tool_search_files(&ws, &serde_json::json!({"pattern": "**/*.py"})).await.unwrap();
        assert!(s.contains("src/main.py"), "{s}");
        let t = tool_tree(&ws, &serde_json::json!({"depth": 2})).await.unwrap();
        assert!(t.contains("main.py") && t.contains("other.js"), "{t}");
        let r = tool_read_file(&ws, &serde_json::json!({"path": "src/main.py"})).await.unwrap();
        assert!(r.contains("1 | def hello():"), "{r}");
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn run_command_captures_and_times_out() {
        let ws = temp_ws("run");
        let ok = tool_run_command(&ws, &serde_json::json!({"command": "echo hi"})).await.unwrap();
        assert!(ok.contains("hi") && ok.contains("exit code 0"), "{ok}");
        let err = tool_run_command(&ws, &serde_json::json!({"command": "exit /b 7"})).await.unwrap();
        assert!(err.contains("exit code 7"), "{err}");
        let slow = tool_run_command(&ws, &serde_json::json!({"command": "ping -n 30 127.0.0.1 > nul", "timeout_seconds": 1})).await.unwrap();
        assert!(slow.contains("TIMED OUT"), "{slow}");
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn lenient_string_typed_args() {
        let ws = temp_ws("lenient");
        tool_write_file(&ws, &serde_json::json!({"path": "a.txt", "content": "x\ny\n"})).await.unwrap();
        // numeric params sent as strings must still work
        let r = tool_read_file(&ws, &serde_json::json!({"path": "a.txt", "offset": "1", "limit": "1"})).await.unwrap();
        assert!(r.contains("1 | x"), "{r}");
        // boolean param sent as string must still work
        tool_write_file(&ws, &serde_json::json!({"path": "b.txt", "content": "dup dup\n"})).await.unwrap();
        let e = tool_edit_file(&ws, &serde_json::json!({"path": "b.txt", "old_string": "dup", "new_string": "DUP", "replace_all": "true"})).await.unwrap();
        assert!(e.contains("2 occurrences"), "{e}");
        // unknown tools self-correct instead of dead-ending the model
        let u = dispatch(&ws, "nope_not_real", serde_json::json!({})).await.unwrap_err();
        assert!(u.contains("Available AgentScript tools") && u.contains("list_commands"), "{u}");
        let _ = std::fs::remove_dir_all(&ws.canon_root);
    }

    #[tokio::test]
    async fn full_access_toggles_absolute_paths_and_gates_kill() {
        let ws = temp_ws("full");
        let abs = ws.canon_root.parent().unwrap().to_string_lossy().to_string();
        assert!(ws.resolve_path(&format!("{abs}/elsewhere.txt"), false).is_err());
        // kill is gated behind FULL mode
        assert!(tool_process_kill(&ws, &serde_json::json!({"pid": 999999})).await.is_err());
        ws.set_full_access(true);
        assert!(ws.full_access());
        assert!(ws.resolve_path(&format!("{abs}/elsewhere.txt"), false).is_ok());
        // ...but still refuses OUR own pid even in full mode
        let own = std::process::id();
        let self_kill = tool_process_kill(&ws, &serde_json::json!({"pid": own})).await;
        assert!(self_kill.is_err());
    }
}
