// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const PORT_ROBLOX = 17613;
const PORT_LOCAL = 17615; // AgentScript — native FS/terminal engine
const BLENDER_ADDON_PORT = 9876;
const RUST_ROBLOX_HTTP = "http://127.0.0.1:3000";
const ENGINE_KEY = "rs-engine";
// "anim" (Animation mode) is a persona-driven view of the SAME Roblox bridge:
// it maps to 17613 everywhere a port/HTTP target is picked, but keeps its own
// id so prompts, accents and UI state stay engine-isolated.
const ENGINES = ["roblox", "local"];
function normalizeEngine(v) { return v === "local" ? "local" : "roblox"; }
let engine = "roblox"; // "roblox" | "local"
let rustMode = false; // true if Rust agent on 3000 is reachable (preferred)
// Version the running or-agent reports on /api/status. "" = a build from before
// the field existed, i.e. older than 1.18.1 - the UI says so instead of leaving
// a stale binary invisible from the chat.
let agentVersion = "";
chrome.storage?.local.get(ENGINE_KEY, (o) => {
  const want = normalizeEngine(o && o[ENGINE_KEY]);
  if (want !== engine) {
    engine = want;
    log(`engine init corrected to ${engineLabel()} -> ${engineUrl()}`);
    try { ws?.close(); } catch {}
    connected = false;
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
});
// Probe Rust agent on 3000 at startup — if reachable, use HTTP pipe (CORS bypass) as primary
(async () => {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (r.ok) {
      rustMode = true;
      log("Rust agent detected on 3000 — HTTP pipe enabled (CORS bypass via background)");
    }
  } catch {}
})();
function engineUrl() { return `ws://127.0.0.1:${engine === "local" ? PORT_LOCAL : PORT_ROBLOX}`; }
function engineHttpUrl() { return RUST_ROBLOX_HTTP; }
function engineLabel() { return engine === "local" ? "AgentScript" : "Roblox"; }
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ENGINE_KEY]) {
    const want = normalizeEngine(changes[ENGINE_KEY].newValue);
    if (want === engine) return; // dedupe rs-set-engine double fire
    engine = want;
    log(`engine switched to ${engineLabel()} -> ${engineUrl()} — FULL ISOLATION`);
    try { ws?.close(); } catch {}
    connected = false;
    mcpAlive = false;
    toolsCache = [];
    serversCache = [];
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    failAllPending(`engine switched to ${engine}`);
    reconnectDelay = RECONNECT_MIN;
    connect();
    broadcastStatus();
  }
});

// Chat sites where an OR provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://www.claude.ai/*", "https://claude.com/*", "https://www.claude.com/*", "https://gemini.google.com/*", "https://www.kimi.com/*", "https://kimi.com/*", "https://kimi.ai/*", "https://www.kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://freebuff.ai/*", "https://www.freebuff.ai/*", "https://freebuff.com/*", "https://www.freebuff.com/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://github.com/copilot", "https://github.com/copilot/*", "https://copilot.microsoft.com/*", "https://m365.cloud.microsoft/*", "https://gpt.crax.lol/*", "https://use.ai/*", "https://www.use.ai/*", "https://oxalpha.com/*", "https://www.oxalpha.com/*", "https://oxalpha.org/*", "https://www.oxalpha.org/*", "http://localhost/*", "http://127.0.0.1/*", "https://ollama.com/*", "https://*.ollama.com/*"];

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 140000; // above 120s tool timeout so a long execute_luau never looks half-open
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;
let robloxProc = false;
// Editor-backed status. A local bridge socket is not an editor connection.
let robloxEditorConnected = false;
let localReady = false; // agent's workspace is up (from /api/status local_ready)
let localFull = false; // AgentScript FULL PC ACCESS (agent is source of truth)
let localRoot = ""; // workspace path, injected into the AI's state line
let blenderAddon = false; // Blender is connected (either transport below)
// "mcp" = the blender-mcp SERVER is hosted by the agent (a config-driven addon,
// same method as ZeroScript: its tools merge into the catalogue and its images
// arrive as MCP image content items). "tcp" = the direct socket to the Blender
// addon on 9876, which OR's own convenience ops still use.
let blenderMode = "";
let blenderError = "";
// The command that hosts blender-mcp; overridable via chrome.storage
// "rs-blender-mcp-cmd" for uvx/pipx/manual installs.
const BLENDER_MCP_CMD = { command: "uvx", args: ["blender-mcp"] };
// blender-mcp's OWN tool names - what the addon MCP server answers. OR's
// convenience tools (blender_add_cube, blender_send_to_studio, …) are NOT here:
// those are built on blender_ops.py and stay on the direct transport.
const BLENDER_MCP_TOOLS = new Set([
  "get_scene_info", "get_object_info", "get_viewport_screenshot", "execute_blender_code",
  "download_polyhaven_asset", "set_texture", "get_polyhaven_status",
  "get_hyper3d_status", "generate_hyper3d_model_via_text", "generate_hyper3d_model_via_images",
  "poll_rodin_job_status", "import_generated_asset", "generate_hunyuan3d_model",
  "poll_hunyuan_job_status", "import_hunyuan_asset",
]);

// Register/refresh the blender-mcp addon server in the AGENT (mcp_servers.json).
async function blenderMcpRegister() {
  let cmd = BLENDER_MCP_CMD;
  try {
    const o = await new Promise((res) => chrome.storage.local.get("rs-blender-mcp-cmd", res));
    if (o && o["rs-blender-mcp-cmd"] && o["rs-blender-mcp-cmd"].command) cmd = o["rs-blender-mcp-cmd"];
  } catch {}
  const r = await send({
    type: "add_server", server_id: "blender",
    command: cmd.command, args: cmd.args || [], env: cmd.env,
  }, 45000);
  if (r && r.ok) return { ok: true, tools: r.tools, servers: r.servers };
  return { ok: false, error: (r && r.error) || "the agent refused the blender MCP server" };
}
let blenderScriptsReady = false;
const BLENDER_TOOL_NAMES = new Set([
  "get_scene_info", "get_object_info", "execute_blender_code", "get_viewport_screenshot",
  "blender_export_fbx", "blender_import_fbx", "blender_export_obj", "blender_import_obj",
  "blender_mesh_dump", "blender_send_to_studio", "blender_execute_code",
  "blender_get_scene_info", "blender_get_object_info",
  "export_blender_fbx", "import_blender_fbx",
]);
function btool(name, description, props, required) {
  return { name, server: "blender", description, inputSchema: { type: "object", properties: props || {}, required: required || [] } };
}
const BLENDER_TOOLS = [
  btool("get_scene_info", "Inspect the live Blender scene (objects, cameras, lights, collections).", {}, []),
  btool("get_object_info", "Details for one object in the Blender scene.", { name: { type: "string" } }, ["name"]),
  btool("execute_blender_code", "Run Python (bpy) inside Blender. Prefer the named blender_* tools.", { code: { type: "string" } }, ["code"]),
  btool("get_viewport_screenshot", "Capture the Blender 3D viewport.", { max_size: { type: "integer" } }, []),
  btool("blender_send_to_studio", "ONE SHOT: dump the live Blender meshes and import them into Roblox Studio as Workspace.OR_Imported. No filepath needed.", { objects: { type: "array", items: { type: "string" } }, dest: { type: "string" }, scale: { type: "number" } }, []),
  btool("blender_export_fbx", "Export meshes to an FBX (Forward -Z, Up Y). filepath optional. Also dumps meshes so blender_send_to_studio / asset_bridge_import can run with no path.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_fbx", "Import an FBX into the live Blender scene. filepath optional — defaults to the last OR export.", { filepath: { type: "string" } }, []),
  btool("blender_export_obj", "Export selected/all meshes to OBJ. filepath optional.", { filepath: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_import_obj", "Import an OBJ into the live Blender scene.", { filepath: { type: "string" } }, ["filepath"]),
  btool("blender_add_cube", "Add a cube.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array", items: { type: "number" } } }, []),
  btool("blender_add_sphere", "Add a UV sphere.", { name: { type: "string" }, radius: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cylinder", "Add a cylinder.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_cone", "Add a cone.", { name: { type: "string" }, radius: { type: "number" }, depth: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_plane", "Add a plane.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_torus", "Add a torus.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_monkey", "Add Suzanne (monkey head).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_empty", "Add an Empty (use as a group parent).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_camera", "Add a camera.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_light", "Add a light (SUN/POINT/SPOT/AREA).", { name: { type: "string" }, type: { type: "string" }, location: { type: "array" }, energy: { type: "number" } }, []),
  btool("blender_group", "Group objects: parent them to a new Empty and put them in a collection of the same name.", { name: { type: "string", description: "Group name" }, objects: { type: "array", items: { type: "string" }, description: "Object names; omit = selected/all meshes" } }, []),
  btool("blender_ungroup", "Ungroup: clear parent, keep world transforms, remove the group Empty.", { name: { type: "string" } }, []),
  btool("blender_parent", "Parent objects under an existing object/Empty.", { parent: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, ["parent"]),
  btool("blender_unparent", "Clear parent, keep world transforms.", { objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_join", "Join mesh objects into one.", { objects: { type: "array", items: { type: "string" } }, name: { type: "string" } }, []),
  btool("blender_move_to_collection", "Move objects into a collection (created if missing).", { collection: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_list_collections", "List collections and their objects.", {}, []),
  btool("blender_list_objects", "List every object: type, location, parent, collections.", {}, []),
  btool("blender_delete", "Delete objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_duplicate", "Duplicate objects.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_rename", "Rename an object.", { name: { type: "string" }, new_name: { type: "string" } }, ["new_name"]),
  btool("blender_select", "Select objects by name.", { name: { type: "string" }, objects: { type: "array", items: { type: "string" } } }, []),
  btool("blender_transform", "Set location / rotation (radians) / scale.", { name: { type: "string" }, objects: { type: "array" }, location: { type: "array" }, rotation: { type: "array" }, scale: { type: "array" } }, []),
  btool("blender_apply_transforms", "Apply rotation/scale (and optional location).", { objects: { type: "array" }, location: { type: "boolean" }, rotation: { type: "boolean" }, scale: { type: "boolean" } }, []),
  btool("blender_set_origin", "Set object origin (ORIGIN_GEOMETRY, ORIGIN_CURSOR, ORIGIN_CENTER_OF_MASS).", { name: { type: "string" }, type: { type: "string" } }, []),
  btool("blender_shade_smooth", "Shade smooth.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_material", "Assign a Principled BSDF material. color = [r,g,b] or [r,g,b,a] 0–1.", { name: { type: "string" }, material: { type: "string" }, color: { type: "array" } }, []),
  btool("blender_add_modifier", "Add a modifier: SUBSURF, BEVEL, SOLIDIFY, MIRROR, ARRAY, BOOLEAN, DECIMATE. apply=true to apply.", { name: { type: "string" }, type: { type: "string" }, levels: { type: "integer" }, apply: { type: "boolean" }, target: { type: "string" } }, []),
  btool("blender_boolean", "Boolean one mesh with another (DIFFERENCE/UNION/INTERSECT) and apply.", { name: { type: "string" }, target: { type: "string" }, operation: { type: "string" } }, ["target"]),
  btool("blender_clear_scene", "Delete objects. keep = names to leave.", { keep: { type: "array", items: { type: "string" } } }, []),
  btool("blender_add_grid", "Add a grid.", { name: { type: "string" }, size: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_add_text", "Add 3D text. text=string, extrude=thickness.", { name: { type: "string" }, text: { type: "string" }, extrude: { type: "number" }, location: { type: "array" } }, []),
  btool("blender_translate", "Move objects by offset [x,y,z] (relative).", { offset: { type: "array" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_rotate", "Set rotation in DEGREES [x,y,z]. add=true to add.", { rotation_deg: { type: "array" }, add: { type: "boolean" }, name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_set_dimensions", "Set object size in meters [x,y,z].", { dimensions: { type: "array" }, name: { type: "string" } }, []),
  btool("blender_origin_to_bottom", "Put origin at the lowest point (Roblox feet).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_drop_to_ground", "Move objects so the lowest vertex sits on Z=0.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_array", "Duplicate along offset, count times.", { count: { type: "integer" }, offset: { type: "array" }, objects: { type: "array" } }, []),
  btool("blender_mirror", "Mirror-duplicate across X/Y/Z.", { axis: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_triangulate", "Convert faces to triangles (needed before Studio).", { objects: { type: "array" } }, []),
  btool("blender_apply_modifiers", "Apply every modifier so dump/export sees the result.", { objects: { type: "array" } }, []),
  btool("blender_merge", "Merge-by-distance (remove doubles).", { distance: { type: "number" }, objects: { type: "array" } }, []),
  btool("blender_recalc_normals", "Recalculate outside normals.", { objects: { type: "array" } }, []),
  btool("blender_hide", "Hide objects.", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_unhide", "Unhide objects (omit names = all).", { name: { type: "string" }, objects: { type: "array" } }, []),
  btool("blender_undo", "Undo last Blender action.", {}, []),
  btool("blender_stats", "Vertex/face/modifier counts.", { objects: { type: "array" } }, []),
  btool("blender_get_selection", "Names of selected objects.", {}, []),
  btool("blender_uv_unwrap", "Smart UV project.", { objects: { type: "array" } }, []),
  btool("blender_look_at", "Point an object/camera at a target or location.", { name: { type: "string" }, target: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_align_camera", "Align the scene camera to an axis (front/back/left/right/top/bottom/iso) looking at a target or the selection.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_align_camera_axis", "Same as blender_align_camera.", { axis: { type: "string" }, distance: { type: "number" }, target: { type: "string" }, name: { type: "string" } }, []),
  btool("blender_view_axis", "Align the 3D viewport to FRONT/BACK/LEFT/RIGHT/TOP/BOTTOM (or iso via camera).", { axis: { type: "string" } }, []),
  btool("blender_camera_to_view", "Move the scene camera to match the current 3D viewport.", {}, []),
  btool("blender_set_camera_lens", "Set camera focal length, clip planes, or orthographic mode.", { name: { type: "string" }, lens: { type: "number" }, clip_start: { type: "number" }, clip_end: { type: "number" }, ortho: { type: "boolean" }, ortho_scale: { type: "number" } }, []),
  btool("blender_scale", "Scale selected/named objects. scale:[x,y,z] or a number. multiply=true multiplies current scale.", { name: { type: "string" }, scale: { type: "array" }, factor: { type: "array" }, multiply: { type: "boolean" } }, []),
  btool("blender_bevel", "Bevel mesh edges in edit mode.", { name: { type: "string" }, width: { type: "number" }, segments: { type: "number" } }, []),
  btool("blender_solidify", "Add a Solidify modifier (thickness).", { name: { type: "string" }, thickness: { type: "number" } }, []),
  btool("blender_extrude", "Extrude the mesh along normals.", { name: { type: "string" }, distance: { type: "number" } }, []),
  btool("blender_add_curve", "Add a Bezier curve.", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_add_armature", "Add an armature (single bone).", { name: { type: "string" }, location: { type: "array" } }, []),
  btool("blender_keyframe_insert", "Insert a keyframe on location/rotation/scale (or data_path) at frame.", { name: { type: "string" }, frame: { type: "number" }, data_path: { type: "string" } }, []),
  btool("blender_set_frame", "Set the current scene frame.", { frame: { type: "number" } }, []),
  btool("blender_set_active_camera", "Make a camera the scene camera.", { name: { type: "string" } }, []),
  btool("blender_track_to", "TRACK_TO constraint from selected objects toward target.", { target: { type: "string" }, name: { type: "string" } }, ["target"]),
  btool("blender_cursor_to_selected", "Move the 3D cursor to the selection midpoint.", { name: { type: "string" } }, []),
  btool("blender_randomize_transform", "Jitter location/rotation/scale of selected objects.", { name: { type: "string" }, location: { type: "number" }, rotation: { type: "number" }, scale: { type: "number" }, seed: { type: "number" } }, []),
  btool("blender_hide_render", "Hide (or unhide) objects from render.", { name: { type: "string" }, hide: { type: "boolean" } }, []),
  btool("blender_subdivision", "Add a Subdivision Surface modifier.", { name: { type: "string" }, levels: { type: "number" }, render_levels: { type: "number" } }, []),
  btool("blender_origin_to_geometry", "Set origin to geometry for selected objects.", { name: { type: "string" } }, []),
];
for (const t of BLENDER_TOOLS) BLENDER_TOOL_NAMES.add(t.name);

function blenderServers(list) {
  const rest = (Array.isArray(list) ? list : []).filter((s) => s && s.id !== "blender");
  if (blenderAddon) {
    rest.push({
      id: "blender", name: "Blender",
      alive: true, tools: BLENDER_TOOLS.length,
    });
  }
  return rest;
}
function mergeBlenderTools(tools) {
  const base = Array.isArray(tools) ? tools.slice() : [];
  if (!blenderAddon) return base;
  const have = new Set(base.map((t) => t && t.name));
  for (const t of BLENDER_TOOLS) if (!have.has(t.name)) base.push(t);
  return base;
}

function log(...a) {
  console.log("[or-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  const url = engineUrl();
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    if (sock !== ws) return;
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log(`connected to ${engineLabel()} bridge (${url})`);
    startHeartbeat();
    refreshProcStatus();
    broadcastStatus();
  };

  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  sock.onclose = () => {
    if (sock !== ws) return;
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    robloxEditorConnected = false;
    toolsCache = [];
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  sock.onerror = () => {
    if (sock !== ws) return;
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { sock.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      const toolPending = [...pending.values()].some((p) => p.type === "call_tool");
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        if (toolPending) return; // execute_luau owns the helper — pong resumes after it
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      // Use short timeout so pending ping doesn't leak for 130s
      send({ type: "ping" }, 12000).catch(() => {});
      refreshStudioStatus();
      // ── MCP auto-heal (v1.12) ────────────────────────────────────────────
      // The StudioMCP helper the agent spawns can die on its own (Studio
      // update, sleep/resume, crash). The agent only recycles it when a TOOL
      // call proves the helper dead - so between calls the bar kept showing
      // "connected" with a corpse helper and every command failed. If the
      // helper has been dead for two consecutive heartbeats, restart it
      // proactively (max once per 3 min so a legitimately closed Studio can't
      // cause a restart loop - the agent refuses when Studio's MCP option is
      // off, and that answer must win).
      if ((engine === "roblox" || engine === "anim") && !toolPending) {
        // Studio closed / MCP plugin off: do not restart-loop the helper.
        if (studioProc === false || studioApp === false) {
          mcpDownStreak = 0;
        } else if (!mcpAlive) {
          mcpDownStreak++;
          // Idle heal: one missed heartbeat, 30s cooldown. Never heal mid-tool.
          if (mcpDownStreak >= 1 && Date.now() - lastMcpHealAt > 30000) {
            lastMcpHealAt = Date.now();
            mcpDownStreak = 0;
            log("MCP helper down across heartbeats - auto-restarting Studio MCP");
            send({ type: "restart_mcp" }, 30000).then((r) => {
              if (r && r.ok) {
                send({ type: "list_tools" }, 10000).catch(() => {});
                refreshStudioStatus();
              }
            }).catch(() => {});
          }
        } else {
          mcpDownStreak = 0;
        }
      }
    }
  }, HEARTBEAT_MS);
}
// Auto-heal state (see startHeartbeat).
let mcpDownStreak = 0;
let lastMcpHealAt = 0;

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 20000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(20000);
  }
  const attempt = () => new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer, type: obj.type });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
  let r = await attempt();
  if (r && r.kind === "disconnected") {
    await waitForConnection(15000);
    r = await attempt();
  }
  return r;
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  if ([...pending.values()].some((p) => p.type === "call_tool")) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = v === true;
    // local readiness comes from the agent's /api/status (local_ready), not editor probes
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    } else {
      // The probe result can change independently of the tri-state cache when a
      // timeout returns null, so still publish the strict editor flag.
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    const online = studioConnected === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: true, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    const online = msg.studio === true;
    if (engine === "roblox" || engine === "anim") robloxEditorConnected = online;
    resolvePending(msg.id, { ok: !!msg.ok, tools: toolsCache, studio: online });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) {
      serversCache = msg.servers;
      const rbx = serversCache.find((x) => x.id === "roblox" || x.id === "studio");
      if (rbx) robloxEditorConnected = !!rbx.alive;
      const loc = serversCache.find((x) => x.id === "local");
      if (loc) localReady = !!loc.alive;
    }
    resolvePending(msg.id, { ok: !!msg.ok, alive: mcpAlive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open provider tab + popup ─────────────────────────
function statusObj() {
  return {
    type: "rs-status", connected, mcpAlive, studio: studioConnected, studioApp, studioProc,
    robloxProc, roblox_connected: robloxEditorConnected,
    local_connected: localReady, local_full: localFull,
    local_root: localRoot,
    tools: mergeBlenderTools(toolsCache).length,
    servers: blenderServers(serversCache), engine,
    blender: blenderAddon, blender_mode: blenderMode || undefined,
    blender_error: blenderError || undefined,
    // Absent on agents older than 1.18.1 - the UI reads "" as "old build".
    agent_version: agentVersion || undefined,
  };
}

async function refreshProcStatus() {
  try {
    const r = await fetch(`${RUST_ROBLOX_HTTP}/api/status`, { method: "GET" });
    if (!r.ok) return;
    const j = await r.json();
    const nr = !!j.roblox_proc;
    const nl = j.local_ready === true;
    const nf = j.local_full === true;
    const nv = typeof j.version === "string" ? j.version : "";
    const nrRoot = typeof j.local_root === "string" ? j.local_root : localRoot;
    const changed = nr !== robloxProc || nl !== localReady || nf !== localFull || nrRoot !== localRoot || nv !== agentVersion;
    robloxProc = nr;
    localReady = nl;
    localFull = nf;
    agentVersion = nv;
    localRoot = nrRoot;
    // One-shot re-sync: if the agent restarted with FULL off but the user's
    // persisted toggle says ON, re-apply their choice once.
    if (!fullSyncedOnce) {
      fullSyncedOnce = true;
      try {
        chrome.storage.local.get("rs-local-full", (o) => {
          const want = o && o["rs-local-full"];
          if (typeof want === "boolean" && want !== nf) {
            fetch("http://127.0.0.1:3000/api/local-full", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: want }),
            }).then((r2) => r2.json()).then((j2) => { localFull = j2.local_full === true; broadcastStatus(); }).catch(() => {});
          }
        });
      } catch {}
    }
    if (changed) broadcastStatus();
  } catch {}
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}


// ── Web tools (web_fetch / web_search) ───────────────────────────────────
// Both ride the SERVICE WORKER's network stack, gated by TWO things:
//   1) manifest host_permissions (https://*/* already covers every https host), and
//   2) the extension's OWN CSP - content_security_policy.extension_pages.
// The old policy was `default-src 'none'` plus a connect-src that listed only
// localhost and ollama, so EVERY external fetch from here was refused with
// "Failed to fetch": web_fetch, web_search, the Roblox web APIs and the
// dev-product lookups all died the same way. manifest.json now allows `https:`
// in connect-src - if that policy is ever tightened again, these tools and the
// Roblox account/API calls die with it.
const WEB_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
// Deliberately NO custom User-Agent. Bot walls (DuckDuckGo, Cloudflare) refuse
// "OR/1.0"-style clients outright, while Chrome's native UA is exactly what a
// real navigation sends; a custom UA also gets silently dropped by some builds.
// Accept / Accept-Language are what a normal browser request carries.
function webHeaders(extra) {
  const h = { "Accept": WEB_ACCEPT, "Accept-Language": "en-US,en;q=0.9" };
  return Object.assign(h, extra || {});
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return " "; } });
}
// Anchor text -> one-line title (tags stripped: engines bold the query terms).
function cleanText(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
// Engines wrap outbound links in their own redirectors; unwrap both flavours.
function stripWrappedUrl(href) {
  let h = decodeEntities(String(href || "").trim());
  if (!h) return "";
  if (h.startsWith("//")) h = "https:" + h;
  const u = h.match(/[?&]uddg=([^&]+)/);            // DuckDuckGo: /l/?uddg=<encoded>
  if (u) { try { h = decodeURIComponent(u[1]); } catch {} }
  const b = h.match(/[?&]u=a1([A-Za-z0-9_\-]+)/);   // Bing: /ck/a?...&u=a1<base64url>
  if (b) {
    try {
      const b64 = b[1].replace(/-/g, "+").replace(/_/g, "/");
      const latin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      const utf8 = decodeURIComponent(Array.prototype.map.call(latin,
        (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
      if (/^https?:\/\//i.test(utf8)) h = utf8;
    } catch {}
  }
  return h;
}
const RESULT_HOST_NOISE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:duckduckgo|bing|mojeek)\.com\//i;
const isResultUrl = (u) => /^https?:\/\//i.test(u) && !RESULT_HOST_NOISE.test(u);
function pushHit(out, title, href, limit) {
  const url = stripWrappedUrl(href);
  if (out.length < limit && title && isResultUrl(url)) out.push({ title, url });
}
// DuckDuckGo html: <a rel="nofollow" class="result__a" href="…">Title</a>
function parseDdgHtml(html, limit) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    pushHit(out, cleanText(m[1]), (m[0].match(/href="([^"]*)"/i) || [])[1], limit);
  }
  return out;
}
// DuckDuckGo lite: <a rel="nofollow" href="…" class="result-link">Title</a>
function parseDdgLite(html, limit) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    pushHit(out, cleanText(m[1]), (m[0].match(/href="([^"]*)"/i) || [])[1], limit);
  }
  return out;
}
// Bing and Mojeek both put each organic result in an <li> whose heading holds
// the link (<li class="b_algo"><h2><a href=…>, <li><h2><a class="title" …>).
function parseHeadingAnchors(html, limit) {
  const out = [];
  const blocks = html.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  for (const b of blocks) {
    if (out.length >= limit) break;
    const a = b.match(/<h[23][^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (a) pushHit(out, cleanText(a[2]), a[1], limit);
  }
  return out;
}
// Fallback chain: DDG's endpoints 403 or serve a bot wall for some IPs/profiles,
// so try several engines and take the first that parses. A total miss reports
// every engine's failure, so the next attempt can be debugged instead of guessed.
const SEARCH_ENGINES = [
  { id: "ddg-html", url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), parse: parseDdgHtml },
  { id: "ddg-lite", url: (q) => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), parse: parseDdgLite },
  { id: "bing",     url: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=en", parse: parseHeadingAnchors },
  { id: "mojeek",   url: (q) => "https://www.mojeek.com/search?q=" + encodeURIComponent(q), parse: parseHeadingAnchors },
];
async function webSearch(query, limit) {
  const q = String(query || "").trim();
  const n = Math.max(1, Math.min(8, Number(limit) || 3));
  if (!q) return { results: [], engine: "", errors: ["query is required"] };
  const errors = [];
  for (const eng of SEARCH_ENGINES) {
    try {
      const res = await fetch(eng.url(q), { headers: webHeaders(), credentials: "omit", redirect: "follow" });
      if (!res.ok) { errors.push(eng.id + ": HTTP " + res.status); continue; }
      const html = await res.text();
      const seen = new Set();
      const results = eng.parse(html, n * 2)
        .filter((r) => (seen.has(r.url) ? false : seen.add(r.url) && true))
        .slice(0, n);
      if (results.length) return { results, engine: eng.id, errors };
      const wall = /anomaly|captcha|unusual traffic|are you a robot|enable javascript/i.test(html);
      errors.push(eng.id + ": 0 parsed" + (wall ? " (bot wall)" : ""));
    } catch (e) { errors.push(eng.id + ": " + String((e && e.message) || e)); }
  }
  return { results: [], engine: "", errors };
}
function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return s;
}


// ── Blender (one-shot TCP 9876 via AgentScript) ─────────────────────────
// Native or-agent.exe rejects add_server/uvx. Chrome cannot open raw TCP.
// Connect is a short PowerShell/Python probe of the blender-mcp addon the
// user already started. Tool calls write a JSON request, run blender_once,
// then read the JSON response. No daemon, so the agent console is not
// flooded with failed `start /B py` / shim-restart loops.
function isBlenderToolName(name) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  return BLENDER_TOOL_NAMES.has(bare) || /^blender_/.test(bare);
}
const BLENDER_KEY = "rs-blender-on";
try {
  chrome.storage?.local.get(BLENDER_KEY, (o) => {
    if (o && o[BLENDER_KEY]) blenderAddon = true;
  });
} catch {}
function setBlender(on, err) {
  const was = blenderAddon;
  blenderAddon = !!on;
  blenderError = on ? "" : (err || blenderError);
  try { chrome.storage.local.set({ [BLENDER_KEY]: !!on }); } catch {}
  if (was !== blenderAddon) broadcastStatus();
}

// ── Studio images without a Rust rebuild ────────────────────────────────
// Studio's screen_capture answers with an MCP *image* content item and next to
// no text. or-agent 1.18.0 forwards text items only, so the picture was dropped
// inside the binary and the tool read as "(tool returned an empty result)".
// studio_mcp_host.py (started by "Start OR Agent.bat") hands those bytes back
// INSIDE the text instead, wrapped in
//     <<OR_IMAGE mimeType="image/png" bytes=12345>>
//     <base64>
//     <<OR_END>>
// Decode them here so the provider attaches a real image to the next message -
// the exact result a rebuilt agent produces natively. Idempotent: a result
// without markers is returned untouched, so the two routes can coexist.
const OR_IMAGE_RE = /<<OR_IMAGE\b([^>]*)>>\s*([A-Za-z0-9+/=]+)\s*<<OR_END>>/g;
const OR_IMAGE_MIME_RE = /mimeType\s*=\s*"?([\w.+-]+\/[\w.+-]+)"?/i;
function absorbOrImages(r) {
  if (!r || typeof r.text !== "string" || r.text.indexOf("<<OR_IMAGE") === -1) return r;
  const found = [];
  const text = r.text
    .replace(OR_IMAGE_RE, (_m, attrs, data) => {
      if (data && data.length >= 64) {
        const m = OR_IMAGE_MIME_RE.exec(attrs || "");
        found.push({ mimeType: (m && m[1]) || "image/png", data: data });
      }
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!found.length) return r;
  return Object.assign({}, r, { text: text, images: (r.images || []).concat(found) });
}

async function sendLocalEngine(obj, timeout = 25000) {
  if (engine === "local" && connected && ws && ws.readyState === WebSocket.OPEN) {
    return send(obj, timeout);
  }
  return await new Promise((resolve) => {
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${PORT_LOCAL}`); }
    catch (e) { resolve({ ok: false, error: "or-agent.exe is not running" }); return; }
    const id = 800000 + Math.floor(Math.random() * 99999);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: "or-agent.exe did not answer — is it running?" }), timeout);
    sock.onerror = () => done({ ok: false, error: "or-agent.exe is not running" });
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ ...obj, id })); }
      catch (e) { done({ ok: false, error: String(e) }); }
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "connected") {
        if (typeof msg.workspace_root === "string" && msg.workspace_root) localRoot = msg.workspace_root;
        return;
      }
      if (msg.type === "tool_result" && (msg.id == null || msg.id === id)) {
        done(msg.ok ? { ok: true, text: msg.text } : { ok: false, error: msg.error || "tool failed" });
        return;
      }
      if (msg.type === "error" && (msg.id == null || msg.id === id)) {
        done({ ok: false, error: msg.error || "error" });
      }
    };
  });
}

async function extText(name) {
  const r = await fetch(chrome.runtime.getURL(name));
  if (!r.ok) throw new Error("extension file missing: " + name);
  return await r.text();
}

async function localWrite(path, content) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "write_file",
    arguments: { path, content },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not write " + path));
  return r.text || "";
}

async function localRead(path, offset) {
  const r = await sendLocalEngine({
    type: "call_tool", name: "read_file",
    arguments: { path, offset: offset || 1, limit: 4000 },
  }, 20000);
  if (!r || !r.ok) throw new Error((r && r.error) || ("could not read " + path));
  const lines = String(r.text || "").split("\n");
  const body = [];
  let more = false;
  let next = offset || 1;
  for (const ln of lines) {
    const cont = ln.match(/\.\.\. lines (\d+)/);
    if (cont) { more = true; next = Number(cont[1]); continue; }
    const m = ln.match(/^\s*\d+\s+\|\s(.*)$/);
    if (m) body.push(m[1]);
  }
  return { text: body.join("\n"), more, next, count: body.length };
}
async function localReadAll(path) {
  let offset = 1, chunks = [];
  for (let i = 0; i < 20; i++) {
    const part = await localRead(path, offset);
    if (part.text) chunks.push(part.text);
    if (!part.more || !part.count) break;
    offset = part.next || (offset + part.count);
  }
  return chunks.join("\n");
}

async function localRun(command, timeoutSeconds = 12) {
  return sendLocalEngine({
    type: "call_tool", name: "run_command",
    arguments: { command, timeout_seconds: timeoutSeconds },
  }, (timeoutSeconds + 8) * 1000);
}

function probeCommands(win) {
  if (win) {
    return [
      "powershell -NoProfile -Command try{$c=New-Object Net.Sockets.TcpClient;$c.ReceiveTimeout=2500;$c.Connect('127.0.0.1',9876);$c.Close();Write-Output BLENDER_UP}catch{Write-Output BLENDER_DOWN}",
    ];
  }
  return [
    "python3 -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "python -c \"import socket;s=socket.create_connection(('127.0.0.1',9876),2);s.close();print('BLENDER_UP')\"",
    "(echo >/dev/tcp/127.0.0.1/9876) >/dev/null 2>&1 && echo BLENDER_UP || echo BLENDER_DOWN",
  ];
}

async function probeBlenderTcp() {
  let plat = { os: "win" };
  try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
  const win = plat.os === "win";
  let last = "";
  for (const cmd of probeCommands(win)) {
    const r = await localRun(cmd, 8);
    const text = String((r && (r.text || r.error)) || "");
    last = text;
    if (/BLENDER_UP/.test(text)) return { ok: true };
    if (r && r.ok === false && /not running|not connected|timeout/i.test(text)) {
      return { ok: false, error: "or-agent.exe is not running — start it, then Connect Blender again." };
    }
  }
  const down = /BLENDER_DOWN/.test(last);
  const err = down
    ? "Blender addon is not on port 9876. In Blender: press N → MCP for Blender → Start MCP Server."
    : (last && last.slice(0, 220)) || "Could not reach Blender. Run or-agent.exe, then Start MCP Server in Blender.";
  return { ok: false, error: err };
}

async function connectBlender() {
  // 1) ZeroScript's method: host blender-mcp as an MCP server INSIDE the agent,
  //    which merges its tools and forwards its image content items.
  try {
    const reg = await blenderMcpRegister();
    if (reg.ok) {
      blenderMode = "mcp";
      setBlender(true, "");
      try {
        const ping = await blenderCall("get_scene_info", {}, 20000);
        if (ping && ping.ok === false) {
          setBlender(false, ping.error);           // server up, Blender addon not
          broadcastStatus();
          return { ok: false, blender: false, mode: "mcp", error: ping.error };
        }
      } catch {}
      broadcastStatus();
      log("Blender connected via the MCP server (agent addon)");
      return { ok: true, blender: true, mode: "mcp", tools: reg.tools };
    }
    log("blender-mcp addon unavailable (" + (reg.error || "is uvx installed?") + ") - using the direct 9876 socket");
  } catch (e) {
    log("blender-mcp addon registration failed: " + String(e && e.message || e));
  }
  // 2) Fallback: the direct socket to the Blender addon.
  const p = await probeBlenderTcp();
  if (!p.ok) {
    blenderMode = "";
    setBlender(false, p.error);
    broadcastStatus();
    return { ok: false, blender: false, error: p.error };
  }
  blenderMode = "tcp";
  setBlender(true, "");
  try {
    const ping = await blenderCall("get_scene_info", {}, 20000);
    if (ping && ping.ok === false && /not listening|closed|refused|10061|Connection refused/i.test(String(ping.error || ""))) {
      setBlender(false, ping.error);
      broadcastStatus();
      return { ok: false, blender: false, error: ping.error };
    }
  } catch {}
  broadcastStatus();
  return { ok: true, blender: true, mode: "tcp" };
}

async function agentWorkspaceRoot() {
  if (localRoot) return localRoot;
  const r = await sendLocalEngine({ type: "call_tool", name: "workspace_info", arguments: {} }, 12000);
  const t = String((r && r.text) || "");
  const m = t.match(/Workspace root:\s*(.+)/);
  if (m) { localRoot = m[1].trim(); return localRoot; }
  return "";
}

function pyLiteral(v) {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyLiteral).join(", ") + "]";
  const parts = [];
  for (const [k, val] of Object.entries(v)) parts.push(JSON.stringify(k) + ": " + pyLiteral(val));
  return "{" + parts.join(", ") + "}";
}

const BLENDER_CMD = {
  blender_export_fbx: "export_fbx", export_blender_fbx: "export_fbx",
  blender_import_fbx: "import_fbx", import_blender_fbx: "import_fbx",
  blender_export_obj: "export_obj", blender_import_obj: "import_obj",
  blender_mesh_dump: "dump", blender_send_to_studio: "dump",
  blender_group: "group", blender_ungroup: "ungroup",
  blender_parent: "parent", blender_unparent: "unparent", blender_join: "join",
  blender_move_to_collection: "move_to_collection",
  blender_list_collections: "list_collections", blender_list_objects: "list_objects",
  blender_delete: "delete", blender_duplicate: "duplicate", blender_rename: "rename",
  blender_select: "select", blender_transform: "transform",
  blender_apply_transforms: "apply_transforms", blender_set_origin: "set_origin",
  blender_shade_smooth: "shade_smooth", blender_set_material: "set_material",
  blender_add_modifier: "add_modifier", blender_boolean: "boolean",
  blender_add_cube: "add_cube", blender_add_sphere: "add_sphere",
  blender_add_cylinder: "add_cylinder", blender_add_cone: "add_cone",
  blender_add_plane: "add_plane", blender_add_torus: "add_torus",
  blender_add_monkey: "add_monkey", blender_add_empty: "add_empty",
  blender_add_camera: "add_camera", blender_add_light: "add_light",
  blender_add_ico_sphere: "add_ico_sphere", blender_add_grid: "add_grid",
  blender_add_circle: "add_circle", blender_add_text: "add_text",
  blender_clear_scene: "clear_scene",
  blender_select_all: "select_all", blender_deselect: "deselect",
  blender_invert_selection: "invert_selection", blender_select_children: "select_children",
  blender_get_selection: "get_selection",
  blender_translate: "translate", blender_rotate: "rotate_deg", blender_rotate_deg: "rotate_deg",
  blender_set_dimensions: "set_dimensions",
  blender_origin_to_bottom: "origin_to_bottom", blender_drop_to_ground: "drop_to_ground",
  blender_center: "center", blender_snap_to_grid: "snap_to_grid",
  blender_shade_flat: "shade_flat",
  blender_apply_modifiers: "apply_modifiers", blender_remove_modifier: "remove_modifier",
  blender_triangulate: "triangulate", blender_decimate: "decimate",
  blender_merge: "merge", blender_recalc_normals: "recalc_normals",
  blender_flip_normals: "flip_normals", blender_separate: "separate_loose",
  blender_subdivide: "subdivide", blender_uv_unwrap: "uv_unwrap",
  blender_array: "array", blender_mirror: "mirror",
  blender_hide: "hide", blender_unhide: "unhide", blender_unhide_all: "unhide_all",
  blender_hide_unselected: "hide_unselected",
  blender_undo: "undo", blender_redo: "redo",
  blender_frame_selected: "frame_selected", blender_stats: "stats",
  blender_save: "save_blend", blender_look_at: "look_at",
  blender_convert_to_mesh: "convert_to_mesh",
  blender_align_camera: "align_camera_axis", blender_align_camera_axis: "align_camera_axis",
  blender_view_axis: "view_axis", blender_camera_to_view: "camera_to_view",
  blender_set_camera_lens: "set_camera_lens",
  blender_scale: "scale", blender_bevel: "bevel", blender_solidify: "solidify",
  blender_extrude: "extrude", blender_add_curve: "add_curve", blender_add_armature: "add_armature",
  blender_keyframe: "keyframe_insert", blender_keyframe_insert: "keyframe_insert",
  blender_set_frame: "set_frame", blender_set_active_camera: "set_active_camera",
  blender_track_to: "track_to", blender_cursor_to_selected: "cursor_to_selected",
  blender_randomize: "randomize_transform", blender_randomize_transform: "randomize_transform",
  blender_hide_render: "hide_render", blender_subdivision: "subdivision",
  blender_subsurf: "subdivision", blender_origin_to_geometry: "origin_to_geometry",
};

async function blenderOpsCode(cmd, args) {
  let py = await extText("blender_ops.py");
  const status = "or_status.json";
  const mesh = "or_mesh.json";
  py = py.split("__OR_CMD__").join(String(cmd || ""));
  py = py.split("__OR_ARGS__").join(JSON.stringify(args || {}));
  py = py.split("__OR_OUT__").join(JSON.stringify(status || "or_status.json"));
  py = py.split("__OR_MESH__").join(JSON.stringify(mesh || "or_mesh.json"));
  return { py, status, mesh };
}

function wrapBlenderUserCode(code) {
  const src = String(code || "");
  if (!src.trim()) return src;
  if (src.indexOf("_or_items") >= 0 && src.indexOf("_or_src =") >= 0) return src;
  return [
    "import bpy, re as _or_re",
    "_or_src = " + JSON.stringify(src),
    "try:",
    "    _or_items = set(getattr(it, 'identifier', str(it)) for it in bpy.context.scene.render.bl_rna.properties['engine'].enum_items)",
    "except Exception:",
    "    _or_items = set()",
    "if 'BLENDER_EEVEE_NEXT' not in _or_items and 'BLENDER_EEVEE' in _or_items:",
    "    _or_src = _or_src.replace('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE')",
    "elif 'BLENDER_EEVEE' not in _or_items and 'BLENDER_EEVEE_NEXT' in _or_items:",
    "    _or_src = _or_re.sub(r'BLENDER_EEVEE(?!_NEXT)', 'BLENDER_EEVEE_NEXT', _or_src)",
    "if not hasattr(bpy.context.scene, 'eevee_next') and hasattr(bpy.context.scene, 'eevee'):",
    "    _or_src = _or_src.replace('.eevee_next', '.eevee')",
    "exec(compile(_or_src, '<or_blender>', 'exec'))",
  ].join("\n");
}

async function blenderPayload(name, args) {
  const bare = String(name || "").split("/").pop().split(".").pop();
  const a = args || {};
  if (bare === "get_scene_info" || bare === "blender_get_scene_info") return { type: "get_scene_info", params: {} };
  if (bare === "get_object_info" || bare === "blender_get_object_info") return { type: "get_object_info", params: { name: a.name || a.object_name || "" } };
  if (bare === "execute_blender_code" || bare === "execute_code" || bare === "blender_execute_code") return { type: "execute_code", params: { code: wrapBlenderUserCode(a.code || "") } };
  if (bare === "get_viewport_screenshot") {
    let shot = "or_blender_shot.png";
    const root = await agentWorkspaceRoot();
    if (root) shot = root.replace(/[\\/]+$/, "") + "/or_blender_shot.png";
    return { type: "get_viewport_screenshot", params: { max_size: Number(a.max_size) || 1000, filepath: shot, format: "png" } };
  }
  const mapped = BLENDER_CMD[bare];
  if (mapped) {
    const packed = await blenderOpsCode(mapped, a);
    return { type: "execute_code", params: { code: packed.py }, _orStatus: packed.status, _orMesh: packed.mesh };
  }
  const params = Object.assign({}, a);
  delete params.user_prompt;
  return { type: bare, params };
}

async function ensureBlenderScripts() {
  if (blenderScriptsReady) return;
  const py = await extText("blender_once.py");
  const ps = await extText("blender_once.ps1");
  await localWrite("blender_once.py", py);
  await localWrite("blender_once.ps1", ps);
  blenderScriptsReady = true;
}

// Older or-agent (before 1.18.1) has no read_file_base64. When "Start OR
// Agent.bat" put studio_mcp_host.py in front of Studio, THAT process can read
// the file for us: its or_host_read_image tool answers with a real image item,
// which arrives as an <<OR_IMAGE>> marker and decodes like any other capture. So
// a Blender shot still reaches the chat without a compiler.
async function readHostImage(absPath) {
  const p = String(absPath || "").trim();
  if (!p) return null;
  const listed = Array.isArray(toolsCache) &&
    toolsCache.some((t) => t && t.name === "or_host_read_image");
  if (!listed) return null;
  try {
    const r = absorbOrImages(await send(
      { type: "call_tool", name: "or_host_read_image", arguments: { path: p } }, 30000));
    if (r && r.ok && r.images && r.images.length) return r.images[0];
  } catch {}
  return null;
}

// Blender viewport captures arrive as a FILE, so read it back through the
// agent's read_file_base64 (read_file is line-numbered text and would mangle
// binary). Paths must be workspace-relative: accept either the absolute path we
// handed the addon (reduced to a relative one when it lives under the root) or a
// bare name. Returns {mimeType, data} or null.
async function readWorkspaceImage(filePath) {
  let rel = String(filePath || "").trim();
  if (!rel) return null;
  let root = "";
  try {
    root = (await agentWorkspaceRoot() || "").replace(/[\\/]+$/, "");
    if (root && rel.toLowerCase().startsWith(root.toLowerCase())) {
      rel = rel.slice(root.length).replace(/^[\\/]+/, "");
    }
  } catch {}
  const cands = [...new Set([rel, rel.split(/[\\/]/).pop()])].filter(Boolean);
  for (const cand of cands) {
    try {
      const r = await sendLocalEngine({
        type: "call_tool", name: "read_file_base64", arguments: { path: cand },
      }, 30000);
      if (!r || !r.ok || !r.text) continue;
      const j = JSON.parse(r.text);
      if (!j || !j.data) continue;
      // The PNG was only a hand-off file: drop it once its bytes are in hand so
      // the workspace doesn't accumulate screenshots (a failed read keeps it for
      // debugging). Best-effort - the capture is already safe.
      try { await sendLocalEngine({ type: "call_tool", name: "delete_path", arguments: { path: cand } }, 15000); } catch {}
      return { mimeType: j.mimeType || "image/png", data: String(j.data) };
    } catch {}
  }
  // read_file_base64 is a 1.18.1 tool: on an older exe every attempt above came
  // back "unknown tool". Ask the Python host instead - it runs on the same PC
  // and hands the bytes back as an image.
  const hostTries = [...new Set([String(filePath || "").trim(), rel,
    ...cands.map((c) => (root ? root + "\\" + c : c))])].filter(Boolean);
  for (const t of hostTries) {
    const img = await readHostImage(t);
    if (img) return img;
  }
  return null;
}

let blenderCallLock = Promise.resolve();
async function blenderCall(name, args, timeout) {
  if (!blenderAddon) {
    return { ok: false, error: "Blender is not connected. Click Connect Blender (Blender: N → MCP for Blender → Start MCP Server)." };
  }
  const run = async () => {
    // MCP transport: when the agent hosts blender-mcp, its OWN tools go through
    // it and come back with image content items (that is the capture path).
    // OR's convenience ops (blender_* built on blender_ops.py) keep the direct
    // path, so nothing that worked before stops working.
    const bareM = String(name || "").split("/").pop().split(".").pop();
    if (blenderMode === "mcp" && BLENDER_MCP_TOOLS.has(bareM)) {
      const r = await send({ type: "call_tool", name: bareM, arguments: args || {}, timeout: timeout || 120000 }, (timeout || 120000) + 10000);
      if (r && r.ok) return { ok: true, text: String(r.text || ""), images: r.images || [] };
      if (r && r.kind !== "disconnected") return { ok: false, error: String((r && r.error) || "blender MCP call failed") };
      // Bridge down: fall through to the direct socket rather than dead-ending.
    }
    await ensureBlenderScripts();
    const payload = await blenderPayload(name, args);
    const statusPath = payload._orStatus || "";
    const meshPath = payload._orMesh || "";
    const wire = { type: payload.type, params: payload.params };
    await localWrite("or_blender_in.json", JSON.stringify(wire));
    let plat = { os: "win" };
    try { plat = await chrome.runtime.getPlatformInfo(); } catch {}
    const win = plat.os === "win";
    const secs = Math.max(20, Math.min(180, Math.round((timeout || 120000) / 1000)));
    const cmds = win ? [
      "powershell -NoProfile -ExecutionPolicy Bypass -File blender_once.ps1 or_blender_in.json or_blender_out.json",
      "py -3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ] : [
      "python3 blender_once.py or_blender_in.json or_blender_out.json",
      "python blender_once.py or_blender_in.json or_blender_out.json",
    ];
    let last = "";
    let okRun = false;
    for (const cmd of cmds) {
      const r = await localRun(cmd, secs);
      last = String((r && (r.text || r.error)) || "");
      if (/OR_BLENDER_OK/.test(last)) { okRun = true; break; }
      // Blender refused / socket error — do not try py/python after PowerShell already ran.
      if (/OR_BLENDER_ERR/.test(last)) break;
      // Missing interpreter only: try the next runner. Anything else is a real error.
      if (!/not recognized|cannot find|No such file|not found|is not recognized/i.test(last)) break;
    }
    let raw = "";
    try { raw = (await localReadAll("or_blender_out.json")).replace(/^\uFEFF/, "").trim(); } catch (e) {
      if (!okRun) return { ok: false, error: last.slice(0, 400) || String(e.message || e) };
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      return { ok: false, error: raw ? raw.slice(0, 400) : (last.slice(0, 400) || "empty Blender response") };
    }
    if (data && data.status === "error") {
      const msg = data.message || "Blender addon error";
      if (/not listening|closed|actively refused|10061|Connection refused/i.test(msg)) {
        setBlender(false, "Blender addon dropped. Start MCP Server in Blender, then Connect Blender again.");
      }
      return { ok: false, error: msg };
    }
    let result = (data && Object.prototype.hasOwnProperty.call(data, "result")) ? data.result : data;
    // Studio's screen_capture returns the picture INLINE in the MCP result, but
    // the blender-mcp addon answers get_viewport_screenshot by WRITING a PNG to
    // the path we passed (see blenderPayload) and reporting only the filepath -
    // so this is where the Blender half of the capture feature is completed:
    // pull those bytes back as base64 and hand them over in the same
    // {mimeType, data} shape the providers already upload. Snapshot the path
    // BEFORE the status/mesh reading below can replace `result`.
    let shotFile = "";
    try {
      const cand = result && (result.filepath || result.path || result.file);
      if (typeof cand === "string" && /\.(png|jpe?g|webp)$/i.test(cand)) shotFile = cand;
    } catch {}
    const rawText = typeof result === "string" ? result : JSON.stringify(result);
    const marker = String(rawText).indexOf("OR_MESH_JSON:");
    if (marker >= 0) {
      try { result = JSON.parse(String(rawText).slice(marker + 13)); } catch {}
    }
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender FBX failed" };
    }
    if (statusPath) {
      try {
        const st = (await localReadAll(statusPath)).replace(/^\uFEFF/, "").trim();
        if (st) {
          try { result = JSON.parse(st); } catch {}
        }
      } catch {}
    }
    if (result && result.ok === false) {
      return { ok: false, error: result.error || "Blender command failed" };
    }
    let meshes = result && result.meshes;
    const mf = (result && result.mesh_file) || meshPath || "or_mesh.json";
    if ((!meshes || !meshes.length) && mf) {
      for (const cand of [mf, "or_mesh.json"]) {
        try {
          const rawM = (await localReadAll(cand)).replace(/^\uFEFF/, "").trim();
          if (!rawM) continue;
          const parsed = JSON.parse(rawM);
          meshes = parsed.meshes || (parsed.result && parsed.result.meshes);
          if (meshes && meshes.length) break;
        } catch {}
      }
    }
    if (meshes && meshes.length && result && typeof result === "object") result.meshes = meshes;
    let textOut = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const images = [];
    if (shotFile) {
      const img = await readWorkspaceImage(shotFile);
      if (img) images.push(img);
    }
    return { ok: true, text: textOut, images, meshFile: mf, filepath: result && result.filepath, meshes: meshes || undefined };
  };
  const prev = blenderCallLock;
  let release;
  blenderCallLock = new Promise((res) => { release = res; });
  await prev.catch(() => {});
  try { return await run(); }
  finally { release(); }
}

async function robloxCsrf() {
  try {
    const r = await fetch("https://auth.roblox.com/v2/logout", { method: "POST", credentials: "include" });
    return r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
  } catch {
    return "";
  }
}
async function robloxAuthedFetch(url, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const headers = Object.assign({}, method !== "GET" ? { "Content-Type": "application/json" } : {}, opts.headers || {});
  const go = async (token) => {
    const h = Object.assign({}, headers);
    if (token) h["X-CSRF-TOKEN"] = token;
    const r = await fetch(url, { method, credentials: "include", headers: h, body: opts.body });
    const text = await r.text();
    const csrf = r.headers.get("x-csrf-token") || r.headers.get("X-CSRF-TOKEN") || "";
    return { r, text, csrf };
  };
  let token = await robloxCsrf();
  let res = await go(token);
  if ((res.r.status === 403 || res.r.status === 401) && res.csrf && res.csrf !== token) {
    res = await go(res.csrf);
  }
  let data = null;
  try { data = JSON.parse(res.text); } catch {}
  return { ok: res.r.ok, status: res.r.status, text: res.text, data };
}
async function robloxResolveUniverse(msg) {
  let universeId = Number(msg.universeId || msg.universe_id || msg.gameId || 0) || 0;
  const placeId = Number(msg.placeId || msg.place_id || 0) || 0;
  if (universeId > 0) return { ok: true, universeId, placeId };
  if (placeId > 0) {
    const res = await robloxAuthedFetch("https://apis.roblox.com/universes/v1/places/" + placeId + "/universe", { method: "GET" });
    const id = Number(res.data && (res.data.universeId || res.data.id) || 0) || 0;
    if (id > 0) return { ok: true, universeId: id, placeId };
  }
  const listed = await robloxAuthedFetch("https://develop.roblox.com/v1/user/universes?limit=50&sortOrder=Desc", { method: "GET" });
  const rows = (listed.data && listed.data.data) || [];
  if (placeId > 0) {
    const hit = rows.find((u) => Number(u.rootPlaceId) === placeId || Number(u.id) === placeId);
    if (hit) return { ok: true, universeId: Number(hit.id), placeId, name: hit.name };
  }
  if (rows.length === 1) return { ok: true, universeId: Number(rows[0].id), placeId: Number(rows[0].rootPlaceId) || placeId, name: rows[0].name };
  if (rows.length > 1) {
    const top = rows[0];
    return {
      ok: true,
      universeId: Number(top.id),
      placeId: Number(top.rootPlaceId) || placeId,
      name: top.name,
      candidates: rows.slice(0, 8).map((u) => ({ id: u.id, name: u.name, rootPlaceId: u.rootPlaceId })),
    };
  }
  const who = await robloxAuthedFetch("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
  if (!who.ok) return { ok: false, error: "Could not reach the game. Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry." };
  return { ok: false, error: "Could not reach a universe for this place (GameId/PlaceId empty). Publish the place (File > Publish to Roblox) so it has a Universe ID." };
}
async function robloxCreateDevProduct(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const name = String(msg.name || "").trim();
  const description = String(msg.description || name).trim();
  const priceInRobux = Math.floor(Number(msg.priceInRobux || msg.price || 0));
  if (!name) return { ok: false, error: "name required" };
  if (!priceInRobux || priceInRobux < 1) return { ok: false, error: "priceInRobux must be >= 1" };
  const qUrl = "https://apis.roblox.com/developer-products/v1/universes/" + universeId +
    "/developerproducts?name=" + encodeURIComponent(name) +
    "&description=" + encodeURIComponent(description) +
    "&priceInRobux=" + encodeURIComponent(String(priceInRobux));
  let res = await robloxAuthedFetch(qUrl, { method: "POST" });
  if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 415)) {
    res = await robloxAuthedFetch("https://apis.roblox.com/developer-products/v1/universes/" + universeId + "/developerproducts", {
      method: "POST",
      body: JSON.stringify({ name: name, description: description, priceInRobux: priceInRobux }),
    });
  }
  if (!res.ok) {
    let err = res.text.slice(0, 280) || ("HTTP " + res.status);
    try {
      const d = res.data;
      if (d) err = d.message || d.error || (d.errors && d.errors[0] && d.errors[0].message) || err;
    } catch {}
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Not signed into Roblox in this Chrome profile. Open roblox.com, log in, then retry. (" + err + ")" };
    }
    return { ok: false, error: String(err) + " (universe " + universeId + (resolved.name ? " / " + resolved.name : "") + ")", status: res.status, universeId: universeId };
  }
  const product = res.data || {};
  return { ok: true, product: product, productId: product.id || product.productId, universeId: universeId, universeName: resolved.name || "", text: JSON.stringify(product) };
}
async function robloxListDevProducts(msg) {
  const resolved = await robloxResolveUniverse(msg);
  if (!resolved.ok) return resolved;
  const universeId = resolved.universeId;
  const url = "https://apis.roblox.com/developer-products/v1/universes/" + universeId + "/developerproducts?pageNumber=1&pageSize=50";
  const res = await robloxAuthedFetch(url, { method: "GET" });
  if (!res.ok) {
    const err = (res.data && (res.data.message || res.data.error)) || res.text.slice(0, 280) || ("HTTP " + res.status);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Not signed into Roblox in this Chrome profile. Open roblox.com, log in, then retry. (" + err + ")" };
    }
    return { ok: false, error: String(err), status: res.status };
  }
  return { ok: true, products: res.data, text: typeof res.text === "string" ? res.text.slice(0, 4000) : JSON.stringify(res.data) };
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "rs-get-engine":
        sendResponse({ engine });
        break;
      case "rs-set-engine":
        engine = normalizeEngine(msg.engine);
        try { await chrome.storage.local.set({ [ENGINE_KEY]: engine }); } catch {}
        // fully isolate — wipe previous engine's cache so hallucination impossible
        try { ws?.close(); } catch {}
        connected = false;
        mcpAlive = false;
        toolsCache = [];
        serversCache = [];
        studioConnected = null;
        studioApp = null;
        studioProc = null;
        robloxEditorConnected = false;
        failAllPending(`engine switched to ${engine}`);
        reconnectDelay = RECONNECT_MIN;
        connect();
        broadcastStatus();
          // also push to all provider tabs so their bars / prompts flip instantly.
          // tabs.sendMessage returns a Promise in MV3 — orphaned content scripts
          // (tab not refreshed after reload) reject with "Receiving end does not
          // exist"; that's expected and harmless here, so swallow it.
          try {
            const tabs = await chrome.tabs.query({ url: PROVIDER_URLS });
            for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "rs-engine", engine }).catch(() => {});
          } catch {}
        sendResponse({ engine });
        break;
      case "rs-set-full": {
        // FULL PC ACCESS toggle for the AgentScript engine. The agent process
        // is the source of truth; mirror its answer into the status broadcast.
        const want = !!msg.enabled;
        try {
          const r = await fetch("http://127.0.0.1:3000/api/local-full", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: want }),
          });
          const j = await r.json().catch(() => ({}));
          localFull = j.local_full === true ? true : j.local_full === false ? false : want;
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        } catch {
          localFull = want; // agent unreachable — optimistic, corrected on next poll
          try { chrome.storage.local.set({ "rs-local-full": localFull }); } catch {}
        }
        broadcastStatus();
        sendResponse({ ok: true, enabled: localFull });
        break;
      }
      case "rs-get-full":
        sendResponse({ enabled: localFull });
        break;
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok && Array.isArray(r.tools)) toolsCache = r.tools;
        const tools = mergeBlenderTools(r.ok ? toolsCache : toolsCache);
        const ok = r.ok || tools.length > 0;
        sendResponse({ ok, tools, error: r.ok ? undefined : r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        if (blenderAddon && isBlenderToolName(msg.name)) {
          sendResponse(absorbOrImages(await blenderCall(msg.name, msg.arguments, timeout)));
          break;
        }
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout
        );
        // Every Studio/Skills/AgentScript tool call returns here, so the
        // Python host's <<OR_IMAGE>> markers become r.images once, for all.
        sendResponse(absorbOrImages(r));
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        if (r && r.ok) {
          const tools = await send({ type: "list_tools" }, 10000);
          if (tools && tools.ok && Array.isArray(tools.tools)) toolsCache = tools.tools;
          mcpAlive = true;
        }
        sendResponse(r);
        break;
      }
      case "local_read": {
        try {
          const text = await localReadAll(String(msg.path || ""));
          sendResponse({ ok: true, text });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "blender_connect": {
        sendResponse(await connectBlender());
        break;
      }
      case "blender_status": {
        sendResponse({ ok: blenderAddon, blender: blenderAddon, mode: blenderMode || undefined, error: blenderError || undefined });
        break;
      }
      case "blender_disconnect": {
        // Also drop the addon from the agent's config, so a later start doesn't
        // silently re-spawn it.
        if (blenderMode === "mcp") {
          try { await send({ type: "remove_server", server_id: "blender" }, 15000); } catch {}
        }
        blenderMode = "";
        setBlender(false, "");
        broadcastStatus();
        sendResponse({ ok: true, blender: false });
        break;
      }
      case "add_server": {
        // Native or-agent.exe rejects custom MCP. Blender uses blender_connect.
        if (String(msg.server_id || "").toLowerCase() === "blender") {
          sendResponse(await connectBlender());
          break;
        }
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      // ── ZeroScript Rust pipe — CORS bypass via background (content script → background → 127.0.0.1) ──
      case "rs-push":
      case "push_payload": {
        // Content script payload from AI chat (Gemini/ChatGPT/Claude) → local bridge
        // Must go through background to bypass chat site CORS on http://127.0.0.1
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(msg.payload || msg),
          });
          const j = await res.json().catch(() => ({}));
          sendResponse({ ok: res.ok, ...j });
        } catch (e) {
          // Fallback to legacy WS if Rust HTTP not reachable
          const r = await send({ type: "call_tool", name: msg.name || "push_payload", arguments: msg.arguments || msg.payload || {} }, 10000);
          sendResponse(r);
        }
        break;
      }
      case "rs-poll": {
        try {
          const target = RUST_ROBLOX_HTTP;
          const res = await fetch(`${target}/api/poll?client_id=${encodeURIComponent(msg.client_id || engine)}`);
          const j = await res.json().catch(() => ({}));
          sendResponse(j);
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        break;
      }
      case "web_fetch": {
        try {
          let url = String(msg.url || "").trim();
          const query = String(msg.query || "").trim();
          if (!url) {
            const q = String(msg.q || query).trim();
            if (/^https?:\/\//i.test(q)) url = q;
          }
          let searchNote = "", engineId = "";
          if (!url) {
            const q = query || String(msg.q || "").trim();
            if (!q) { sendResponse({ ok: false, error: "url or query is required" }); break; }
            const found = await webSearch(q, 3);
            if (!found.results.length) {
              sendResponse({ ok: false, error: `no search results for "${q}" (${found.errors.join("; ") || "all engines empty"})` });
              break;
            }
            engineId = found.engine;
            url = found.results[0].url;
            searchNote = `Searched "${q}" (${found.engine}). Top result: ${url}\n` +
              found.results.map((h, i) => `${i + 1}. ${h.title} — ${h.url}`).join("\n") + "\n\n";
          }
          if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: "url must start with https://" }); break; }
          // connect-src is https-only, so a plain-http target is upgraded: almost
          // every site serves https, and a silent "Failed to fetch" for an http://
          // URL would just look like the bug this code was fixed for.
          let upgraded = false;
          if (/^http:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(url)) {
            url = url.replace(/^http:\/\//i, "https://");
            upgraded = true;
          }
          const maxChars = Math.max(500, Math.min(50000, Number(msg.max_chars) || 12000));
          let res;
          try {
            res = await fetch(url, { headers: webHeaders(), credentials: "omit", redirect: "follow" });
          } catch (e) {
            const hint = upgraded ? " (the extension can only reach https:// hosts — the original URL was http://)" : "";
            sendResponse({ ok: false, error: `could not reach ${url}: ${String((e && e.message) || e)}${hint}` });
            break;
          }
          if (!res.ok) { sendResponse({ ok: false, error: `fetch failed HTTP ${res.status}${res.statusText ? " " + res.statusText : ""} (${url})` }); break; }
          let text = await res.text();
          const ctype = (res.headers.get("content-type") || "").toLowerCase();
          const looksHtml = /html|xml/.test(ctype) || /^\s*</.test(text);
          if (looksHtml) text = htmlToText(text);
          const origLen = text.length;
          const truncated = origLen > maxChars;
          if (truncated) text = text.slice(0, maxChars) + `\n\n…[truncated ${origLen - maxChars} chars]`;
          const out = { ok: true, text: searchNote + text, truncated, status: res.status, url, content_type: ctype };
          if (engineId) out.engine = engineId;
          sendResponse(out);
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "web_search": {
        try {
          const q = String(msg.query || msg.q || "").trim();
          if (!q) { sendResponse({ ok: false, error: "query is required" }); break; }
          const limit = Math.max(1, Math.min(8, Number(msg.limit) || 3));
          const found = await webSearch(q, limit);
          if (!found.results.length) {
            sendResponse({ ok: false, error: `no results for '${q}' (${found.errors.join("; ") || "all engines empty"})` });
            break;
          }
          const txt = found.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
          sendResponse({ ok: true, text: txt, results: found.results, query: q, engine: found.engine });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "ollama_list_models": {
        try {
          const res = await fetch("http://127.0.0.1:11434/api/tags");
          if (!res.ok) { sendResponse({ ok: false, error: `Ollama not running (HTTP ${res.status}) — run 'ollama serve'` }); break; }
          const j = await res.json();
          sendResponse({ ok: true, models: j.models || [] });
        } catch (e) { sendResponse({ ok: false, error: `Ollama not reachable at 127.0.0.1:11434 — is 'ollama serve' running? ${String(e&&e.message||e)}` }); }
        break;
      }
      // One-click start: ask whichever bridge is connected to spawn `ollama serve`.
      case "ollama_ensure": {
        const ask = (type) => send({ type, timeoutMs: 12000 });
        let r = await ask("start_ollama");
        if (!r || r.error === "bridge not connected") {
          // Engine bridge down? try the other port by flipping engine briefly is
          // too invasive; instead just report so popup can hint to run robloxscript-agent.exe.
          sendResponse({ ok: false, up: false, error: "bridge offline - run or-agent.exe first" });
          break;
        }
        sendResponse(r);
        break;
      }
      case "ollama_status": {
        const r = await send({ type: "ollama_status" }, 8000);
        if (!r || r.error === "bridge not connected") {
          sendResponse({ ok: false, up: false, error: "bridge offline" });
          break;
        }
        sendResponse(r);
        break;
      }
      case "ollama_chat": {
        try {
          let model = msg.model ? String(msg.model) : "";
          const messages = Array.isArray(msg.messages) ? msg.messages : [{role:"user", content:String(msg.prompt||"")}];
          // Validate the model against what is ACTUALLY installed before calling
          // /api/chat - a stale name (model deleted after being picked, or the
          // hardcoded default no longer pulled) otherwise surfaces as a raw 404
          // body. Return a structured error the page can react to (auto-recover).
          let available = [];
          try {
            const tr = await fetch("http://127.0.0.1:11434/api/tags");
            if (tr.ok) { const tj = await tr.json(); available = (tj.models || []).map(m => m.name); }
          } catch {}
          if (!available.length) {
            sendResponse({ ok:false, errKind:"no_server", error:"ERR: OLLAMA NOT RUNNING - nothing answered on 127.0.0.1:11434." });
            break;
          }
          if (!model || !available.includes(model)) {
            if (model) {
              sendResponse({
                ok: false, errKind: "model_not_found", available,
                error: `ERR: MODEL NOT FOUND - "${model}" is not installed anymore.`
              });
              break;
            }
            // No model given: fall back to a coder model if present, else first.
            const pref = available.find(n => /coder|code/i.test(n));
            model = pref || available[0];
          }
          const res = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ model, messages, stream: false })
          });
          if (!res.ok) {
            const t = await res.text().catch(()=> "");
            sendResponse({ ok: false, errKind:"http_"+res.status, model,
              error: `Ollama chat HTTP ${res.status}: ${t.slice(0,400)}` });
            break;
          }
          const j = await res.json();
          const text = (j.message && j.message.content) || j.response || "";
          sendResponse({ ok: true, text, model, raw: j });
        } catch (e) { sendResponse({ ok: false, error: `Ollama chat failed: ${String(e&&e.message||e)} - try OLLAMA_ORIGINS=* ollama serve` }); }
        break;
      }
      case "resolve_universe": {
        try { sendResponse(await robloxResolveUniverse(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "create_dev_product": {
        try { sendResponse(await robloxCreateDevProduct(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      case "list_dev_products": {
        try { sendResponse(await robloxListDevProducts(msg)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Proc poll — keeps RS availability gated on the live Studio process
refreshProcStatus();
setInterval(refreshProcStatus, 5000);

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();

// Test hook: the pure web-tool helpers are unit-tested by test-web-tools.js in
// a plain Node vm (no chrome). Inert in the service worker (no `module`).
try {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { webSearch, webHeaders, stripWrappedUrl, cleanText, decodeEntities,
      htmlToText, parseDdgHtml, parseDdgLite, parseHeadingAnchors, SEARCH_ENGINES };
  }
} catch {}
