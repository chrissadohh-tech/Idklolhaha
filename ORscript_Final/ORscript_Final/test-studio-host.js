// test-studio-host.js — the no-compiler Studio MCP host (ZeroScript's trick).
//
// or-agent.exe 1.18.0 drops the image content item Studio's screen_capture
// sends, so captures read as "empty result". studio_mcp_host.py proxies Studio's
// own StudioMCP.exe (newest version, so a Studio update cannot break it) and
// rewrites every image item into a <<OR_IMAGE>> text item the extension decodes
// back into an image. These checks cover all three links of that chain:
//   the host script, the launcher, and the extension-side decoder - plus a real
//   round-trip through the host against a fake Studio (skipped if no Python).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

let fails = 0, passes = 0;
const ok = (name, cond) => {
  if (cond) { passes++; console.log("PASS ", name); }
  else { fails++; console.log("FAIL ", name); }
};

const HOST = fs.readFileSync("studio_mcp_host.py", "utf8");
const BAT = fs.readFileSync("Start OR Agent.bat", "utf8");
const bg = fs.readFileSync("background.js", "utf8");
const mainJS = fs.readFileSync(path.join("core", "main.js"), "utf8");

// ── the Python host ─────────────────────────────────────────────────────────
ok("host is Python and stdlib-only (no build step, like ZeroScript)",
  HOST.includes("import json") && HOST.includes("import subprocess") &&
  !/import (requests|numpy|websockets)/.test(HOST));
ok("host finds the newest StudioMCP.exe instead of trusting mcp.bat",
  HOST.includes("def find_studio_mcp(") &&
  HOST.includes('"StudioMCP.exe"') && HOST.includes("RobloxStudioBeta.exe") &&
  HOST.includes("OR_STUDIO_MCP_PATH") && HOST.includes("mcp.bat fallback") &&
  HOST.includes("os.path.getmtime"));
ok("host prefers a live Studio folder over an update's zombie folder",
  HOST.includes("0 if paired else 1") && HOST.includes("-stamp"));
ok("host can host a .bat/.cmd launcher and a .py stub too",
  HOST.includes("def child_command(") && HOST.includes('.bat", ".cmd'));
ok("image items become <<OR_IMAGE>> text the extension can decode",
  HOST.includes('MARK = "<<OR_IMAGE"') && HOST.includes('END = "<<OR_END>>"') &&
  HOST.includes("def rewrite_images(") &&
  HOST.includes('"type": "text"') && HOST.includes("bytes=%d>>"));
ok("everything else is forwarded verbatim (all other Studio tools unchanged)",
  HOST.includes("def emit_raw(") && HOST.includes("emit_raw(line)") &&
  HOST.includes("reply, converted = rewrite_images(reply)"));
ok("a dead StudioMCP is respawned, and failures become real MCP errors",
  HOST.includes("def ensure(") && HOST.includes("StudioMCP is gone - restarting it") &&
  HOST.includes("def error_reply("));
ok("payloads are never written to the log",
  !/log\(.*data/.test(HOST) && HOST.includes("Diagnostics go to a file"));
ok("Windows: the child is spawned without a console window",
  HOST.includes("CREATE_NO_WINDOW") && HOST.includes("STARTF_USESHOWWINDOW"));
ok("host ships its own self-test (start -> tools -> capture -> marker)",
  HOST.includes("def selftest(") && HOST.includes("SELFTEST PASS") &&
  HOST.includes("--selftest") && HOST.includes("--check"));
ok("host also offers the missing read_file_base64 (Blender read-back)",
  HOST.includes('"name": "or_host_read_image"') && HOST.includes("def host_read_image(") &&
  HOST.includes("HOST_TOOL_NAMES") && HOST.includes("host_result_error") &&
  HOST.includes("IMAGE_MIMES") && HOST.includes("HOST_IMAGE_MAX"));
ok("host tools are merged into tools/list and answered locally",
  HOST.includes('if method == "tools/list"') && HOST.includes("extra = [t for t in HOST_TOOLS") &&
  HOST.includes('params.get("name") in HOST_TOOL_NAMES'));
ok("its own results go through the same image rewrite",
  HOST.includes("host_reply, converted = rewrite_images("));
ok("a non-image is refused, never inlined", HOST.includes("refusing to inline it"));
ok("leftover StudioMCP.exe is cleaned (ZeroScript's 'empty captures' fix)",
  HOST.includes("STUDIO_MCP_PORT = 13469") && HOST.includes("def clean_leftovers(") &&
  HOST.includes("def port_owner_pid(") && HOST.includes("def _pid_is_studio_mcp(") &&
  HOST.includes("def studio_app_running(") &&
  HOST.includes('taskkill", "/F", "/IM", "StudioMCP.exe"') &&
  HOST.includes("self.last_killed = clean_leftovers(self._pid)"));
ok("a capture failure says WHICH fix applies (version + tool count, not a guess)",
  mainJS.includes("function captureFailureHint(") &&
  mainJS.includes("if (!agentVersionBelow(v, AGENT_CAPTURE_MIN))") &&
  mainJS.includes("Studio itself produced no picture") &&
  mainJS.includes("A.toolNames.has(\"or_host_read_image\")") &&
  mainJS.includes("would add a 28th tool") &&
  mainJS.includes("Start OR Agent.bat"));
ok("a CURRENT agent never gets blamed on the host (wrong-diagnosis guard)",
  mainJS.indexOf("if (!agentVersionBelow(v, AGENT_CAPTURE_MIN))") <
  mainJS.indexOf("A.toolNames.has(\"or_host_read_image\")"));

// ── the launcher ────────────────────────────────────────────────────────────
ok("launcher only ever lets ONE agent own the bridge port (env var applies)",
  BAT.includes("taskkill /F /IM or-agent.exe") &&
  BAT.includes("it owns port 3000") &&
  BAT.includes("find /i \"or-agent.exe\""));
ok("launcher finds Python the way ZeroScript's start.bat does",
  BAT.includes("for %%C in (\"py -3\" \"python\")") &&
  BAT.includes(":validate_py") && BAT.includes("dir /b /ad /o-n") &&
  BAT.includes("%LOCALAPPDATA%\\Programs\\Python") &&
  BAT.includes("--version"));
ok("launcher points the agent at the host through a cmd wrapper",
  BAT.includes("set \"OR_MCP_COMMAND=cmd /C or_mcp_host.bat\"") &&
  BAT.includes('echo %PY% "%%~dp0%HOST%" %%*'));
ok("launcher stores the setting for every future start (permanent, not per-run)",
  BAT.includes("setx OR_MCP_COMMAND") && BAT.includes("%%~sI") &&
  BAT.includes("Stored permanently"));
ok("a Python path with spaces is handled by the wrapper, spaces-or-not",
  BAT.includes("or_mcp_host.bat") && BAT.includes("8.3 names are off"));
ok("launcher verifies before and after: --check, then waits for port 3000",
  BAT.includes("%HOST% --check") && BAT.includes("netstat -ano -p TCP") &&
  BAT.includes(":3000"));
ok("launcher proves the host actually started (log growth, not a guess)",
  BAT.includes("studio_mcp_host.log") && BAT.includes("LOGSIZE") &&
  BAT.includes("the host did NOT start") && BAT.includes("grew"));
ok("launcher NEVER closes itself - the window keeps every line on screen",
  BAT.includes("pause >nul") && BAT.includes("or_agent_start.log") &&
  !/^timeout \/t 8/m.test(BAT) === false || !BAT.includes("timeout /t 8 /nobreak >nul\r\nexit /b 0"));
ok("launcher is readable when it fails (pause) and points at the log",
  BAT.includes("Add python.exe to PATH") && BAT.includes("Press any key"));
ok("launcher still starts or-agent.exe, from its own folder",
  BAT.includes("cd /d \"%~dp0\"") && BAT.includes("start \"\" \"%CD%\\or-agent.exe\""));
ok("launcher tells the user what TOOLS should read afterwards",
  BAT.includes("TOOLS must read 28"));

// ── the extension-side decoder ──────────────────────────────────────────────
ok("background decodes the markers once, for every tool funnel",
  bg.includes("const OR_IMAGE_RE =") && bg.includes("function absorbOrImages(r)") &&
  bg.includes("sendResponse(await shrinkImages(absorbOrImages(r)))") &&
  bg.includes("absorbOrImages(await blenderCall("));
ok("the capture error now points at the bat, not only at a rebuild",
  mainJS.includes("Start OR Agent.bat") && mainJS.includes("studio_mcp_host.py") &&
  mainJS.includes("cargo build --release"));
ok("Blender read-back falls back to the host when the agent has no read_file_base64",
  bg.includes("async function readHostImage") && bg.includes("const hostTries =") &&
  bg.includes("if (!listed) return null;") && bg.includes('let root = "";') &&
  bg.includes('name: "or_host_read_image"'));

// ── behaviour: run the shipped decoder on real marker text ──────────────────
const sliceObj = (src, sig) => {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
};
const code =
  sliceObj(bg, "const OR_IMAGE_RE =").split("\nconst OR_IMAGE_MIME_RE")[0] + "\n" +
  "const OR_IMAGE_MIME_RE = " + sliceObj(bg, "const OR_IMAGE_MIME_RE =").replace("const OR_IMAGE_MIME_RE = ", "") + "\n" +
  sliceObj(bg, "function absorbOrImages(r)") + "\n" +
  sliceObj(bg, "function b64ToBytes(b64)") + "\n" +
  sliceObj(bg, "function bytesToB64(bytes)") + "\n" +
  "exports = { absorbOrImages, b64ToBytes, bytesToB64 };";
// atob/btoa are browser globals; the vm context needs them passed in.
const ctx = { exports: {}, atob: globalThis.atob, btoa: globalThis.btoa };
try {
  vm.runInNewContext(code, ctx);
} catch (e) {
  console.log("FAIL  decoder extraction (" + e.message + ")");
  fails++;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842BAAAAAElFTkSuQmCC";
if (ctx.exports && ctx.exports.absorbOrImages) {
  const absorb = ctx.exports.absorbOrImages;

  const captured = absorb({
    ok: true,
    text: '<<OR_IMAGE mimeType="image/png" bytes=' + PNG.length + '>>\n' + PNG + '\n<<OR_END>>',
  });
  ok("a marker-only capture becomes a real image (and stops being 'empty')",
    captured.images && captured.images.length === 1 &&
    captured.images[0].data === PNG && captured.images[0].mimeType === "image/png" &&
    captured.text === "");

  const withText = absorb({
    ok: true,
    text: 'Captured the viewport.\n<<OR_IMAGE mimeType="image/jpeg" bytes=100>>\n' + PNG + '\n<<OR_END>>\n',
  });
  ok("surrounding text survives, the base64 never reaches the model",
    withText.text === "Captured the viewport." && !withText.text.includes("iVBOR") &&
    withText.images[0].mimeType === "image/jpeg");

  const two = absorb({
    ok: true,
    text: '<<OR_IMAGE mimeType="image/png">>\n' + PNG + '\n<<OR_END>>\n' +
          '<<OR_IMAGE mimeType="image/png">>\n' + PNG + '\n<<OR_END>>',
  });
  ok("several captures in one result all come through", two.images.length === 2);

  const native = { ok: true, text: "hello", images: [{ mimeType: "image/png", data: PNG }] };
  ok("a rebuilt agent's native images are untouched",
    absorb(native) === native);
  const plain = { ok: true, text: "just text" };
  ok("plain text results pass through untouched", absorb(plain) === plain);
  ok("a malformed marker is ignored, never half-attached",
    absorb({ ok: true, text: "<<OR_IMAGE mimeType=\"image/png\">>\nshort\n<<OR_END>>" }).images === undefined);
}

// ── speed: the capture payload is what costs the wait ───────────────────────
ok("oversized captures are resized before upload (the upload is the wait)",
  bg.includes("async function shrinkImages(r)") &&
  bg.includes("new OffscreenCanvas(w, h)") &&
  bg.includes("convertToBlob({ type: \"image/jpeg\", quality: shotQuality })") &&
  bg.includes("const scale = Math.min(1, shotMax / Math.max(bmp.width, bmp.height))"));
ok("it is applied on BOTH capture routes, in the one funnel",
  bg.includes("await shrinkImages(absorbOrImages(await blenderCall(") &&
  bg.includes("sendResponse(await shrinkImages(absorbOrImages(r)))"));
ok("small captures keep their exact original bytes",
  bg.includes("const SHRINK_KEEP_BYTES = 350 * 1024") &&
  bg.includes("if (bytes.length <= SHRINK_KEEP_BYTES)"));
ok("a resize that would not help is discarded (PNG kept)",
  bg.includes("if (buf.length >= bytes.length)") && bg.includes("keep the PNG"));
ok("a resize failure can never lose a capture",
  bg.includes("A speed tweak must never cost a capture") &&
  bg.includes("if (typeof createImageBitmap !== \"function\""));
ok("it can be tuned or switched off from storage",
  bg.includes('["rs-shot-max", "rs-shot-quality"]') && bg.includes("let shotMax = 1400") &&
  bg.includes("shotMax = m") && bg.includes("!shotMax || shotMax <= 0"));
ok("the resize is logged with before/after KB",
  bg.includes("capture resized ${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB"));
ok("Blender no longer waits for the hand-off PNG to be deleted",
  bg.includes("Deliberately NOT awaited") &&
  bg.includes('name: "delete_path", arguments: { path: cand } }, 15000).catch(() => {})'));

if (ctx.exports && ctx.exports.bytesToB64 && ctx.exports.b64ToBytes) {
  const { bytesToB64, b64ToBytes } = ctx.exports;
  const pattern = new Uint8Array(70000);           // crosses the 0x8000 chunking
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 7 + 13) & 0xff;
  const b64 = bytesToB64(pattern);
  const back = b64ToBytes(b64);
  const hex = Buffer.from(pattern).toString("base64");
  ok("base64 helpers match Node's encoder exactly (70KB, chunked)",
    b64 === hex && back.length === pattern.length &&
    back[0] === pattern[0] && back[69999] === pattern[69999] && back[32768] === pattern[32768]);
  ok("base64 helpers handle the empty and short cases",
    bytesToB64(new Uint8Array(0)) === "" &&
    bytesToB64(new Uint8Array([104, 105])) === Buffer.from("hi").toString("base64"));
}

// ── behaviour: a real round-trip through the host (fake Studio) ─────────────
const py = ["python3", "python", "py"].find((c) => {
  const r = spawnSync(c, ["-c", "import sys"], { encoding: "utf8" });
  return !r.error && r.status === 0;
});
if (!py) {
  console.log("SKIP  host round-trip (no Python on PATH in this environment)");
} else {
  const r = spawnSync(py, ["studio_mcp_host.py", "--selftest"], { encoding: "utf8", timeout: 60000 });
  ok("host round-trip against a fake Studio (initialize -> tools -> capture -> image)",
    r.status === 0 && /SELFTEST PASS/.test(r.stdout || ""));
  if (r.status !== 0) console.log((r.stdout || "") + (r.stderr || ""));
}

// ── the settings toggle (a button, not a code edit) ────────────────────────
ok("Settings has a Fast screenshots toggle wired to the capture size",
  mainJS.includes('data-mode="fastshots"') &&
  mainJS.includes("function setShotFast(v)") &&
  mainJS.includes('else if(m==="fastshots") setShotFast(!shotFast);'));
ok("the toggle writes the same key the shrinker reads (ON 1400 / OFF 0)",
  mainJS.includes('chrome.storage.local.set({ "rs-shot-max": shotFast ? 1400 : 0 })') &&
  bg.includes('changes["rs-shot-max"]'));
ok("its state survives a reload (restored from rs-shot-max)",
  mainJS.includes('const m = Number(r["rs-shot-max"]);') &&
  mainJS.includes("if (Number.isFinite(m)) shotFast = m > 0;"));
ok("flipping it applies to the NEXT capture - no extension reload",
  bg.includes("chrome.storage?.onChanged?.addListener((changes, area) =>") &&
  bg.includes("capture size setting applied"));
ok("the toggle explains itself in one line",
  mainJS.includes("Resize captures over 350 KB to 1400 px before upload"));

if (fails) { console.log(`\n${fails} Studio-host check(s) failed.`); process.exit(1); }
console.log(`\nStudio-host checks passed (${passes}).`);
