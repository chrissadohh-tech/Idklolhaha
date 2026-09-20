#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{extract::{Query, State}, http::Method, response::IntoResponse, routing::{get, post}, Json, Router};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, fs::File, net::SocketAddr, path::PathBuf, process::Stdio, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc}, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, Mutex, RwLock},
};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Append-only file logger so the GUI-subsystem release build keeps visible
/// diagnostics in `<exe dir>/logs/agent.log` (stdout is invisible there).
#[derive(Clone)]
struct FileLog {
    file: Arc<std::sync::Mutex<File>>,
    ui: Option<Arc<gui::UiShared>>,
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileLog {
    type Writer = FileLog;
    fn make_writer(&'a self) -> Self::Writer { self.clone() }
}
impl std::io::Write for FileLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(ui) = &self.ui { ui.log(&String::from_utf8_lossy(buf)); }
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        std::io::Write::write(&mut *f, buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        std::io::Write::flush(&mut *f)
    }
}

fn init_file_logger(ui: Option<Arc<gui::UiShared>>) {
    let dir = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("logs")))
        .unwrap_or_else(|| PathBuf::from("logs"));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("agent.log");
    match File::options().create(true).append(true).open(&path) {
        Ok(file) => {
            tracing_subscriber::fmt()
                .with_env_filter("info")
                .with_ansi(false)
                .with_writer(FileLog { file: Arc::new(std::sync::Mutex::new(file)), ui })
                .init();
        }
        Err(_) => {
            tracing_subscriber::fmt().with_env_filter("info").init();
        }
    }
}

mod gui;
mod workspace;

#[cfg(windows)]
mod win_msg {
    #[link(name = "user32")]
    extern "system" {
        pub fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            ty: u32,
        ) -> i32;
    }
}

#[cfg(windows)]
fn win_alert(title: &str, msg: &str) {
    // windows_subsystem = "windows" hides stderr. A MessageBox is the only way
    // the user sees *why* the agent did not open.
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    let t = wide(title);
    let m = wide(msg);
    unsafe { win_msg::MessageBoxW(std::ptr::null_mut(), m.as_ptr(), t.as_ptr(), 0x10); }
}


#[derive(Parser, Debug)]
#[command(name = "or-agent", version = env!("CARGO_PKG_VERSION"), about = "OR Native Agent — Roblox Studio MCP + AgentScript")]
struct Args {
    #[arg(long, help = "Run without the status window (for autostart/background use)")]
    headless: bool,
    #[arg(long, default_value = "127.0.0.1:3000")]
    roblox_addr: String,
    #[arg(long, help = "Workspace root for the LOCAL (FS) engine [env: OR_WORKSPACE_ROOT]")]
    workspace: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Payload { id: String, target: String, code: String, language: String, #[serde(default)] meta: serde_json::Value, }

// ══════════════════════════════════════════════════════════════════════════
//  mcp_servers.json — every MCP server the agent hosts, Roblox + addons
// ══════════════════════════════════════════════════════════════════════════
const PRIMARY_SERVER_ID: &str = "roblox";
const MCP_CONFIG_FILE: &str = "mcp_servers.json";

/// Same shape ZeroScript's config.json uses ({"mcpServers": {id: {command…}}}),
/// so the two extensions are configured identically.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct McpConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: std::collections::BTreeMap<String, ServerSpec>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ServerSpec {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    env: std::collections::BTreeMap<String, String>,
}

/// Next to or-agent.exe (OR_MCP_CONFIG overrides). ZeroScript keeps its
/// config.json beside the bridge for the same reason: it is the user's file.
fn mcp_config_path() -> PathBuf {
    if let Some(p) = env_first(&["OR_MCP_CONFIG", "ROBLOXSCRIPT_MCP_CONFIG"]) {
        if !p.trim().is_empty() { return PathBuf::from(p.trim()); }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() { return dir.join(MCP_CONFIG_FILE); }
    }
    PathBuf::from(MCP_CONFIG_FILE)
}

fn read_mcp_config() -> McpConfig {
    let path = mcp_config_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return McpConfig::default() };
    match serde_json::from_str::<McpConfig>(&text) {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!("{} is unreadable ({e}) - ignoring it", path.display());
            McpConfig::default()
        }
    }
}

fn write_mcp_config(cfg: &McpConfig) -> Result<(), String> {
    let path = mcp_config_path();
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    // Atomic replace, so a crash mid-write never truncates the config.
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not replace {}: {e}", path.display()))?;
    Ok(())
}

/// Newest of these by mtime (Roblox leaves zombie version folders behind).
#[cfg_attr(not(windows), allow(dead_code))]
fn newest_by_mtime(mut paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    paths.pop()
}

fn studio_mcp_override() -> Option<PathBuf> {
    for key in ["OR_STUDIO_MCP_PATH", "ZS_STUDIO_MCP_PATH"] {
        let Ok(v) = std::env::var(key) else { continue };
        if v.trim().is_empty() { continue; }
        let p = PathBuf::from(v.trim());
        if p.is_file() { return Some(p); }
        if p.is_dir() {
            #[cfg(target_os = "macos")]
            let candidate = p.join("Contents").join("MacOS").join("StudioMCP");
            #[cfg(not(target_os = "macos"))]
            let candidate = p.join("StudioMCP.exe");
            if candidate.is_file() { return Some(candidate); }
        }
        tracing::warn!("{key} is set but is not a StudioMCP binary: {v}");
    }
    None
}

/// Locate the StudioMCP.exe of the LIVE Studio install. Roblox's mcp.bat
/// hard-codes ONE version path; when Studio auto-updates that folder is deleted
/// and the .bat's fallback branch is broken batch syntax, so StudioMCP never
/// launches and the bridge sees 0 tools. Discovery sidesteps it (same fix
/// ZeroScript's launch_studio_mcp.py makes).
#[cfg(windows)]
fn find_studio_mcp() -> Option<PathBuf> {
    if let Some(p) = studio_mcp_override() { return Some(p); }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("LOCALAPPDATA") { roots.push(PathBuf::from(v).join("Roblox").join("Versions")); }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(key) { roots.push(PathBuf::from(v).join("Roblox").join("Versions")); }
    }
    // Zombie version folders still contain StudioMCP.exe but no Studio exe -
    // launching one gives 0 tools. Prefer folders that ALSO have Studio.
    let (mut paired, mut orphans) = (Vec::new(), Vec::new());
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() { continue; }
            let mcp = dir.join("StudioMCP.exe");
            if !mcp.is_file() { continue; }
            if dir.join("RobloxStudioBeta.exe").is_file() || dir.join("RobloxStudio.exe").is_file() {
                paired.push(mcp);
            } else {
                orphans.push(mcp);
            }
        }
    }
    newest_by_mtime(paired).or_else(|| newest_by_mtime(orphans))
}

#[cfg(not(windows))]
fn find_studio_mcp() -> Option<PathBuf> {
    if let Some(p) = studio_mcp_override() { return Some(p); }
    // macOS app bundles (Roblox Studio has no Linux build).
    let mut apps: Vec<PathBuf> = vec![PathBuf::from("/Applications/RobloxStudio.app")];
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            apps.push(PathBuf::from(&home).join("Applications").join("RobloxStudio.app"));
            apps.push(PathBuf::from(&home).join("Applications").join("Roblox.app"));
        }
    }
    apps.push(PathBuf::from("/Applications/Roblox.app"));
    for app in apps {
        let macos = app.join("Contents").join("MacOS");
        let mcp = macos.join("StudioMCP");
        if !mcp.is_file() { continue; }
        if ["RobloxStudio", "RobloxStudioBeta", "Roblox"].iter().any(|n| macos.join(n).is_file()) {
            return Some(mcp);
        }
    }
    None
}

/// Windows ships npx/npm/py/uvx as .cmd/.exe shims that CreateProcess cannot
/// always start directly; route those through cmd /C (ZeroScript does the same).
fn resolve_launcher(program: String, args: Vec<String>) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let has_ext = std::path::Path::new(&program).extension().is_some();
        let base = std::path::Path::new(&program)
            .file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !has_ext && matches!(base.as_str(), "npx" | "npm" | "yarn" | "pnpm" | "bunx" | "uvx" | "uv" | "py" | "python" | "python3") {
            let mut all = vec!["/C".to_string(), program];
            all.extend(args);
            return ("cmd".to_string(), all);
        }
    }
    (program, args)
}

// ── addon runtime helpers ──────────────────────────────────────────────────
async fn addon_spawn(state: &AppState, sid: &str, spec: &ServerSpec) -> Result<usize, String> {
    let envs: Vec<(String, String)> = spec.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let tools = {
        let mut addons = state.addons.lock().await;
        let runtime = addons.entry(sid.to_string()).or_insert_with(|| {
            McpRuntime::for_command(Arc::new(AtomicBool::new(false)), spec.command.clone(), spec.args.clone(), envs.clone())
        });
        runtime.program = Some(spec.command.clone());
        runtime.program_args = spec.args.clone();
        runtime.program_env = envs;
        runtime.list_tools().await.map_err(|e| format!("{e:#}"))?
    };
    state.addon_tools.lock().await.insert(sid.to_string(), tools.clone());
    state.addon_specs.lock().await.insert(sid.to_string(), spec.clone());
    Ok(tools.len())
}

async fn addon_call(state: &AppState, sid: &str, name: &str, args: serde_json::Value) -> anyhow::Result<McpCall> {
    let mut addons = state.addons.lock().await;
    let runtime = addons.get_mut(sid)
        .ok_or_else(|| anyhow::anyhow!("MCP server '{sid}' is not connected"))?;
    runtime.call_tool(name, args).await
}

/// Which addon owns this tool name? Accepts both the bare name and the
/// "server/tool" form the merged catalogue advertises on a collision.
async fn addon_owner(state: &AppState, name: &str) -> Option<(String, String)> {
    if let Some((prefix, bare)) = name.split_once('/') {
        let known = state.addons.lock().await.contains_key(prefix) || state.addon_specs.lock().await.contains_key(prefix);
        if known && !bare.is_empty() { return Some((prefix.to_string(), bare.to_string())); }
    }
    let tools = state.addon_tools.lock().await;
    let mut ids: Vec<&String> = tools.keys().collect();
    ids.sort();
    for sid in ids {
        if tools.get(sid).map(|list| list.iter().any(|t| t.get("name").and_then(|v| v.as_str()) == Some(name))).unwrap_or(false) {
            return Some((sid.clone(), name.to_string()));
        }
    }
    None
}

/// Route a tool call: addon (by prefix or by ownership) else Roblox Studio.
async fn route_call(state: &AppState, name: &str, args: serde_json::Value) -> anyhow::Result<McpCall> {
    if let Some((sid, bare)) = addon_owner(state, name).await {
        info!("routing '{name}' to addon MCP server '{sid}'");
        return addon_call(state, &sid, &bare, args).await;
    }
    roblox_tool(state, name, args).await
}

/// Merged tool catalogue: Roblox's, then each addon's. A name two servers both
/// expose is advertised as "server/tool" (the extension knows how to route
/// either form), exactly like the Python bridge.
async fn addons_merged_tools(state: &AppState, roblox_tools: &[serde_json::Value]) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let specs = state.addon_specs.lock().await.clone();
    let mut ids: Vec<String> = specs.keys().cloned().collect();
    ids.sort();
    let mut seen: Vec<String> = roblox_tools.iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(str::to_string)).collect();
    let mut merged: Vec<serde_json::Value> = Vec::new();
    let mut servers: Vec<serde_json::Value> = Vec::new();
    for sid in ids {
        let spec = specs.get(&sid).cloned().unwrap_or(ServerSpec { command: String::new(), args: Vec::new(), env: Default::default() });
        let (mut tools, alive) = {
            let mut addons = state.addons.lock().await;
            match addons.get_mut(&sid) {
                // Only re-list a LIVE server. list_tools() would respawn a dead
                // one, and a server that cannot start (no uvx, Blender closed)
                // must not burn seconds on every list_commands - Connect Blender
                // / add_server is what revives it. (child_alive/list_tools need
                // &mut, so this is an if, not a match guard.)
                Some(rt) => {
                    if rt.child_alive() {
                        (rt.list_tools().await.ok().unwrap_or_default(), true)
                    } else {
                        (Vec::new(), false)
                    }
                }
                None => (Vec::new(), false),
            }
        };
        if !alive {
            // Offline: still show what it last advertised (no second lock here -
            // the addons guard is already released above).
            tools = state.addon_tools.lock().await.get(&sid).cloned().unwrap_or_default();
        }
        if !tools.is_empty() { state.addon_tools.lock().await.insert(sid.clone(), tools.clone()); }
        let target = format!("{} {}", spec.command, spec.args.join(" ")).trim().to_string();
        for mut tool in tools {
            if let Some(obj) = tool.as_object_mut() {
                let bare = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if bare.is_empty() { continue; }
                if seen.iter().any(|s| s == &bare) {
                    obj.insert("name".to_string(), serde_json::Value::String(format!("{sid}/{bare}")));
                } else {
                    seen.push(bare);
                }
                obj.insert("server".to_string(), serde_json::Value::String(sid.clone()));
            }
            merged.push(tool);
        }
        let count = state.addon_tools.lock().await.get(&sid).map(|t| t.len()).unwrap_or(0);
        servers.push(serde_json::json!({
            "id": sid, "name": sid, "alive": alive, "tools": count, "command": target,
        }));
    }
    (merged, servers)
}

/// Status rows for every configured addon (alive + tool count), for the
/// servers[] array the extension already renders.
async fn addons_status(state: &AppState) -> Vec<serde_json::Value> {
    let specs = state.addon_specs.lock().await.clone();
    let mut ids: Vec<String> = specs.keys().cloned().collect();
    ids.sort();
    let mut out = Vec::new();
    for sid in ids {
        let spec = specs.get(&sid).cloned().unwrap_or(ServerSpec { command: String::new(), args: Vec::new(), env: Default::default() });
        let count = state.addon_tools.lock().await.get(&sid).map(|t| t.len()).unwrap_or(0);
        let alive = {
            let mut addons = state.addons.lock().await;
            addons.get_mut(&sid).map(|rt| rt.child_alive()).unwrap_or(false)
        };
        out.push(serde_json::json!({
            "id": sid, "name": sid, "alive": alive, "tools": count,
            "command": format!("{} {}", spec.command, spec.args.join(" ")).trim(),
        }));
    }
    out
}

/// Boot every configured addon, best-effort: a missing Blender must never delay
/// (or block) the Roblox connection.
async fn boot_addons(state: &AppState) {
    let cfg = read_mcp_config();
    for (sid, spec) in cfg.mcp_servers.iter() {
        if sid == PRIMARY_SERVER_ID { continue; }
        match addon_spawn(state, sid, spec).await {
            Ok(n) => info!("addon MCP '{sid}' ready ({n} tools) via {}", spec.command),
            Err(e) => tracing::warn!("addon MCP '{sid}' did not start: {e}"),
        }
    }
    if cfg.mcp_servers.keys().any(|k| k != PRIMARY_SERVER_ID) {
        info!("mcp config: {}", mcp_config_path().display());
    }
}

#[derive(Clone)]
struct AppState {
    roblox_queue: Arc<Mutex<VecDeque<Payload>>>,
    roblox_clients: Arc<RwLock<HashMap<String, String>>>,
    local_clients: Arc<RwLock<HashMap<String, String>>>,
    workspace: Arc<workspace::Workspace>,
    result_tx: broadcast::Sender<ExecResult>,
    roblox_mcp: Arc<Mutex<McpRuntime>>,
    /// ADDON MCP servers (Blender, Sketchfab, …) — one stdio client each, spawned
    /// from mcp_servers.json exactly like the primary. This is the ZeroScript
    /// model: every server in the config is a real MCP client, tools are merged,
    /// and any image content item they return rides the same reply path.
    addons: Arc<Mutex<HashMap<String, McpRuntime>>>,
    /// tool definitions per addon (also the routing table for bare tool names).
    addon_tools: Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>,
    /// the config as loaded, so status can show a server whose process is down.
    addon_specs: Arc<Mutex<HashMap<String, ServerSpec>>>,
    /// Count of in-flight MCP tools/list/probe calls. Status probes skip while
    /// this is non-zero so they never fight a 20s execute_luau for the mutex.
    mcp_in_flight: Arc<AtomicUsize>,
    roblox_proc: Arc<AtomicBool>,
    roblox_editor_connected: Arc<AtomicBool>,
}

impl AppState {
    fn new(result_tx: broadcast::Sender<ExecResult>, mcp_alive: Arc<AtomicBool>, roblox_proc: Arc<AtomicBool>, workspace: Arc<workspace::Workspace>) -> Self {
        Self {
            roblox_queue: Arc::new(Mutex::new(VecDeque::new())),
            roblox_clients: Arc::new(RwLock::new(HashMap::new())),
            local_clients: Arc::new(RwLock::new(HashMap::new())),
            workspace,
            result_tx,
            roblox_mcp: Arc::new(Mutex::new(McpRuntime::new(mcp_alive))),
            addons: Arc::new(Mutex::new(HashMap::new())),
            addon_tools: Arc::new(Mutex::new(HashMap::new())),
            addon_specs: Arc::new(Mutex::new(HashMap::new())),
            mcp_in_flight: Arc::new(AtomicUsize::new(0)),
            roblox_proc,
            roblox_editor_connected: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Persistent stdio client for Roblox Studio's built-in MCP server.
struct McpRuntime {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<Lines<BufReader<ChildStdout>>>,
    next_id: u64,
    tools: Vec<serde_json::Value>,
    alive: Arc<AtomicBool>,
    /// Set for ADDON servers (mcp_servers.json): spawn exactly this command.
    /// None = the built-in Roblox Studio launcher (discovery / mcp.bat).
    program: Option<String>,
    program_args: Vec<String>,
    program_env: Vec<(String, String)>,
}

impl McpRuntime {
    fn new(alive: Arc<AtomicBool>) -> Self {
        Self { child: None, stdin: None, stdout: None, next_id: 1, tools: Vec::new(), alive,
               program: None, program_args: Vec::new(), program_env: Vec::new() }
    }

    /// An addon server (Blender, Sketchfab, …) spawned from its own command.
    fn for_command(alive: Arc<AtomicBool>, program: String, program_args: Vec<String>, program_env: Vec<(String, String)>) -> Self {
        Self { child: None, stdin: None, stdout: None, next_id: 1, tools: Vec::new(), alive,
               program: Some(program), program_args, program_env }
    }


    fn launcher() -> anyhow::Result<(String, Vec<String>)> {
        if let Ok(raw) = std::env::var("OR_MCP_COMMAND").or_else(|_| std::env::var("ROBLOXSCRIPT_MCP_COMMAND")) {
            let mut parts = raw.split_whitespace();
            let program = parts.next().ok_or_else(|| anyhow::anyhow!("OR_MCP_COMMAND is empty"))?;
            return Ok((program.to_string(), parts.map(str::to_string).collect()));
        }
        // PREFER the newest StudioMCP.exe we can find over %LOCALAPPDATA%\Roblox\
        // mcp.bat. Roblox's .bat hard-codes ONE Studio version path; after a
        // Studio auto-update that folder is eventually deleted and the .bat's
        // fallback branch is broken batch syntax, so StudioMCP.exe never launches
        // and the bridge sees 0 tools (diagnosed by ZeroScript; same fix here).
        if let Some(exe) = find_studio_mcp() {
            info!("MCP launcher: newest StudioMCP.exe at {}", exe.display());
            return Ok((exe.display().to_string(), Vec::new()));
        }
        let local = std::env::var("LOCALAPPDATA").map_err(|_| anyhow::anyhow!("LOCALAPPDATA is unavailable; set OR_MCP_COMMAND to Studio's MCP launcher"))?;
        let bat = PathBuf::from(local).join("Roblox").join("mcp.bat");
        if !bat.is_file() {
            anyhow::bail!("No StudioMCP.exe found in any Roblox install and no mcp.bat at {}. In Studio: Assistant → … → Manage MCP Servers → Enable Studio as MCP server.", bat.display());
        }
        Ok(("cmd".to_string(), vec!["/C".to_string(), bat.to_string_lossy().to_string()]))
    }

    async fn reset(&mut self) {
        if self.child.is_some() {
            info!("MCP runtime reset — killing previous helper process");
            if let Some(child) = self.child.as_mut() {
                #[cfg(windows)]
                if let Some(pid) = child.id() {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                let _ = child.kill().await;
            }
        }
        self.child = None; self.stdin = None; self.stdout = None; self.tools.clear(); self.next_id = 1;
        self.alive.store(false, Ordering::Relaxed);
    }

    /// True if the helper process is still running. Uses try_wait so a crashed
    /// StudioMCP is not treated as alive just because Option<Child> is Some.
    fn child_alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(status)) => {
                    info!("MCP helper exited ({status})");
                    false
                }
                Err(e) => {
                    tracing::warn!("MCP try_wait failed: {e}");
                    false
                }
            },
            None => false,
        }
    }

    async fn ensure(&mut self) -> anyhow::Result<()> {
        if self.child_alive() && self.stdin.is_some() && self.stdout.is_some() {
            return Ok(());
        }
        self.reset().await;
        let (program, args) = match self.program.clone() {
            Some(p) => (p, self.program_args.clone()),
            None => Self::launcher()?,
        };
        let (program, args) = resolve_launcher(program, args);
        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in &self.program_env { cmd.env(k, v); }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| { tracing::error!("MCP helper spawn failed ({program}): {e}"); e })?;
        info!("MCP helper spawned OK: {program} {}", args.join(" "));
        self.stdin = child.stdin.take();
        self.stdout = child.stdout.take().map(|s| BufReader::new(s).lines());
        self.child = Some(child);
        let _ = self.request("initialize", serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "OR", "version": env!("CARGO_PKG_VERSION")}
        })).await.map_err(|e| { tracing::warn!("MCP initialize failed: {e:#}"); e })?;
        self.notify("notifications/initialized", serde_json::json!({})).await?;
        self.alive.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn notify(&mut self, method: &str, params: serde_json::Value) -> anyhow::Result<()> {
        let line = serde_json::json!({"jsonrpc":"2.0", "method":method, "params":params}).to_string() + "\n";
        self.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdin unavailable"))?.write_all(line.as_bytes()).await?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let request_id = self.next_id; self.next_id += 1;
        let line = serde_json::json!({"jsonrpc":"2.0", "id":request_id, "method":method, "params":params}).to_string() + "\n";
        self.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdin unavailable"))?.write_all(line.as_bytes()).await?;
        self.stdin.as_mut().unwrap().flush().await?;
        let stdout = self.stdout.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdout unavailable"))?;
        loop {
            let line = tokio::time::timeout(Duration::from_secs(120), stdout.next_line()).await
                .map_err(|_| anyhow::anyhow!("MCP request timed out: {method}"))??
                .ok_or_else(|| anyhow::anyhow!("MCP server exited while handling {method}"))?;
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            if message.get("id").and_then(|v| v.as_u64()) != Some(request_id) { continue; }
            if let Some(error) = message.get("error") { anyhow::bail!("MCP {method} failed: {error}"); }
            return message.get("result").cloned().ok_or_else(|| anyhow::anyhow!("MCP {method} returned no result"));
        }
    }

    async fn list_tools(&mut self) -> anyhow::Result<Vec<serde_json::Value>> {
        self.ensure().await?;
        let result = self.request("tools/list", serde_json::json!({})).await?;
        self.tools = result.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(self.tools.clone())
    }

    async fn probe_studio(&mut self) -> anyhow::Result<()> {
        let text = self.call_tool("get_studio_state", serde_json::json!({})).await?.text;
        if text.is_empty() || text.contains("Unable to find an active Studio instance")
            || text.contains("previously active Studio has disconnected")
            || text.contains("no active Studio") {
            anyhow::bail!("Roblox Studio is not connected");
        }
        Ok(())
    }

    async fn call_tool(&mut self, name: &str, args: serde_json::Value) -> anyhow::Result<McpCall> {
        self.ensure().await?;
        let result = self.request("tools/call", serde_json::json!({"name":name, "arguments":args})).await?;
        let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
        let content = result.get("content").and_then(|v| v.as_array());
        let text = content.map(|items| items.iter().filter_map(|item| item.get("text").and_then(|v| v.as_str())).collect::<Vec<_>>().join("\n")).unwrap_or_else(|| result.to_string());
        // Image items are passed through VERBATIM in the MCP shape the browser
        // already understands: {mimeType, data}. An empty/missing blob is skipped
        // so a malformed item can never poison the reply.
        let images = content.map(|items| items.iter().filter_map(|item| {
            if item.get("type").and_then(|v| v.as_str()) != Some("image") { return None; }
            let data = item.get("data").and_then(|v| v.as_str())?;
            if data.is_empty() { return None; }
            let mime = item.get("mimeType").and_then(|v| v.as_str()).unwrap_or("image/jpeg");
            Some(serde_json::json!({"mimeType": mime, "data": data}))
        }).collect::<Vec<_>>()).unwrap_or_default();
        if is_error { anyhow::bail!("{text}"); }
        Ok(McpCall { text, images })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExecResult { id: String, ok: bool, result: String, error: Option<String>, }

/// One MCP tool call's payload: the text content PLUS every image content item.
/// Studio's `screen_capture` hands the picture back as a
/// `{"type":"image","data":<base64>,"mimeType":...}` content item (same for
/// blender-mcp's viewport screenshot); the extension uploads those straight to
/// the chat, so they must survive this hop instead of being dropped.
struct McpCall { text: String, images: Vec<serde_json::Value> }

#[cfg(windows)]
fn port_owner_pid(port: u16) -> Option<u32> {
    let out = std::process::Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{}", port);
    for line in text.lines() {
        if !line.contains("LISTENING") || !line.contains(&needle) { continue; }
        if let Some(pid) = line.split_whitespace().last().and_then(|s| s.parse::<u32>().ok()) {
            return Some(pid);
        }
    }
    None
}
#[cfg(not(windows))]
fn port_owner_pid(_port: u16) -> Option<u32> { None }

#[cfg(windows)]
fn process_image(pid: u32) -> Option<String> {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next()
        .and_then(|l| l.split(',').next())
        .map(|s| s.trim_matches('"').to_lowercase())
}
#[cfg(not(windows))]
fn process_image(_pid: u32) -> Option<String> { None }

#[cfg(windows)]
fn reclaim_port(port: u16) -> anyhow::Result<()> {
    let Some(pid) = port_owner_pid(port) else { return Ok(()); };
    if pid == std::process::id() { return Ok(()); }
    let image = process_image(pid).unwrap_or_default();
    if image.contains("or-agent") || image.contains("totalscript-agent") || image.contains("robloxscript-agent") {
        tracing::info!("killing stale OR Agent (pid {pid}) on port {port}...");
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        std::thread::sleep(Duration::from_millis(800));
        if port_owner_pid(port).is_some() {
            anyhow::bail!("Could not free port {port} — close the old agent manually.");
        }
        tracing::info!("port {port} is free, starting fresh agent.");
        return Ok(());
    }
    if image.contains("python") || image.contains("py") {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        tracing::info!("killed stale python bridge (pid {pid}) on port {port}");
        std::thread::sleep(Duration::from_millis(600));
        return Ok(());
    }
    anyhow::bail!(
        "Port {port} is held by '{image}' (pid {pid}). Close that program or pick a\
        \ndifferent port, then start the agent again."
    );
}
#[cfg(not(windows))]
fn reclaim_port(_port: u16) -> anyhow::Result<()> { Ok(()) }

fn env_first(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| std::env::var(k).ok().filter(|s| !s.trim().is_empty()))
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}");
        #[cfg(windows)]
        win_alert("OR Agent crashed", &msg);
        eprintln!("OR Agent panic: {msg}");
    }));
    if let Err(e) = start() {
        let msg = format!("{e:#}");
        #[cfg(windows)]
        win_alert("OR Agent failed to start", &msg);
        eprintln!("OR Agent failed to start: {msg}");
        std::process::exit(1);
    }
}

#[tokio::main]
async fn start() -> anyhow::Result<()> {
    let args = Arc::new(Args::parse());
    let mcp_alive = Arc::new(AtomicBool::new(false));
    let roblox_proc = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(gui::UiShared::new(mcp_alive.clone()));
    init_file_logger(Some(shared.clone()));
    info!("=== OR Rust Agent v{} start (pid={}) ===", env!("CARGO_PKG_VERSION"), std::process::id());
    let start = std::time::Instant::now();
    let (result_tx, _) = broadcast::channel::<ExecResult>(128);
    let addr: SocketAddr = args.roblox_addr.parse().unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 3000)));
    let ws_override = env_first(&["OR_WORKSPACE_ROOT", "ROBLOXSCRIPT_WORKSPACE_ROOT"])
        .or_else(|| args.workspace.clone());
    let workspace = Arc::new(workspace::Workspace::new(ws_override.as_deref())?);
    if env_first(&["OR_FULL_ACCESS", "ROBLOXSCRIPT_FULL_ACCESS"]).map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false) {
        workspace.set_full_access(true);
    }
    shared.attach_workspace(workspace.root_display(), workspace.full_flag());
    shared.log(&format!("or-agent v{} — native bridge for roblox studio / local fs", env!("CARGO_PKG_VERSION")));
    shared.log(&format!("workspace: {}", workspace.root_display()));
    if workspace.full_access() { shared.log("FULL PC ACCESS enabled at boot (OR_FULL_ACCESS=1)"); }
    shared.log("listening: http://127.0.0.1:3000 · ws 17613 (roblox) · 17615 (agentscript)");
    shared.log("keys: [R] restart mcp · [C] clear console · [1-4] filter level");
    let state = AppState::new(result_tx, mcp_alive, roblox_proc.clone(), workspace);
    let (restart_tx, mut restart_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let rr_state = state.clone();
    tokio::spawn(async move {
        while let Some(()) = restart_rx.recv().await {
            info!("status window requested MCP restart — resetting helper then re-ensuring");
            {
                let mut mcp = rr_state.roblox_mcp.lock().await;
                mcp.reset().await;
            }
            match roblox_tools(&rr_state).await {
                Ok(_) => info!("MCP helper re-ensured after GUI restart"),
                Err(e) => tracing::warn!("MCP re-ensure after GUI restart failed: {e:#}"),
            }
        }
    });
    let ui_for_server = shared.clone();
    let ui_for_fatal = shared.clone();
    let shutdown_state = state.clone();
    let server = tokio::spawn(async move {
        if let Err(e) = run_server(state, addr, start, ui_for_server).await {
            tracing::error!("{e:#}");
            ui_for_fatal.set_fatal(format!("{e:#}"));
        }
    });
    if args.headless {
        let _ = server.await;
        Ok(())
    } else {
        match gui::run_gui(shared, restart_tx) {
            Ok(()) => {
                info!("window closed — killing MCP helper tree and exiting");
                shutdown_state.roblox_mcp.lock().await.reset().await;
                {
                    let mut addons = shutdown_state.addons.lock().await;
                    for (sid, rt) in addons.iter_mut() {
                        info!("stopping addon MCP '{sid}'");
                        rt.reset().await;
                    }
                }
                std::process::exit(0);
            }
            Err(e) => {
                tracing::error!("GUI unavailable ({e:#}) — continuing headless");
                #[cfg(windows)]
                win_alert(
                    "OR Agent",
                    &format!("The status window could not open ({e:#}).\nThe bridge is still running in the background (ports 3000 / 17613 / 17615)."),
                );
                let _ = server.await;
                Ok(())
            }
        }
    }
}

async fn run_server(state: AppState, addr: SocketAddr, start: std::time::Instant, ui: Arc<gui::UiShared>) -> anyhow::Result<()> {
    // Addon MCP servers (Blender, …) start in the background: a dead one must
    // never delay Studio coming up.
    let boot_state = state.clone();
    let boot_ui = ui.clone();
    tokio::spawn(async move {
        boot_addons(&boot_state).await;
        let extra = addons_status(&boot_state).await;
        if !extra.is_empty() {
            let names: Vec<String> = extra.iter().filter_map(|s| {
                let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let alive = s.get("alive").and_then(|v| v.as_bool()).unwrap_or(false);
                let n = s.get("tools").and_then(|v| v.as_u64()).unwrap_or(0);
                if id.is_empty() { None } else { Some(format!("{id} {} ({n} tools)", if alive { "ready" } else { "offline" })) }
            }).collect();
            boot_ui.log(&format!("addon MCP servers: {}", names.join(" · ")));
        }
    });
    let watcher_state = state.clone();
    let watcher_ui = ui.clone();
    tokio::spawn(async move {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_all();
        let has_roblox = sys.processes().values().any(|p| p.name().to_string_lossy().to_lowercase().contains("robloxstudio"));
        watcher_ui.studio_running.store(has_roblox, Ordering::Relaxed);
        watcher_state.roblox_proc.store(has_roblox, Ordering::Relaxed);
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            sys.refresh_all();
            let has_roblox = sys.processes().values().any(|p| p.name().to_string_lossy().to_lowercase().contains("robloxstudio"));
            watcher_ui.studio_running.store(has_roblox, Ordering::Relaxed);
            watcher_state.roblox_proc.store(has_roblox, Ordering::Relaxed);
            if !has_roblox {
                watcher_state.roblox_clients.write().await.clear();
                watcher_state.roblox_editor_connected.store(false, Ordering::Relaxed);
            }
        }
    });
    reclaim_port(17613).map_err(|e| { tracing::error!("{e}"); e })?;
    let s1 = state.clone();
    tokio::spawn(async move { let _ = run_legacy_ws(s1, 17613, "roblox").await; });
    reclaim_port(17615).map_err(|e| { tracing::error!("{e}"); e })?;
    let s3 = state.clone();
    tokio::spawn(async move { let _ = run_legacy_ws(s3, 17615, "local").await; });
    let ws_root_display = state.workspace.root_display();
    let cors = CorsLayer::new().allow_origin(Any).allow_methods([Method::GET, Method::POST, Method::OPTIONS]).allow_headers(Any);
    let app = Router::new()
        .route("/", get(|| async { Json(serde_json::json!({"ok": true, "service": "or-agent", "version": env!("CARGO_PKG_VERSION")})) }))
        .route("/api/connect", post(connect_handler))
        .route("/api/poll", get(poll_handler))
        .route("/api/push", post(push_handler))
        .route("/api/result", post(result_handler))
        .route("/api/disconnect", post(disconnect_handler))
        .route("/api/status", get(status_handler))
        .route("/api/local-full", post(local_full_handler))
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(cors);
    let http_port = addr.port();
    reclaim_port(http_port).map_err(|e| { tracing::error!("{e}"); e })?;
    info!("OR bridge listening on http://{} (WS /ws)", addr);
    info!("Legacy WS on ws://127.0.0.1:17613 (roblox) and 17615 (AgentScript FS: {})", ws_root_display);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Boot completed in {}ms", start.elapsed().as_millis());
    axum::serve(listener, app).await?;
    Ok(())
}

async fn connect_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    let client_id = req.get("client_id").and_then(|v| v.as_str()).unwrap_or("studio-1").to_string();
    let engine = req.get("engine").and_then(|v| v.as_str()).unwrap_or("roblox").to_string();
    let editor_connected = if engine.to_lowercase() == "local" {
        state.local_clients.write().await.insert(client_id.clone(), engine.clone());
        state.workspace.ready()
    } else {
        state.roblox_clients.write().await.insert(client_id.clone(), engine.clone());
        state.roblox_editor_connected.load(Ordering::Relaxed)
    };
    Json(serde_json::json!({
        "ok": true,
        "bridge_registered": true,
        "editor_connected": editor_connected,
        "client_id": client_id,
    }))
}
async fn poll_handler(State(state): State<AppState>, Query(_q): Query<HashMap<String,String>>) -> impl IntoResponse {
    let queue = &state.roblox_queue;
    for _ in 0..50 {
        { let mut guard = queue.lock().await; if let Some(p) = guard.pop_front() { return Json(serde_json::json!({"ok": true, "payload": p})).into_response(); } }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Json(serde_json::json!({"ok": true, "payload": null})).into_response()
}
async fn push_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    let engine = req.get("engine").and_then(|v| v.as_str()).or(req.get("target").and_then(|v| v.as_str())).unwrap_or("roblox");
    let payload = if let Some(p) = req.get("payload") { serde_json::from_value::<Payload>(p.clone()).unwrap_or(Payload{id: format!("p-{}", chrono::Utc::now().timestamp_millis()), target: engine.to_string(), code: p.to_string(), language: "luau".into(), meta: p.clone()}) } else { Payload{id: req.get("id").and_then(|v| v.as_str()).unwrap_or(&format!("p-{}", chrono::Utc::now().timestamp_millis())).to_string(), target: engine.to_string(), code: req.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string(), language: req.get("language").and_then(|v| v.as_str()).unwrap_or("luau").to_string(), meta: req.clone()} };
    state.roblox_queue.lock().await.push_back(payload.clone());
    Json(serde_json::json!({"ok": true, "queued": payload.id}))
}
async fn result_handler(State(state): State<AppState>, Json(res): Json<ExecResult>) -> impl IntoResponse {
    let _ = state.result_tx.send(res);
    Json(serde_json::json!({"ok": true}))
}
async fn disconnect_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    if let Some(id) = req.get("client_id").and_then(|v| v.as_str()) {
        state.roblox_clients.write().await.remove(id);
        state.local_clients.write().await.remove(id);
    }
    Json(serde_json::json!({"ok": true}))
}

#[derive(serde::Deserialize)]
struct LocalFullReq { enabled: bool }
async fn local_full_handler(State(state): State<AppState>, Json(req): Json<LocalFullReq>) -> impl IntoResponse {
    state.workspace.set_full_access(req.enabled);
    info!("local_full set to {} via HTTP", req.enabled);
    Json(serde_json::json!({"ok": true, "local_full": req.enabled}))
}

async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {    Json(serde_json::json!({
        // Reported so the extension can tell an old binary from a new one: the
        // capture path needs 1.18.1+ (MCP image content items survive the hop),
        // and a stale or-agent.exe is otherwise invisible from the chat.
        "version": env!("CARGO_PKG_VERSION"),
        "roblox_connected": state.roblox_editor_connected.load(Ordering::Relaxed),
        "roblox_bridge_connected": state.roblox_clients.read().await.len() > 0,
        "local_bridge_connected": state.local_clients.read().await.len() > 0,
        "local_ready": state.workspace.ready(),
        "local_root": state.workspace.root_display(),
        "local_full": state.workspace.full_access(),
        "roblox_queue": state.roblox_queue.lock().await.len(),
        "roblox_proc": state.roblox_proc.load(Ordering::Relaxed),
        "mcp_busy": state.mcp_in_flight.load(Ordering::Relaxed) > 0,
    }))
}
async fn ws_handler(ws: axum::extract::ws::WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

fn helper_is_dead(error: &anyhow::Error) -> bool {
    let msg = format!("{error:#}");
    msg.contains("exited") || msg.contains("timed out") || msg.contains("stdin unavailable")
        || msg.contains("stdout unavailable") || msg.contains("spawn failed")
}

struct InFlight<'a>(&'a AtomicUsize);
impl<'a> InFlight<'a> {
    fn enter(flag: &'a AtomicUsize) -> Self {
        flag.fetch_add(1, Ordering::Relaxed);
        InFlight(flag)
    }
}
impl Drop for InFlight<'_> {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Relaxed); }
}

async fn roblox_tools(state: &AppState) -> anyhow::Result<Vec<serde_json::Value>> {
    let _busy = InFlight::enter(&state.mcp_in_flight);
    let mut mcp = state.roblox_mcp.lock().await;
    match mcp.list_tools().await {
        Ok(tools) => Ok(tools),
        Err(error) => {
            if !helper_is_dead(&error) { return Err(error); }
            tracing::warn!("list_tools failed ({error:#}) — recycling helper once");
            mcp.reset().await;
            match mcp.list_tools().await {
                Ok(tools) => Ok(tools),
                Err(error2) => {
                    tracing::warn!("list_tools retry failed: {error2:#}");
                    if helper_is_dead(&error2) { mcp.reset().await; }
                    Err(error2)
                }
            }
        }
    }
}

async fn roblox_tool(state: &AppState, name: &str, args: serde_json::Value) -> anyhow::Result<McpCall> {
    let _busy = InFlight::enter(&state.mcp_in_flight);
    let mut mcp = state.roblox_mcp.lock().await;
    match mcp.call_tool(name, args.clone()).await {
        Ok(result) => Ok(result),
        Err(error) => {
            if !helper_is_dead(&error) { return Err(error); }
            tracing::warn!("call_tool '{name}' failed ({error:#}) — recycling helper once");
            mcp.reset().await;
            match mcp.call_tool(name, args).await {
                Ok(result) => {
                    info!("call_tool '{name}' recovered after helper recycle");
                    Ok(result)
                }
                Err(error2) => {
                    tracing::warn!("call_tool '{name}' retry failed: {error2:#}");
                    if helper_is_dead(&error2) { mcp.reset().await; }
                    Err(error2)
                }
            }
        }
    }
}

async fn handle_ws(socket: axum::extract::ws::WebSocket, state: AppState) {
    let (mut send, mut recv) = socket.split();
    let mut rx = state.result_tx.subscribe();
    let send_task = tokio::spawn(async move { while let Ok(res) = rx.recv().await { let txt = serde_json::to_string(&res).unwrap_or_default(); if send.send(axum::extract::ws::Message::Text(txt)).await.is_err() { break; } } });
    while let Some(Ok(msg)) = recv.next().await {
        if let axum::extract::ws::Message::Text(txt) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                if val.get("code").is_some() {
                    let engine = val.get("engine").and_then(|v| v.as_str()).unwrap_or("roblox").to_string();
                    let payload = Payload{ id: val.get("id").and_then(|v| v.as_str()).unwrap_or("p-1").to_string(), target: engine.clone(), code: val.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string(), language: "luau".into(), meta: val.clone()};
                    state.roblox_queue.lock().await.push_back(payload);
                }
            }
        }
    }
    send_task.abort();
}

async fn run_legacy_ws(state: AppState, port: u16, engine: &str) -> anyhow::Result<()> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        let eng = engine.to_string();
        tokio::spawn(async move { if let Ok(ws) = tokio_tungstenite::accept_async(stream).await { handle_legacy_ws(ws, state, eng).await; } });
    }
}

async fn handle_legacy_ws(ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, state: AppState, engine: String) {
    let client_key = format!("ext-{engine}");
    if engine == "local" {
        state.local_clients.write().await.insert(client_key.clone(), engine.clone());
    } else {
        state.roblox_clients.write().await.insert(client_key.clone(), engine.clone());
    }
    info!("legacy WS [{engine}] client connected");
    let (mut write, mut read) = ws_stream.split();
    // Outbound channel so ping/status keep flowing while a tool runs on another task.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(txt) = out_rx.recv().await {
            if write.send(tokio_tungstenite::tungstenite::Message::Text(txt.into())).await.is_err() { break; }
        }
    });
    let send_json = |tx: &tokio::sync::mpsc::UnboundedSender<String>, v: serde_json::Value| {
        let _ = tx.send(v.to_string());
    };

    let intro = tokio::time::timeout(Duration::from_secs(8), async {
        if engine == "local" {
            let ready = state.workspace.ready();
            let tools = workspace::catalog();
            serde_json::json!({"type":"connected","id":0,"ok":ready,"mcp_alive":ready,"studio":ready,"tools":tools,"servers":[{"id":"local","name":"Local Filesystem","alive":ready,"tools":if ready { tools.len() } else { 0 }}],"workspace_root":state.workspace.root_display()})
        } else {
            match roblox_tools(&state).await {
                Ok(tools) => {
                    let studio = {
                        let mut mcp = state.roblox_mcp.lock().await;
                        mcp.probe_studio().await.is_ok()
                    };
                    state.roblox_editor_connected.store(studio, Ordering::Relaxed);
                    serde_json::json!({"type":"connected","id":0,"ok":studio,"mcp_alive":true,"studio":studio,"tools":tools,"servers":[{"id":"roblox","name":"Roblox Studio MCP","alive":studio,"tools":if studio { tools.len() } else { 0 }}]})
                },
                Err(_) => serde_json::json!({"type":"connected","id":0,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"servers":[{"id":"roblox","name":"Roblox Studio MCP","alive":false,"tools":0}]}),
            }
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"type":"connected","id":0,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"servers":[]}));
    send_json(&out_tx, intro);
    let mut last_online: Option<bool> = None;
    while let Some(Ok(msg)) = read.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(txt) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                let typ = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let id = val.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                match typ {
                    "ping" => { send_json(&out_tx, serde_json::json!({"type":"pong","id":id})); },
                    "list_tools" => {
                        let response = if engine == "local" {
                            let ready = state.workspace.ready();
                            let tools = workspace::catalog();
                            serde_json::json!({"type":"tools","id":id,"ok":ready,"mcp_alive":ready,"studio":ready,"tools":tools,"servers":[{"id":"local","name":"Local Filesystem","alive":ready,"tools":if ready { tools.len() } else { 0 }}]})
                        } else {
                            match roblox_tools(&state).await {
                                Ok(tools) => {
                                    let studio = if state.mcp_in_flight.load(Ordering::Relaxed) > 1 {
                                        // Another tool is in flight (list_tools itself holds 1). Skip extra probe.
                                        state.roblox_editor_connected.load(Ordering::Relaxed)
                                    } else {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    state.roblox_editor_connected.store(studio, Ordering::Relaxed);
                                    {
                                        // Roblox's tools first, then every addon
                                        // MCP server's (Blender, Sketchfab, …), with
                                        // collisions advertised as "server/tool".
                                        let roblox_count = tools.len();
                                        let (addon_defs, addon_servers) = addons_merged_tools(&state, &tools).await;
                                        let mut all_tools = tools;
                                        all_tools.extend(addon_defs);
                                        let mut servers = vec![serde_json::json!({"id":"roblox","name":"Roblox Studio MCP","alive":studio,"tools":if studio { roblox_count } else { 0 }})];
                                        servers.extend(addon_servers);
                                        serde_json::json!({"type":"tools","id":id,"ok":studio,"mcp_alive":true,"studio":studio,"tools":all_tools,"servers":servers})
                                    }
                                },
                                Err(error) => serde_json::json!({"type":"tools","id":id,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"error":error.to_string()}),
                            }
                        };
                        send_json(&out_tx, response);
                    },
                    "studio_status" => {
                        let online = match engine.as_str() {
                            "local" => state.workspace.ready(),
                            "roblox" => {
                                if state.mcp_in_flight.load(Ordering::Relaxed) > 0 {
                                    // Cached probe: a 20s execute_luau owns the helper.
                                    // Never lock / never mark MCP dead mid-tool.
                                    state.roblox_editor_connected.load(Ordering::Relaxed)
                                        && state.roblox_proc.load(Ordering::Relaxed)
                                } else {
                                    let probed = {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    probed && state.roblox_proc.load(Ordering::Relaxed)
                                }
                            }
                            _ => false,
                        };
                        if engine == "roblox" {
                            state.roblox_editor_connected.store(online, Ordering::Relaxed);
                        }
                        if last_online != Some(online) {
                            info!("studio_status [{engine}]: {}", if online { "CONNECTED" } else { "OFFLINE" });
                            last_online = Some(online);
                        }
                        send_json(&out_tx, serde_json::json!({"type":"studio_status","id":id,"studio":online,"studio_app":online,"studio_proc":online}));
                    },
                    "restart_mcp" => {
                        let alive = if engine == "roblox" {
                            {
                                let mut mcp = state.roblox_mcp.lock().await;
                                mcp.reset().await;
                            }
                            state.roblox_editor_connected.store(false, Ordering::Relaxed);
                            match roblox_tools(&state).await {
                                Ok(tools) => {
                                    let studio = {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    state.roblox_editor_connected.store(studio, Ordering::Relaxed);
                                    send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":true,"alive":true,"studio":studio,"tools":tools}));
                                    true
                                }
                                Err(error) => {
                                    tracing::warn!("restart_mcp re-ensure failed: {error:#}");
                                    send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":false,"alive":false,"error":error.to_string()}));
                                    false
                                }
                            }
                        } else {
                            send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":true,"alive":true}));
                            true
                        };
                        let _ = alive;
                    },
                    "call_tool" => {
                        let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                        let args = val.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
                        let state2 = state.clone();
                        let eng = engine.clone();
                        let tx = out_tx.clone();
                        tokio::spawn(async move {
                            let outcome: anyhow::Result<(String, Vec<serde_json::Value>)> = match eng.as_str() {
                                "local" => { workspace::dispatch(&state2.workspace, &name, args).await.map(|t| (t, Vec::new())).map_err(anyhow::Error::msg) }
                                "roblox" => route_call(&state2, &name, args).await.map(|c| (c.text, c.images)),
                                _ => Err(anyhow::anyhow!("unknown engine")),
                            };
                            let response = match outcome {
                                Ok((text, images)) => serde_json::json!({"type":"tool_result","id":id,"ok":true,"text":text,"images":images}),
                                Err(error) => serde_json::json!({"type":"tool_result","id":id,"ok":false,"kind":"execution","error":error.to_string()}),
                            };
                            let _ = tx.send(response.to_string());
                        });
                    },
                    "add_server" => {
                        let sid = val.get("server_id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        let command = val.get("command").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        if sid.is_empty() || command.is_empty() {
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":false,"error":"server_id and command are required"}));
                        } else if sid == PRIMARY_SERVER_ID {
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":false,"error":format!("'{PRIMARY_SERVER_ID}' is the primary server and cannot be edited")}));
                        } else {
                            let args: Vec<String> = val.get("args").and_then(|v| v.as_array())
                                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                                .unwrap_or_default();
                            let env: std::collections::BTreeMap<String, String> = val.get("env").and_then(|v| v.as_object())
                                .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
                                .unwrap_or_default();
                            let spec = ServerSpec { command, args, env };
                            // Persist first: a server we cannot save would vanish on restart.
                            let mut cfg = read_mcp_config();
                            cfg.mcp_servers.insert(sid.clone(), spec.clone());
                            let saved = write_mcp_config(&cfg);
                            let spawned = if saved.is_ok() { addon_spawn(&state, &sid, &spec).await } else { Err("config not saved".to_string()) };
                            let (ok, error) = match (&saved, &spawned) {
                                (Err(e), _) => (false, Some(e.clone())),
                                (_, Err(e)) => (false, Some(format!("saved to the config, but the server did not start: {e}"))),
                                _ => (true, None),
                            };
                            let mut servers = addons_status(&state).await;
                            servers.push(serde_json::json!({"id": PRIMARY_SERVER_ID, "name": "Roblox Studio MCP",
                                "alive": state.roblox_editor_connected.load(Ordering::Relaxed), "tools": 0}));
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":ok,
                                "server_id":sid,"tools":spawned.clone().ok(),"error":error,"servers":servers,
                                "config": mcp_config_path().display().to_string()}));
                        }
                    }
                    "remove_server" => {
                        let sid = val.get("server_id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        if sid.is_empty() {
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":false,"error":"server_id is required"}));
                        } else if sid == PRIMARY_SERVER_ID {
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":false,"error":format!("'{PRIMARY_SERVER_ID}' is the primary server and cannot be removed")}));
                        } else {
                            let mut cfg = read_mcp_config();
                            cfg.mcp_servers.remove(&sid);
                            let saved = write_mcp_config(&cfg);
                            if let Some(mut rt) = state.addons.lock().await.remove(&sid) { rt.reset().await; }
                            state.addon_tools.lock().await.remove(&sid);
                            state.addon_specs.lock().await.remove(&sid);
                            send_json(&out_tx, serde_json::json!({"type":"server_changed","id":id,"ok":saved.is_ok(),
                                "server_id":sid,"error":saved.err(),"servers":addons_status(&state).await}));
                        }
                    },
                    _ => { send_json(&out_tx, serde_json::json!({"type":"error","id":id,"error":"unknown bridge message type"})); }
                }
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    if engine == "local" {
        state.local_clients.write().await.remove(&client_key);
    } else {
        state.roblox_clients.write().await.remove(&client_key);
    }
    if engine == "roblox" {
        state.roblox_editor_connected.store(false, Ordering::Relaxed);
    }
    info!("legacy WS [{engine}] client disconnected");
}
