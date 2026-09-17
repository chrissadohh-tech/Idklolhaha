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
