# OR — Roblox Studio + AgentScript AI agent

Turn any major AI chat (**DeepSeek, ChatGPT, Google Gemini, Kimi, GLM, Qwen, Arena, Meta AI, GitHub Copilot, Crax GPT, or Ollama running locally**) into an autonomous development agent. Three switchable engines:

| Engine | Toggle | Target | Port |
|---|---|---|---|
| **Roblox** (RS) | — | Roblox Studio via its built-in MCP server | ws://127.0.0.1:17613 |
| **AgentScript** (AS) | — | A local project folder — files + terminal | ws://127.0.0.1:17615 |
| **Animation** (AN) | — | Roblox Studio scoped to the motion workflow | ws://127.0.0.1:17613 |

Describe what you want in plain English and the AI builds instances, writes Luau/code files, sculpts terrain, tunes lighting, generates UI, runs builds and tests, and audits your project — inside Studio or directly on disk.

No API keys, no monthly fees. Chromium browsers (Chrome, Brave, Edge, Thorium). Theme is black/white outlines.

---

## Engines

- The bar above every supported chat composer carries a segmented **RS / AS / AN** toggle. Switching engines wipes tool caches so commands cannot cross engines.
- **RS** drives Roblox Studio through StudioMCP (stdio JSON-RPC spawned by `or-agent`).
- **AS** gives the AI full control of ONE local folder ("the workspace") through native Rust tools — sandboxed paths, exact-match diff editing, glob/content search, and terminal execution with hard timeouts.
- **AN** rides the same Roblox bridge as RS but steers the system prompt into the animation_* workflow.

Large `execute_luau` scripts are auto-chunked around 24 KB so Studio's parser never hits the ~64 KB wall. Each chunk is still one NDJSON/JSON-RPC line.

---

## Setup

1. Open `chrome://extensions` → Developer mode → **Load unpacked** → this folder (`manifest.json`).
2. Double-click **`or-agent.exe`** (or `or-agent --headless`). It starts:
   - HTTP API on `http://127.0.0.1:3000`
   - WS bridges on `17613` (RS/AN) and `17615` (AS)
   - Workspace folder for AgentScript (`OR_WORKSPACE_ROOT` / `--workspace` / `%USERPROFILE%\ORWorkspace`)
3. **RS/AN:** Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → Enable Studio as MCP Server.
4. Open a supported chat and click **Start agent**.

---

## Agent

- Native crate: `agent/` (`or-agent` 1.18.1). Status window, MCP helper spawn, outbound WS channel so ping/status keep flowing during a 20 s `execute_luau`.
- **Rebuild it after changing `agent/src/*.rs`** (screenshots depend on it — the bridge now carries MCP image content items through to the chat):
  ```bash
  cd agent && cargo build --release
  ```
  then copy `agent/target/release/or-agent.exe` over the one in this folder, or run it from there.
- Service worker skips stale-socket reconnect and MCP heal while a `call_tool` is in flight (the 25 s stale window used to kill long tools).
- 30 Studio skills, a 24-command animation suite, AgentScript file/terminal tools.
- **Captures** are the providers' own: `screen_capture` (Roblox Studio viewport) and `get_viewport_screenshot` (Blender viewport), both attached to the model's next message.
  - Studio: the picture comes back as an MCP **image content item** and is forwarded as base64 (needs `or-agent` 1.18.1+ to survive the bridge).
  - Blender: the addon writes the PNG, and the agent reads those bytes back (`read_file_base64`) and deletes the hand-off file.
  - Check which agent is actually running: open <http://127.0.0.1:3000/> — it returns `{"service":"or-agent","version":"…"}`. `or_status {}` reports it too.
- **Capture speed.** The wait you feel is the *chat upload* of the picture, not the capture itself, and a full-viewport Studio PNG is often several MB. Captures over 350 KB are therefore resized to at most 1400 px on the long side and re-encoded as JPEG q0.9 — but only when that actually produces fewer bytes, and small captures keep their exact original PNG bytes. Blender's hand-off PNG is no longer awaited before the picture is returned (it is deleted in the background), which removes a whole round trip per Blender capture. Tune it from the extension's service-worker console: `chrome.storage.local.set({"rs-shot-max": 1024, "rs-shot-quality": 0.85})`, or `{"rs-shot-max": 0}` to send originals.
- **Use the 1.18.1 `or-agent.exe` that ships in this repo** (and is rebuilt for you): `.github/workflows/build-agent.yml` compiles the agent on GitHub's Windows runner on every change under `agent/`, so a fresh `or-agent.exe` is always downloadable from the branch — no local toolchain. This is the permanent fix for captures: a 1.18.1+ agent carries Studio's MCP **image** content items itself, so `screen_capture` attaches a real picture. If OR reports an empty capture, first check <http://127.0.0.1:3000/> — anything below `1.18.1` is a stale exe.
- **No-compiler fallback: the Python host via `Start OR Agent.bat`.** That is ZeroScript's trick kept intact: their Studio layer is Python, so it never has to be built. The bat closes a still-running `or-agent.exe` first (an old process keeps port 3000 *and* would still be the one without the host), finds Python the way their `start.bat` does (`py -3` → `python` → a scan of the standard install folders, so an install without "Add to PATH" still works), writes `or_mcp_host.bat` as a one-line wrapper when the interpreter path contains spaces (the agent splits `OR_MCP_COMMAND` on whitespace), runs the host's `--check`, starts the agent and waits for port 3000 to answer. It then sets `OR_MCP_COMMAND` to `studio_mcp_host.py`, a stdlib-only MCP host that proxies Studio's own `StudioMCP.exe`. It (a) discovers the newest installed Studio instead of trusting `%LOCALAPPDATA%\Roblox\mcp.bat`, whose hard-coded version path breaks after a Studio update, and (b) rewrites the MCP **image** item `screen_capture` returns into `<<OR_IMAGE>>` text the extension decodes back into a picture — because or-agent 1.18.0 forwards text items only, which is why an unbuilt agent answered "empty result". Every other Studio tool is forwarded byte-for-byte. Check it any time with `py studio_mcp_host.py --check` (which StudioMCP.exe it picked) and `py studio_mcp_host.py --selftest` (fake Studio → tools → capture → image). It also adds `or_host_read_image` (the tool count becomes 28 — with 27 the host is *not* in the loop), reads Blender's `or_blender_shot.png` when the agent is too old to have `read_file_base64`, and cleans up leftover `StudioMCP.exe` processes the way ZeroScript's bridge does — one of those holding Studio's MCP port 13469 is why every capture can come back empty. Diagnostics land in `studio_mcp_host.log` next to it.
- **Studio MCP is discovered, not assumed.** The agent launches the NEWEST `StudioMCP.exe` across installed Studio versions (preferring version folders that still contain Studio itself, so an update's zombie folder can't be picked) instead of `%LOCALAPPDATA%\Roblox\mcp.bat`, whose hard-coded version path breaks after a Studio update. Override with `OR_STUDIO_MCP_PATH`.
- **More MCP servers**: `mcp_servers.json` next to `or-agent.exe` (override with `OR_MCP_CONFIG`) takes the same `{"mcpServers": {"name": {"command": …, "args": […]}}}` shape as ZeroScript's `config.json`. Each entry is spawned as a real MCP server, its tools merge into `list_commands` (collisions advertised as `server/tool`), and anything it returns as an MCP image is attached to the chat. **Connect Blender** registers `uvx blender-mcp` this way (override the command with the `rs-blender-mcp-cmd` storage key) and falls back to the direct 9876 socket when uvx is unavailable.
- Personas (Builder / Scripter / Animator / Fixer), Extra Thinking, Forge GUI, Image → Model, auto-fix playtest errors.

---

## Testing

```bash
node test-skills.js
node test-parser.js
node test-chatgpt.js
node test-animlib.js
node test-v111.js
node test-v112.js
node test-web-tools.js
node test-claude.js
node --check core/main.js && node --check core/config.js && node --check background.js
cd agent && cargo test
```

`test-bridges.js` is a live smoke test: start `or-agent` first. It checks HTTP `:3000` and WS `17613` / `17615` (no Unreal port).

## Privacy

Everything runs locally. The extension talks only to `127.0.0.1`. No telemetry. AgentScript stays inside the workspace root unless you flip FULL ACCESS.
