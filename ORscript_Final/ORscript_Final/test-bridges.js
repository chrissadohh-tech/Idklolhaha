// Connectivity suite: verifies the agent is up and every engine bridge
// answers correctly. RS may be honestly offline (no Studio open) — that's
// a PASS as long as the bridge frame arrives with the right shape. AS must
// be fully ready (native, no editor needed).
const HTTP = "http://127.0.0.1:3000";
const ENGINES = [
  { port: 17613, id: "roblox",  name: "Roblox" },
  { port: 17615, id: "local",   name: "AgentScript" },
];
const failures = [];
const notes = [];

function introFor(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("intro timeout")), 6000);
    ws.addEventListener("message", function h(ev) {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "connected") { clearTimeout(timer); ws.removeEventListener("message", h); resolve(m); }
      } catch {}
    });
  });
}

async function checkEngine({ port, id, name }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`ws:${port} refused`));
  });
  const intro = await introFor(ws);
  if (intro.type !== "connected") throw new Error("bad frame");
  if (!Array.isArray(intro.servers) || !intro.servers.length || intro.servers[0].id !== id)
    throw new Error(`server id mismatch: ${JSON.stringify(intro.servers && intro.servers[0])}`);
  if (!Array.isArray(intro.tools)) throw new Error("tools not an array");
  ws.close();
  return intro;
}

(async () => {
  // Agent process itself
  let st;
  try {
    st = await fetch(`${HTTP}/api/status`).then((r) => r.json());
    if (typeof st.local_root !== "string" || typeof st.local_full !== "boolean") failures.push("status missing local fields");
    else console.log("PASS http /api/status (local_root present)");
  } catch { failures.push("agent HTTP API unreachable on 3000"); }

  for (const e of ENGINES) {
    try {
      const intro = await checkEngine(e);
      if (e.id === "local") {
        if (intro.ok !== true) failures.push("AS not ready (workspace down?)");
        if (intro.tools.length !== 18) failures.push(`AS catalog ${intro.tools.length}/18 tools`);
        if (intro.servers[0].alive !== true) failures.push("AS server not alive");
        console.log(`PASS ${e.name} (${e.id}) : READY, ${intro.tools.length} tools`);
      } else {
        const alive = intro.servers[0].alive === true;
        if (alive) console.log(`PASS ${e.name} (${e.id}) : bridge up, editor CONNECTED`);
        else { notes.push(`${e.name}: bridge up, editor offline (expected without Studio open)`); console.log(`PASS ${e.name} (${e.id}) : bridge up, editor offline (honest)`); }
      }
    } catch (err) {
      failures.push(`${e.name} (${e.id}) → ${err.message}`);
    }
  }

  if (failures.length) { console.log("FAILURES:\n" + failures.join("\n")); process.exit(1); }
  if (notes.length) console.log("notes: " + notes.join(" | "));
  console.log("ALL BRIDGE CONNECTIVITY TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.log("FATAL:", e.message || String(e)); process.exit(1); });
