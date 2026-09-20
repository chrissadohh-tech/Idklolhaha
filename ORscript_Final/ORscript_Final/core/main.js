// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the RSProvider interface (providers/*.js):
// waits for the model's reply, parses OR commands (RSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = RSProvider;
  const T = P.timings;
  const log = (...a) => console.log("[or]", ...a);

  // ── Timing (v1.12.2: all-native, no Web Worker) ────────────────────────────
  // v1.12 tried to beat Chrome's hidden-tab timer throttling with a blob: Web
  // Worker ticker. That was a mistake twice over: on strict-CSP sites the
  // worker dies asynchronously and took the interval registry with it (the
  // "site crashes after starting the agent" report), and even hardened (v1.12.1)
  // it remained the one novel mechanism correlated with freezes. It is now
  // REMOVED. Everything runs on native timers, exactly like v1.11:
  //   * visible tabs: full precision, zero new failure modes;
  //   * hidden tabs: Chrome clamps timers to >=1s (and 1/min after 5min) - the
  //     loop keeps RUNNING, just slower, and waitForResponse slides its
  //     deadlines while hidden (see below) so throttling can never cause a
  //     false "went quiet" / "sent nothing".
  // rsInterval remains as a thin alias so call sites read clearly; it returns a
  // disposer function.
  function rsInterval(fn, ms) {
    const id = setInterval(() => { try { fn(); } catch {} }, ms);
    return () => clearInterval(id);
  }
  function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, ms));
  }
  // ── Background mode (v1.12) ────────────────────────────────────────────────
  // v1.11 and earlier PARKED the whole agent loop on visibilitychange: leaving
  // the AI site for any other tab froze the agent until the user came back.
  // Background mode (default ON) removes the parking entirely - the loop keeps
  // reading the DOM, running tools and injecting results in hidden tabs. With
  // the worker gone, a hidden tab runs at Chrome's throttled rate (slow but
  // alive) and deadline sliding below keeps it honest; the user's return
  // restores full speed instantly. Turning it OFF restores the old
  // park-until-foreground behavior.
  let bgMode = true;
  try {
    chrome.storage.local.get("rsBgMode", (r) => { if (r && typeof r.rsBgMode === "boolean") bgMode = r.rsBgMode; });
  } catch {}
  // Codex-style permission: sandbox (Studio + workspace only) | ask (confirm writes) | full (entire PC).
  let permMode = "sandbox";
  try {
    chrome.storage.local.get("rsPermMode", (r) => {
      if (r && ["sandbox", "ask", "full"].includes(r.rsPermMode)) permMode = r.rsPermMode;
      try { window.__rsPermMode = () => permMode; } catch {}
    });
  } catch {}
  try { window.__rsPermMode = () => permMode; } catch {}
  const TOOL_ALIASES = {
    script_read_analysis: "script_analysis",
    script_readanalysis: "script_analysis",
    read_script_analysis: "script_analysis",
    analyze_script: "script_analysis",
    analyze_scripts: "script_analysis",
    analyse_script: "script_analysis",
    analyse_scripts: "script_analysis",
    script_analyze: "script_analysis",
    script_analyse: "script_analysis",
    script_lint: "script_analysis",
    lint_script: "script_analysis",
    lint_scripts: "script_analysis",
    debug_run: "or_debug",
    debug_console: "or_debug",
    auto_debug: "or_debug",
    multi_agent: "or_agent",
    spawn_agent: "or_agent",
    create_developer_product: "developer_product_create",
    create_dev_product: "developer_product_create",
    devproduct_create: "developer_product_create",
    dev_product_create: "developer_product_create",
    developerproduct_create: "developer_product_create",
    list_developer_products: "developer_product_list",
    devproduct_list: "developer_product_list",
  };
  function remapToolName(n) {
    const raw = String(n || "");
    const key = raw.replace(/-/g, "_").toLowerCase();
    return TOOL_ALIASES[key] || TOOL_ALIASES[raw] || n;
  }
  // ── Condo lock (condo-topic ONLY — not a general NSFW filter) ─────────────
  const CONDO_STORE = "rsCondoLock";
  let condoState = { strikes: 0, until: 0, lastAt: 0 };
  try {
    chrome.storage.local.get(CONDO_STORE, (r) => {
      const s = r && r[CONDO_STORE];
      if (!s) return;
      condoState.strikes = Number(s.strikes) || 0;
      condoState.until = Number(s.until) || 0;
      condoState.lastAt = Number(s.lastAt) || 0;
      if (Date.now() < condoState.until) {
        try { showCondoLockPanel(condoState.strikes, condoState.until); } catch {}
      }
    });
  } catch {}
  function isCondoTopic(text) {
    const t = String(text || "").toLowerCase().replace(/[_-]+/g, " ");
    if (!/\bcondos?\b/.test(t)) return false;
    if (/\bcondo\s*games?\b/.test(t)) return true;
    if (/\broblox\s+condos?\b/.test(t)) return true;
    if (/\bcondos?\s+(place|map|hangout|server|lobby|house|rp|erp)\b/.test(t)) return true;
    if (/\b(nsfw|erp|lewd|18\s*\+|adult|sex|porn|nude|naked|horny)\b/.test(t)) return true;
    if (/\b(make|build|create|script|code)\b.{0,80}\bcondos?\b/.test(t) && /\b(game|place|map|hangout|roleplay)\b/.test(t)) return true;
    return false;
  }
  function grabCondoHaystack() {
    const chunks = [];
    try {
      const uiRoot = document.getElementById("rs-root");
      for (const ed of document.querySelectorAll('[contenteditable="true"], textarea')) {
        if (uiRoot && uiRoot.contains(ed)) continue;
        const v = (ed.innerText || ed.value || "").trim();
        if (v) chunks.push(v);
      }
    } catch {}
    try {
      const users = document.querySelectorAll('[data-message-role="user"], [data-role="user"], [data-author="user"], [data-author="human"]');
      if (users.length) chunks.push((users[users.length - 1].innerText || "").trim());
    } catch {}
    try {
      if (typeof P !== "undefined" && P.readAssistant) {
        const d = P.readAssistant();
        if (d && d.reply) chunks.push(String(d.reply));
      }
    } catch {}
    return chunks.join("\n");
  }
  function condoLocked() { return Date.now() < (condoState.until || 0); }
  function haltCondoSite() {
    try {
      const btns = [...document.querySelectorAll("button")].filter((b) => !b.closest("#rs-root"));
      const stop = btns.find((b) => /stop|cancel generation|abort/i.test((b.getAttribute("aria-label") || b.title || "") + " " + (b.textContent || "")));
      if (stop) stop.click();
    } catch {}
  }
  function showCondoLockPanel(strikes, until) {
    let el = document.getElementById("rs-condo-lock");
    if (!el) {
      el = document.createElement("div");
      el.id = "rs-condo-lock";
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.cssText = "position:fixed;z-index:2147483646;right:12px;bottom:72px;width:280px;padding:12px 14px;background:#1a1014;color:#f3d5dc;border:1px solid #a33;border-radius:5px;font:12px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px #0008;";
    el.textContent = "";
    const h = document.createElement("div");
    h.textContent = "CONDO LOCK";
    h.style.cssText = "font-weight:700;letter-spacing:.08em;color:#ff6b81;margin-bottom:6px;";
    const p = document.createElement("div");
    el.appendChild(h);
    el.appendChild(p);
    const tick = () => {
      const s = Math.ceil(((until || 0) - Date.now()) / 1000);
      if (s <= 0) { try { el.remove(); } catch {} return; }
      p.textContent = "You tried to create a condo game. That's blocked. The agent will not build it. Strike " + strikes + " — Start is frozen for " + s + "s.";
      el._t = setTimeout(tick, 1000);
    };
    try { clearTimeout(el._t); } catch {}
    tick();
  }
  function punishCondo(source) {
    if (condoState._busy) return;
    condoState._busy = true;
    const now = Date.now();
    if (now - (condoState.lastAt || 0) > 86400000) condoState.strikes = 0;
    condoState.strikes = (condoState.strikes || 0) + 1;
    condoState.lastAt = now;
    const wait = condoState.strikes >= 3 ? 600000 : condoState.strikes === 2 ? 180000 : 45000;
    condoState.until = now + wait;
    try { chrome.storage.local.set({ [CONDO_STORE]: { strikes: condoState.strikes, until: condoState.until, lastAt: condoState.lastAt } }); } catch {}
    try { A.stop = true; A.userStopped = true; A.resumeArmed = false; } catch {}
    try { haltCondoSite(); } catch {}
    try { ui.toast("CONDO LOCK — that topic is blocked"); } catch {}
    try { ui.banner("warn", "CONDO LOCK", "Condo games are blocked. Strike " + condoState.strikes + ". Start is frozen."); } catch {}
    try { showCondoLockPanel(condoState.strikes, condoState.until); } catch {}
    try { diag("condo.lock", { source: String(source || ""), strikes: condoState.strikes }); } catch {}
    setTimeout(() => { condoState._busy = false; }, 800);
  }
  function enforceCondo(source, extra) {
    const text = [extra, grabCondoHaystack()].filter(Boolean).join("\n");
    if (!isCondoTopic(text)) return false;
    punishCondo(source);
    return true;
  }
  const ASK_OPS = new Set([
    "execute_luau","multi_edit","write_file","edit_file","delete_path","move_path","create_folder",
    "run_command","process_kill","download_file","open_path",
    "lighting_set_preset","lighting_setup_day_night","terrain_fill_region","terrain_clear",
    "ui_create_screen","ui_create_component","fx_create_emitter","fx_create_light","fx_create_vfx",
    "audio_setup_sound_hierarchy","audio_create_sound","camera_set_style","datastore_setup",
    "leaderboard_setup","remote_setup","teams_setup","npc_spawn_pathfinding","proximity_setup",
    "tween_create","marketplace_setup","diagnostics_fix_common","plugin_create",
    "ui_build","ui_set_image","ui_set_texture","ui_set_property","ui_paint","ui_add_element","ui_apply_theme","ui_bind_button",
    "decal_set","mesh_set_texture","surface_gui_create","ui_clone","ui_clear_children",
    "instance_rename","instance_reparent","script_append","selection_set",
    "script_set_source","script_disable","anchored_set","collision_set","transparency_set",
    "humanoid_set","lighting_set","folder_create","value_set","weld_constraint","instance_move","tag_remove",
    "append_file","copy_file","replace_in_files","patch_json","write_json","replace_once",
    "execute_blender_code","blender_export_fbx",
    "size_set","color_set","cframe_set","rotation_set","massless_set","can_touch_set","can_query_set","cast_shadow_set","collision_group_set","brickcolor_set",
    "meshpart_create","wedge_create","spawn_box","ladder_create","trampoline_create","conveyor_create","ice_part","jump_pad","speed_pad",
    "attachment_create","hinge_create","spring_create","rope_create","vector_force_create","linear_velocity_create",
    "fire_add","smoke_add","sparkles_add","point_light_add","spot_light_add",
    "atmosphere_set","bloom_set","blur_set","color_correction_set","sunrays_set","gravity_set",
    "walkspeed_set","jumppower_set","forcefield_add","explosion_at","teleport_to","leaderstats_int","remote_event_create","sound_volume","set_property","scale_model","ungroup_model",
    "developer_product_create","developer_product_list",
  ]);
  function requestApproval(op, args) {
    return new Promise((resolve) => {
      const root = document.getElementById("rs-approve");
      const body = document.getElementById("rs-approve-body");
      const allow = document.getElementById("rs-approve-allow");
      const deny = document.getElementById("rs-approve-deny");
      if (!root || !allow || !deny) { resolve(true); return; }
      const preview = (() => {
        try { return JSON.stringify(args || {}, null, 0).slice(0, 280); } catch { return ""; }
      })();
      if (body) body.innerHTML = `<b>${op}</b>${preview ? `<pre>${preview.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>` : ""}`;
      root.hidden = false;
      const done = (ok) => {
        root.hidden = true;
        allow.removeEventListener("click", onAllow);
        deny.removeEventListener("click", onDeny);
        resolve(ok);
      };
      const onAllow = () => done(true);
      const onDeny = () => done(false);
      allow.addEventListener("click", onAllow);
      deny.addEventListener("click", onDeny);
    });
  }
  function setPermMode(id) {
    if (!["sandbox", "ask", "full"].includes(id)) return;
    permMode = id;
    try { window.__rsPermMode = () => permMode; } catch {}
    try { chrome.storage.local.set({ rsPermMode: id }); } catch {}
    try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: id === "full" }).catch(() => {}); } catch {}
  }
  // Thrown by submitAndGetBase when the message VERIFIABLY never landed (the
  // composer never cleared and no new turn appeared after all retries). Callers
  // must abort the turn immediately instead of waiting a full warm-up cycle for
  // a reply that can never come - that dead wait is what froze the composer for
  // minutes on sites whose send silently no-ops (crax guest mode).
  class SendAbortedError extends Error {}


  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  // Suspected contributor to Arena's captcha: the agentic loop sends turns
  // back-to-back with near-zero, perfectly regular delay (~200ms settle),
  // which behavioral risk-scoring (reCAPTCHA/Cloudflare) can read as a bot
  // signal alongside the necessarily-synthetic input events. This adds a
  // small randomized human-reaction-time delay before each send.
  // REVERT: flip HUMANIZE_SEND to false - single toggle, no other changes needed.
  const HUMANIZE_SEND = false; // didn't prevent Arena's captcha (fires on turn 1 already) - revert
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[rs-diag]") or window.__rsDiag (also mirrored onto a hidden
  // DOM node for a main-world inspector). Each entry carries a turn snapshot.
  const RS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    let snap = {};
    try { snap = { ...P.snapshot(), gen: P.isGenerating(), run: (typeof A !== 'undefined' ? A.running : false) }; } catch {}
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > RS_DIAG_MAX) _diag.shift();
    try { console.log("[rs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("rs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "rs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__rsDiag = _diag; } catch {}
  }

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  {
    const EXPECT = 250, STALL = 800; // only log gaps beyond this many ms
    let _lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _lastTick;
      _lastTick = now;
      if (gap > STALL) {
        diag("stall.detected", { ms: gap, overBy: gap - EXPECT,
          toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
      }
    }, EXPECT);
  }

  // ── Global error visibility ────────────────────────────────────────────────
  // Uncaught exceptions and rejected promises used to vanish (most of the loop
  // is wrapped in broad try/catch, but anything outside one was silently lost
  // and looked like "the agent just froze"). Land them in the diag log so a
  // freeze always leaves a fingerprint. Rate-limited: a throwing interval could
  // otherwise flood both the console and the ring buffer.
  {
    let _lastErrAt = 0, _errCount = 0;
    const _report = (kind, detail) => {
      const now = Date.now();
      if (now - _lastErrAt < 3000) { _errCount++; return; }
      diag(kind, { ...detail, suppressed: _errCount });
      _errCount = 0;
      _lastErrAt = now;
      try { console.warn("[rs] uncaught", kind, detail); } catch {}
    };
    window.addEventListener("error", (e) => {
      // Only OUR errors: content-script files carry the extension origin
      // (chrome-extension://<id>/...). The old regex tested the wrong shape and
      // silently dropped every real extension error (site scripts are http(s),
      // never chrome-extension://), so freezes left no fingerprint.
      const file = String((e && e.filename) || "");
      if (file && !file.includes("chrome-extension://")) return;
      _report("uncaught.error", { msg: e && e.message, line: e && e.lineno, file: e && e.filename });
    }, true);
    window.addEventListener("unhandledrejection", (e) => {
      const r = e && e.reason;
      const msg = r && (r.stack || r.message || String(r));
      // Chrome fires these for OUR chrome.runtime.sendMessage rejects too when a
      // tab closes mid-send - already handled as {ok:false,...}, so ignore them.
      if (msg && /Extension context invalidated|message port closed/i.test(msg)) return;
      _report("uncaught.rejection", { msg: String(msg).slice(0, 300) });
    });
  }

  // Central product name. The bar shows THIS constantly; which ENGINE is live
  // is communicated by the RS/AS/AN pill plus a top-right toast on switch.
  const BRAND_NAME = "OR";
  // Shown in the panel instead of a static "Free" label, so a user's screenshot
  // alone tells us which build they're on for debugging. Pulled from
  // manifest.json (single source of truth) rather than duplicated here.
  const EXT_VERSION = chrome.runtime.getManifest().version;
  // Which bridge launcher to tell the user to run: start.bat is Windows-only.
  // macOS uses MacOS_Start.command, Linux runs bridge.py directly.
  const RUN_CMD = "or-agent.exe";
  // (The setup tutorial is now an in-app modal — see openTutorial() — so the
  // old YouTube link is gone and can never go stale.)
  // Work.ink locked link - free "watch an ad" support option. Set once the
  // locker is created at https://work.ink; the button is hidden until then.
  const WORKINK_URL = "https://work.ink/2JXi/robloxscript-free-roblox-ai-coding-tool";
  // Roblox "tip" Game Passes - the native currency for the audience.
  const ROBUX_PASSES = [
    { id: 1941228530 },
    { id: 1941336506 },
    { id: 1940736510 },
    { id: 1941672495 },
  ];
  const passUrl = (id) => `https://www.roblox.com/game-pass/${id}`;
  function parseRobuxPrice(text) {
    const m = String(text || "").match(/"PriceInRobux"\s*:\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
  }
  async function lookupRobuxPrice(id) {
    const urls = [
      "https://economy.roblox.com/v1/game-passes/" + id + "/game-pass-product-info",
      "https://economy.roblox.com/v2/assets/" + id + "/details",
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await bg({ type: "web_fetch", url: urls[i], max_chars: 2500 });
        const price = parseRobuxPrice(r && (r.text || r.body));
        if (price > 0) return price;
      } catch (e) {}
    }
    return 0;
  }
  async function fillRobuxPrices(root) {
    if (!root) return;
    const btns = root.querySelectorAll(".rs-tip-rbx[data-pass]");
    await Promise.all(Array.from(btns).map(async (btn) => {
      const id = btn.getAttribute("data-pass");
      const amt = btn.querySelector(".rs-rbx-amt");
      const price = await lookupRobuxPrice(id);
      if (amt) amt.textContent = price > 0 ? String(price) : "";
    }));
  }
  // AI chat sites OR works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const DISCORD_URL = "https://discord.gg/FmKY5bXZn";
  const OR_THEMES = {
    night:      { name: "Night",      sub: "Quiet graphite",   glyph: "☾", blurb: "Midnight steel — moon ticks and star grain." },
    "blood-moon": { name: "Blood Moon", sub: "Crimson eclipse", glyph: "☽", blurb: "Blood Moon — a red disc, ember haze, crescent." },
    sakura:     { name: "Sakura",     sub: "Petal glow",       glyph: "✿", blurb: "Sakura — scattered petals on dusk pink." },
    starglaze:  { name: "Starglaze",  sub: "Nebula glass",     glyph: "✦", blurb: "Starglaze — aurora wash and twinkling glints." },
    autumn:     { name: "Autumn",     sub: "Harvest ember",    glyph: "❧", blurb: "Autumn — falling leaves and harvest fire." },
  };
  let orTheme = "night";
  let soundOn = true;
  let shotFast = true;   // mirrors chrome.storage "rs-shot-max" (0 = originals)
  try {
    chrome.storage.local.get(["rsTheme", "rsSounds"], (r) => {
      if (r && OR_THEMES[r.rsTheme]) orTheme = r.rsTheme;
      if (r && typeof r.rsSounds === "boolean") soundOn = r.rsSounds;
      try { applyOrSkin(); } catch {}
    });
  } catch {}
  function applyOrSkin() {
    try {
      document.documentElement.setAttribute("data-rs-theme", orTheme);
      window.__rsTheme = () => orTheme;
      const th = OR_THEMES[orTheme];
      const brand = document.getElementById("rs-brand");
      if (brand) {
        brand.textContent = BRAND_NAME;
        brand.title = th ? th.name : "";
      }
      const tag = document.querySelector(".rs-menu-tag");
      if (tag) tag.textContent = "v" + EXT_VERSION + " · " + ((th && th.name) || "Night");
      const orn = document.getElementById("rs-ornament");
      if (orn) orn.setAttribute("data-theme", orTheme || "night");
      const glyph = document.querySelector(".rs-menu-glyph");
      if (glyph) glyph.textContent = (th && th.glyph) || "☾";
      document.querySelectorAll(".rs-theme-card").forEach((el) => {
        el.classList.toggle("on", el.getAttribute("data-theme") === orTheme);
      });
      const barEl = document.getElementById("rs-bar");
      if (barEl) barEl.setAttribute("data-or-theme", orTheme || "night");
    } catch {}
  }
  function setOrTheme(id) {
    if (!OR_THEMES[id]) return;
    orTheme = id;
    applyOrSkin();
    try { chrome.storage.local.set({ rsTheme: id }); } catch {}
  }
  // Capture speed: ON = oversized captures are resized before upload (quicker),
  // OFF = the full-size original is sent. Background reads the same storage key,
  // so flipping this takes effect immediately - no extension reload.
  function setShotFast(v) {
    shotFast = !!v;
    try { chrome.storage.local.set({ "rs-shot-max": shotFast ? 1400 : 0 }); } catch {}
    try { buildMenu(); } catch {}
    toast(shotFast
      ? "Fast screenshots ON - captures are resized before upload"
      : "Fast screenshots OFF - sending full-size captures");
  }

  function setSounds(v) {
    soundOn = !!v;
    try { chrome.storage.local.set({ rsSounds: soundOn }); } catch {}
  }
  function playSfx(kind) {
    if (!soundOn) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = playSfx._ctx || (playSfx._ctx = new AC());
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const beep = (freq, t, dur, type, gain) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || "sine";
        o.frequency.setValueAtTime(freq, now + t);
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.exponentialRampToValueAtTime(gain || 0.05, now + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(now + t); o.stop(now + t + dur + 0.02);
      };
      if (kind === "start") { beep(520, 0, 0.09, "triangle", 0.04); beep(780, 0.08, 0.12, "sine", 0.035); }
      else if (kind === "done") { beep(523, 0, 0.1, "sine", 0.05); beep(659, 0.1, 0.12, "sine", 0.045); beep(784, 0.22, 0.18, "triangle", 0.04); }
      else if (kind === "stop") { beep(330, 0, 0.12, "triangle", 0.04); beep(220, 0.1, 0.16, "sine", 0.03); }
      else if (kind === "error") { beep(180, 0, 0.16, "sawtooth", 0.03); beep(140, 0.12, 0.2, "triangle", 0.025); }
      else if (kind === "ok") { beep(660, 0, 0.08, "sine", 0.035); }
    } catch {}
  }

  const AI_SITES = [
    { name: "DeepSeek", url: "https://chat.deepseek.com/" },
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Claude", url: "https://claude.ai/new" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.com/" },
    { name: "Kimi AI", url: "https://kimi.ai/" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/text/direct" },
    { name: "Freebuff", url: "https://freebuff.ai/chat" },
    { name: "Meta AI", url: "https://www.meta.ai/" },
    { name: "Copilot", url: "https://github.com/copilot" },
    { name: "Copilot (Microsoft)", url: "https://copilot.microsoft.com/" },
    { name: "Crax GPT", url: "https://gpt.crax.lol/" },
    { name: "Use AI", url: "https://use.ai/chat" },
    { name: "Ox Alpha", url: "https://oxalpha.com/chat" },
    { name: "Ollama", url: "ollama://local" },
  ];

  const A = {
    running: false,
    stop: false,
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see sinceLastSys / sysResendDue).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN Roblox vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
    // Timestamp of the last successful tool-catalogue refresh (see ensureTools).
    toolsAt: 0,
  };

  // Provider init must happen after A is defined — diag() reads A.running and
  // copilot's init calls diag() immediately, which would TDZ if init ran before A.
  try { P.init({ diag }); } catch {}

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // v1.10 behavior was to park until the AI tab is the FOREGROUND tab again.
  // Users hated it ("I switch to another website and the AI just stops") - so
  // since v1.12 the loop keeps working in hidden tabs (background mode) and
  // this only parks when the user explicitly turned background mode OFF.
  // Still event-driven with no time cap: a tab minimized/backgrounded for an
  // hour must resume cleanly, not silently time out into a "could not send /
  // not run" failure. Returns false ONLY if the user stopped while we were
  // parked, so callers can break.
  async function waitVisible() {
    if (!document.hidden || A.stop) return !A.stop;
    if (bgMode) return true; // background mode: keep working on other sites
    A.parked = true;
    try { ui.setStarting(); } catch {}
    try {
      await new Promise((resolve) => {
        const done = () => {
          document.removeEventListener("visibilitychange", onVis);
          clearInterval(iv);
          resolve();
        };
        const onVis = () => { if (!document.hidden) done(); };
        document.addEventListener("visibilitychange", onVis);
        // Safety net only: covers a stop click while parked, and the (unlikely)
        // case of a missed visibilitychange event.
        const iv = setInterval(() => { if (A.stop || !document.hidden) done(); }, 1000);
      });
    } finally {
      A.parked = false;
      try { ui.setStarting(); } catch {}
    }
    return !A.stop;
  }

  // Park while the tab is hidden and report how long we were parked, so callers
  // can slide their timers forward by that amount. Without this, every deadline
  // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
  // ticking while nothing can be read - which is what turned "user switched to
  // Studio for 5 minutes" into "No response from <site>, the loop has stopped"
  // and left the pending command showing a grey "not run".
  // Background mode (v1.12) returns 0 immediately: the tab keeps reading its
  // own DOM while hidden, so no deadline sliding is needed.
  async function parkHidden() {
    if (!document.hidden || A.stop) return 0;
    if (bgMode) return 0;
    const t0 = Date.now();
    await waitVisible();
    const parked = Date.now() - t0;
    diag("park.resumed", { parkedMs: parked });
    // Give the site a beat to repaint: a tab that was hidden has no layout, so
    // the first reads after unhide can come back stale/blank.
    if (!A.stop) await sleep(400);
    return parked;
  }

  // Submit `text` as a new turn, masking the input while we type. Returns the
  // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
  // Snapshot the identity of the assistant turn present BEFORE we send. Paired
  // with waitForResponse, this lets "a new reply turn exists" be tested by node
  // identity rather than a raw count - the latter is unreliable on providers that
  // virtualize the message list, where the count stays flat as a new
  // turn appears and old ones detach. Captured at every send site (tool feedback,
  // user message, bootstrap). Providers without lastAssistantId fall back to count.
  function captureSendToken() {
    A.sendToken = P.lastAssistantId ?  P.lastAssistantId() : undefined;
  }

  async function submitAndGetBase(text, images) {
    // ── Duplicate-submit suppression ──
    // The retry loop below can legitimately resend when a send clearly didn't
    // land — but two callers racing (double-click Start, restart during
    // bootstrap, watchdog + user) must NEVER fire the same prompt twice.
    const _sig = images
      ? "img:" + Date.now()
      : String(text).length + ":" + String(text).slice(0, 120) + ":" + String(text).slice(-60);
    if (!images && A._lastSubmit && A._lastSubmit.sig === _sig && Date.now() - A._lastSubmit.at < 2500) {
      diag("send.duplicateSuppressed", {});
      return P.assistantCount();
    }
    A._lastSubmit = { sig: _sig, at: Date.now() };

    captureSendToken();
    diag("send", { text: String(text).slice(0, 60), busy: P.isBusyNow() });
    A.injecting = true;
    A._injectingSince = Date.now(); // stale-injecting failsafe anchor (meter loop)
    ui.inputCover(true);
    try {
      // Quick 2-point settle: sample the previous response's stream length before
      // and after a 200ms yield. A one-shot React batch flush (the common case)
      // shows no second growth and costs only 200ms. A genuinely still-generating
      // stream shows growth → fall back to the full idle wait.
      const _settleItem = P.lastAssistant();
      const _settleLen0 = _settleItem ?  P.streamLen(_settleItem) : 0;
      await sleep(200);
      if (_settleItem && _settleItem === P.lastAssistant() &&
          P.streamLen(_settleItem) > _settleLen0) {
        await waitFor(() => !P.isGenerating(), 4000);
      }
      const base = P.assistantCount();
      const preUser = P.userCount();
      // Arm the optimistic pre-hide for the result turn we're about to inject:
      // the very next NEW user turn is ours, so preHideWholeItems can mask it on
      // creation instead of waiting for its "Output of '…'" caption to render
      // (which lands a tick after the node - especially with an attached image -
      // and would otherwise flash the raw output for the 200/700ms until a sweep
      // nudge catches it). See preHideWholeItems.
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      // "Landed" = a new turn appeared in the DOM. In long chats, list
      // virtualisation can keep counts flat even when our message landed - the
      // textarea-cleared signal below is the primary fast gate.
      const landed = () => P.userCount() > preUser || P.assistantCount() > base;
      // v1.10 rule was "never type/send while the tab is HIDDEN" - background
      // tabs throttle rendering, which made the landed-check unreliable and
      // duplicated sends. v1.12 background mode keeps sending in hidden tabs
      // (the worker ticker keeps the pacing honest and the tail-fingerprint
      // below is count-independent); without background mode we still park.
      let tries = 0;
      let messageSent = false;
      // Fingerprint of what we typed: if the composer no longer contains this
      // tail, the send DID land even when counts/textarea signals are flaky
      // (virtualised lists, slow clearing). Prevents blind resends.
      const sentTail = String(text).slice(-80);
      // Max ONE resend: with the tail-fingerprint above, a second attempt only
      // happens when our text is verifiably still sitting in the composer.
      while (!messageSent && !landed() && tries < 2 && !A.stop) {
        if (document.hidden && !bgMode) {
          diag("send.waitVisible", { tries });
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
        }
        await jitterBeforeSend();
        diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
        await P.typeAndSend(text, images);
        // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
        // was just clicked, so our result turn is about to render). The initial
        // arm above can EXPIRE during an image upload - typeAndSend blocks ~3-6s
        // uploading the capture before the turn appears, past the 2.5s window - so
        // without this re-arm the raw "Output of…" + a still-loading (0-byte)
        // thumbnail flash for image feedbacks until a sweep chip lands. Safe: the
        // input is covered and the loop owns this send, so no user turn can slip
        // into the window, and the pre-hide is one-shot (consumes the first turn).
        A.injectHideUntil = Date.now() + 2500;
        // The site clears the textarea as soon as the send is accepted - faster
        // and more reliable than waiting for a DOM turn count change. Also accept
        // "our text is no longer in the composer" as proof of landing.
        await waitFor(() => {
          const edNow = P.editorText().trim();
          if (edNow === "") messageSent = true;
          else if (edNow.length < sentTail.length || !edNow.includes(sentTail.slice(-40))) messageSent = true;
          return messageSent || landed();
        }, 3500);
        tries++;
      }
      if (messageSent) diag("send.cleared", { tries });
      // All retries exhausted with NO evidence the message landed (textarea never
      // cleared, no new turn). Silently returning here left the loop waiting for
      // a reply that will never come (~60s "empty" timeout) with zero explanation
      // - the reported "the tool result just never gets injected" symptom. Tell
      // the user what actually happened so they can nudge the conversation
      // themselves instead of watching a stuck bar.
      if (!messageSent && !landed() && !A.stop) {
        diag("send.failed", { tries });
        ui.banner("warn", "Message didn't send",
          `${P.displayName} wouldn't take the message after ${tries} tries. ` +
          `Just send something short yourself — like "continue" — and it'll pick back up.`);
        // Abort the caller's turn NOW (v1.12.1). Returning `base` here made the
        // watcher sit through warm-up + late-rescue + dead-retry (~2min) for a
        // reply that can never come, with the composer locked the whole time.
        throw new SendAbortedError("send did not land");
      }
      return base;
    } finally {
      // During Starting Up / the agent loop, the bootstrap or loop owns the cover
      // for the whole phase, so don't lift it here between an injection and the
      // next waitForResponse - it stays up until the loop / bootstrap ends.
      if (!A.starting && !A.running) ui.inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      // Camouflage the turn we just injected without waiting on the rAF observer
      // (paused in a background tab). A couple of nudges cover the render.
      setTimeout(scheduleSweep, 200);
      setTimeout(scheduleSweep, 700);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
  // ════════════════════════════════════════════════════════════════════════
  async function waitForResponse(base) {
    const t0 = Date.now();
    // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
    // long with NO streaming AND no text change. lastActiveAt is refreshed every
    // tick the model is generating or the reply text grows, so an arbitrarily
    // LONG but still-active response never trips it (the old total-elapsed cap
    // wrongly fired "No response" while the model was still writing past 300s).
    const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
    let lastActiveAt = Date.now();
    const STABLE_MS = T.STABLE_MS; // generating-flag stuck ON but text frozen → done
    let started = false, doneSince = 0, lastLimitScan = 0;
    let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
    // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
    // genOffFirstAt: the FIRST moment gen went false after streaming began (does
    // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
    // flipped back true after having been false - a high count means post-stop DOM
    // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
    // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
    // gen was (re)true. These pinpoint which gate causes any tail latency.
    let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
    let waitedBlock = 0, waitedFlicker = 0;
    const finalizeDiag = (kind) => {
      const now = Date.now();
      diag("stopGoneToResp", {
        kind,
        stopGoneToRespMs: genOffFirstAt ?  now - genOffFirstAt : null,
        genStableForMs: genFalseSince ?  now - genFalseSince : null,
        lastChangeAgoMs: now - lastChangeAt,
        genFlickers, waitedBlock, waitedFlicker,
        totalMs: now - t0,
      });
    };
    let preStartSilent = 0; // nothing produced AND not generating
    let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
    // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
    // subtree (React/Monaco churn) and a read can come back "" for a frame at
    // the exact moment the watcher finalizes - the turn then ended as
    // kind:"empty" even though a (possibly cut-off) command was sitting there a
    // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
    // autoResume dedupe (zResume) blocks any later retry (validated live on a
    // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
    // declaring empty. Reset whenever the turn NODE changes so a new turn can
    // never inherit the previous turn's text.
    let lastGoodReply = "";
    let reasonSince = 0; // reasoning written but no answer yet (loading phase)
    let noTurnSince = 0; // finalize attempted before this send's reply turn exists
    let lateRescue = false; // v1.12: one bounded late-reply look before declaring empty
    let unsettledSince = 0; // command-shaped reply whose read is not yet stable
    const WARMUP_MS = T.WARMUP_MS;
    const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
    const NO_TURN_GRACE_MS = 30000;
    // Upper bound on holding off a parse verdict while a provider reports its
    // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
    // read still resolves after this and is parsed as-is.
    const UNSETTLED_GRACE_MS = 8000;
    const PRESTART_MS = T.PRESTART_MS || 60000;
    // Once the generating flag has been OFF this long, the model has clearly
    // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
    // artifact, not live output, and must not keep the watcher waiting. Provider
    // -neutral: while a model is genuinely streaming, gen stays true and this is
    // never reached. Slow hosts (Freebuff) override via timings.GEN_STOP_GRACE_MS.
    const GEN_STOP_GRACE_MS = T.GEN_STOP_GRACE_MS || 2500;

    // v1.12.2: deadline sliding while hidden+bgMode (replaces the old
    // park-then-slide). Hidden tabs get throttled timers (>=1s, 1/min after
    // 5min) AND unreliable DOM reads (no layout), so we slide every deadline
    // forward by the hidden gap - capped at 30s per iteration so a turn can
    // still EVENTUALLY time out on its own instead of hanging forever while
    // the tab never gets foregrounded again.
    let lastHiddenCheck = Date.now();

    while (Date.now() - lastActiveAt < TIMEOUT) {
      if (A.stop) return { kind: "stopped" };
      // NEVER let a deadline expire while the tab is in the background. A hidden
      // tab has no layout (innerText reads come back "", getBoundingClientRect is
      // 0x0) and Chrome throttles its timers, so every read here is unreliable -
      // and the site may legitimately keep streaming for as long as the user is
      // away in Studio. Park until the tab is foreground again (parking mode),
      // or slide the deadlines forward (background mode) so nothing that was
      // mid-flight when the user switched away expires the moment they come
      // back. This is the fix for "I switched to Studio, came back and the
      // command says 'not run'": the loop used to burn its 5-minute inactivity
      // budget off-screen, end with "No response from <site>", and orphan the
      // pending command.
      if (document.hidden && !A.stop && !bgMode) {
        const parked = await parkHidden();
        if (A.stop) return { kind: "stopped" };
        if (parked) {
          lastActiveAt += parked; lastChangeAt += parked;
          if (doneSince) doneSince += parked;
          if (genFalseSince) genFalseSince += parked;
          if (preStartSilent) preStartSilent += parked;
          if (warmSince) warmSince += parked;
          if (reasonSince) reasonSince += parked;
          if (noTurnSince) noTurnSince += parked;
          if (unsettledSince) unsettledSince += parked;
          if (genOffFirstAt) genOffFirstAt += parked;
        }
        continue; // re-read everything now that the tab has layout again
      }
      if (document.hidden && !A.stop && bgMode) {
        const now = Date.now();
        const gap = now - lastHiddenCheck;
        if (gap > 1200) { // only slide when the gap shows real throttling
          const slide = Math.min(gap - 1000, 30000);
          lastActiveAt += slide; lastChangeAt += slide;
          if (doneSince) doneSince += slide;
          if (genFalseSince) genFalseSince += slide;
          if (preStartSilent) preStartSilent += slide;
          if (warmSince) warmSince += slide;
          if (reasonSince) reasonSince += slide;
          if (noTurnSince) noTurnSince += slide;
          if (unsettledSince) unsettledSince += slide;
          if (genOffFirstAt) genOffFirstAt += slide;
        }
        lastHiddenCheck = Date.now();
        await sleep(300); // a beat between throttled reads; loop continues below
      } else {
        lastHiddenCheck = Date.now();
      }
      const gen = P.isGenerating();
      if (gen) lastActiveAt = Date.now(); // actively generating ⇒ never time out
      let d = P.readAssistant();
      // Sites virtualize their lists, so the absolute assistant count can DROP
      // even as a new reply is added. A count increase still proves a new turn
      // appeared; the generating flag is the reliable "reply has begun" signal.
      // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
      // the provider exposes it: the last assistant turn's id differs from the one
      // captured at send time. Fall back to the count test otherwise. Without this,
      // a provider's list virtualisation can keep assistantCount() <= base for a
      // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
      // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
      // up" symptom (scrolling re-attached old turns and bumped the count).
      const curTok = P.lastAssistantId ?  P.lastAssistantId() : undefined;
      // A NULL token means the provider could not read an identity for the
      // CURRENT last turn (not that the provider lacks ids - that's undefined).
      // Treating null as "no new reply" wedged the watcher on Qwen: a
      // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
      // carry, so curTok stayed null, `started` never latched, and the loop
      // sat in the pre-start branch for the full 60s before ending "empty" -
      // the regenerated command (complete in the net tap) was never run and
      // zResume then blocked any retry (validated live via empty.why, 2026-07).
      // Fall back to the count test instead, exactly as for a provider with no
      // lastAssistantId at all.
      const newReply = (curTok !== undefined && curTok !== null)
        ? (curTok !== A.sendToken)
        : P.assistantCount() > base;

      // Track whether the CURRENT turn has produced anything. Reset when the
      // turn node changes (the PREVIOUS turn's content never counts).
      if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; }
      if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;
      if (d.reply && d.reply.length) lastGoodReply = d.reply;

      if (!started) {
        // CRITICAL: a bare count increase is NOT enough - the empty turn
        // CONTAINER can appear seconds before the first token. Require actual
        // CONTENT (or the generating flag).
        const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
        if (gen || (newReply && hasText)) { started = true; }
        else {
          // The site can be slow to even CREATE the reply turn. Keep waiting -
          // only give up after a long fully-silent window.
          if (!preStartSilent) preStartSilent = Date.now();
          // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
          // on Qwen kept ending "empty" with a complete command in the net tap,
          // and without the branch name the cause was unfindable from the log.
          if (Date.now() - preStartSilent > PRESTART_MS) { diag("empty.why", { branch: "preStart", rep: (d.reply||"").length }); return { kind: "empty" }; }
          await sleep(200);
          continue;
        }
      }

      // Track text stability (independent of the generating flag). Compare the
      // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
      // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
      // copy-bar text churn - don't count as real "changes" and keep resetting
      // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
      // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
      // reduce false changes, so short replies / other providers are unaffected.
      const replyNorm = (d.reply || "").replace(/\s+/g, " ").trim();
      if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); lastActiveAt = Date.now(); }
      // How long the generating flag has been OFF. A mid-stream flicker resets
      // this the instant growth resumes and gen flips back on.
      if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
      // DIAG: first gen-off, and count flickers back to true after a gen-off.
      if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if (prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if (Date.now() - lastLimitScan > 1000) {
        lastLimitScan = Date.now();
        const ctx = P.scanError();
        if (ctx) return { kind: "context_limit", detail: ctx };
      }

      // Keep waiting while a tool command is still being streamed (opener written
      // but no end marker yet) so we never parse/finalize half a command.
      const blockActive = RSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
      // ...but once generation has clearly stopped (stop indicator gone past the
      // grace window), stop honoring an "open block" - it is DOM churn, not live
      // streaming. Lets a finished big block finalise in seconds instead of
      // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
      // live on Gemini after a mid-write halt) but the text has been frozen for
      // a while → stop waiting and finalize. This must BYPASS the gen branch
      // below entirely: falling through while gen stays true used to reset
      // doneSince every iteration, so the watcher never finalized at all.
      // ...but NEVER treat a still-OPEN command block as "done" while the site is
      // genuinely still generating. A model writing a big command (a 3799-char
      // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
      // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
      // here parsed the half-written JSON and stamped a false "bad JSON" error
      // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
      const stuckDone = started && d.reply && Date.now() - lastChangeAt > STABLE_MS &&
        !(gen && RSParse.hasOpenToolBlock(d.reply));
      if ((gen || effectiveBlock) && !stuckDone) {
        // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
        // so any wait here is tail latency: either gen flickered back on, or an
        // (effective) open-block reading is holding us.
        if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
        doneSince = 0;
        await sleep(160);
        continue;
      }
      if (stuckDone && gen) log("generating flag stuck - falling back to text stability");

      // On providers whose turn counts are RELIABLE (semantic elements, no
      // list virtualisation - Gemini), never finalize before the reply turn
      // for THIS send exists. The generating flag can flicker off in the gap
      // between the send and the new <model-response> node spawning, and the
      // watcher used to finalize on the PREVIOUS turn's stable text - a
      // premature loop.end rescued only by autoResume 30-45s later (diag
      // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
      // Bounded so a genuinely dead send still ends the turn.
      if (P.reliableCounts && !newReply) {
        if (!noTurnSince) noTurnSince = Date.now();
        // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
        // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
        // that decide it so we can see whether curTok is null (id missing on the new
        // turn -> count fallback) or equal to sendToken (last turn not advancing).
        const _waited = Date.now() - noTurnSince;
        if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
          A._noTurnLoggedAt = Date.now();
          diag("noTurnGrace.wait", {
            waitedMs: _waited,
            curTok: (P.lastAssistantId ?  P.lastAssistantId() : undefined),
            sendToken: A.sendToken,
            assistantCount: P.assistantCount ?  P.assistantCount() : undefined,
            base, gen, started, replyLen: (d.reply || "").length });
        }
        if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
      } else {
        noTurnSince = 0;
        A._noTurnLoggedAt = 0;
      }

      if (!doneSince) doneSince = Date.now();
      if (Date.now() - doneSince < 500) {  // 500ms settle – DOM is stable
        await sleep(120);
        continue;
      }

      // A turn that has produced NOTHING yet is still warming up - never
      // finalize it as empty/truncated/text (a premature retry interrupts it).
      if (!sawContent) {
        if (!warmSince) warmSince = Date.now();
        if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
        // Late-reply rescue (v1.12): unstable sites under load often render the
        // reply a beat AFTER the warm-up deadline. One bounded 12s look before
        // declaring the turn dead - cheap, and it turns "the model did nothing"
        // into a normal continuation on exactly the flaky providers.
        if (!lateRescue) {
          lateRescue = true;
          diag("empty.lateRescue", { waitedMs: Date.now() - warmSince });
          const rescueT0 = Date.now();
          while (Date.now() - rescueT0 < 12000 && !A.stop) {
            await sleep(250);
            const rd = P.readAssistant();
            if ((rd.reply && rd.reply.length) || (rd.thinking && rd.thinking.length)) {
              sawContent = true;
              d = rd;
              warmSince = 0;
              break;
            }
          }
          if (sawContent) continue;
        }
        diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
        return { kind: "empty" };
      }

      // Still REASONING / loading: thinking written but no answer yet. Don't
      // finalize - wait for the reply, bounded. A manually-stopped turn is
      // exempt so a real stop still ends.
      if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !P.turnHalted(d.item)) {
        if (!reasonSince) reasonSince = Date.now();
        if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      // Blank-read guard: if THIS read came back empty but the same turn had
      // real text a tick ago, classify that text - see lastGoodReply above.
      let r = d.reply;
      if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
      // "Conversation too long" / "server busy" notices are always SHORT system
      // messages; gating on a short reply stops the model's own long output
      // (which may quote those phrases) from tripping them.
      if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
      // Hold off on any "unparseable command" verdict while the provider reports
      // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
      // case: its network tap flips `done` the instant the SSE ends, but the
      // candidate-1 DOM we parse can still be mid-render, so a real command looks
      // half-written for a beat. Firing parse_error there sends an ERROR
      // mid-generation and nags a model that did nothing wrong. Only guard when
      // the reply already LOOKS like a command (so a plain-text answer is never
      // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
      // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
      const cmdShaped = P.replyUnsettled && (
        RSParse.hasToolSignature(r) ||
        (RSParse.LUA_END_RE.test(r) && !RSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if (cmdShaped && P.replyUnsettled(d.item)) {
        if (!unsettledSince) unsettledSince = Date.now();
        if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(250); continue; }
      } else {
        unsettledSince = 0;
      }
      // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
      // composer from the DOM (validated live: getEditor() is null), so we can't
      // send the tool result until a candidate is picked - and the read reply is a
      // partial candidate, so a command there looks "cut off". Per the product rule
      // we use the FIRST candidate: wait for BOTH candidates to finish generating
      // (you can't select mid-stream), then auto-select Response 1. That collapses
      // the carousel to a normal turn - composer returns - and the normal parse/run
      // path below handles it. Never a parse_error here (the model didn't truncate).
      // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
      // stuck carousel, so this cannot hang.
      if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
        if (P.isGenerating()) { await sleep(250); continue; }   // both still writing
        if (P.resolveComparison && P.resolveComparison()) {
          diag("carousel.resolved");
          await sleep(400); continue;                            // let it collapse, re-read
        }
        await sleep(250); continue;                              // button not ready yet
      }
      if (RSParse.hasToolSignature(r)) {
        const calls = RSParse.parseToolCalls(r);
        if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
        // A half-written command + the site's "Continue" button means the command
        // was truncated mid-stream → resume it rather than reporting bad JSON.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        // Only fire parse_error if explicit markers were present.
        if (r.includes(RSParse.START_M) || RSParse.LUA_START_RE.test(r)) return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        // A command opener with no closer (a JSON object that never closed -
        // the model was halted mid-write and there is no Continue affordance):
        // ask the model to rewrite it instead of silently ending the turn.
        // ...unless ONLY the trailing closers were lost (the model hit its
        // output limit with the payload complete - seen live on Qwen: a big
        // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
        // and runs it instead of burning a whole retry turn; it refuses any
        // cut that amputated real content (mid-string / deep deficit), which
        // still falls through to the parse_error feedback. Safe to run here:
        // generation has ended (the open-block branch above kept waiting
        // while it streamed).
        if (RSParse.hasOpenToolBlock(r)) {
          const saved = RSParse.salvageCutOff(r);
          if (saved) {
            diag("tool.salvaged", { name: saved.tool });
            finalizeDiag("tool");
            return { kind: "tool", calls: [saved], item: d.item };
          }
          return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
        }
        // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
        // to parse - typically an unescaped " inside a code/string param broke the
        // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
        // mid-code). Unlike execute_luau there is NO ###LUA### fallback, so the
        // command silently dropped and the loop finalized the turn as a plain-text
        // answer with no result and no error - a dead turn. Fire a parse_error so
        // the model can fix its JSON. GATED on a known command name so prose that
        // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
        // placeholder like "command_name") is NOT misread as a broken command and
        // looped on - only a real tool name means a genuine failed call.
        const nm = RSParse.toolNameFromText(r);
        if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
          return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
        }
      }
      // Malformed execute_luau: the model wrote the ###END_LUA### closer but
      // FORGOT the ###LUA### opener, so hasToolSignature missed it and the block
      // never ran (seen on Gemini). Don't silently treat it as a final answer -
      // nudge a rewrite instead of leaving the user stuck on a dead turn.
      if (RSParse.LUA_END_RE.test(r) && !RSParse.LUA_START_RE.test(r) && !r.includes(RSParse.START_M)) {
        return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
      }
      // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
      // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
      // the required {"command":...,"params":...} envelope - it treated the tool as a
      // real callable function (seen on Gemini). Those argument keys never appear in a
      // normal prose answer, so nudge a rewrite rather than ending the turn silently.
      if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r)) {
        return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
      }
      // Malformed command, function-calling flavour: the model named a REAL tool
      // but under the WRONG KEY - {"toolName": "get_studio_state", "studio_id": …}
      // instead of {"command": …, "params": {…}}. It reads as a deliberate call,
      // yet hasToolSignature never fires (no "command" key, no markers) and the
      // argument keys are the tool's own, so neither guard above catches it: the
      // turn finalized as a plain-text answer and the loop ENDED with the user
      // watching a dead agent (seen live on ChatGPT, long session, 2026-08).
      // GATED on the value being a tool we actually have - same reasoning as the
      // toolNameFromText gate above, so prose that merely mentions a tool name in
      // some JSON example is never looped on.
      const wrongKey = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/.exec(r);
      if (wrongKey && !/"command"\s*:/.test(r)) {
        const wk = wrongKey[1];
        const hit = knownTool(wk);
        // Log the miss too: the gate depends on how the bridge ADVERTISES names
        // (they can be prefixed per server on a collision), so a silent no-match
        // is exactly the case that is impossible to diagnose after the fact.
        diag("cmd.wrongKey", { name: wk, known: hit, catalogue: A.toolNames.size });
        if (hit) return { kind: "parse_error", reason: "toolKey", raw: r, item: d.item };
      }
      // NOTE: a site "server busy / something went wrong" notice is deliberately
      // NOT special-cased. It falls through to kind:"text" below and simply ENDS
      // the loop as a final answer - no auto-retry. Retrying risked an infinite
      // re-answer loop when the model's OWN prose said "try again", and treating
      // busy as a normal terminal turn is cleaner: the user just re-sends if the
      // site actually hiccuped. (P.isBusyMsg stays on the provider interface,
      // unused by the core, in case a future flow wants it.)
      // The site caps output length and shows a native "Continue" button when it
      // truncates. We try clicking it directly (same turn) in the loop.
      if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
      if (r === "") { diag("empty.why", { branch: "finalBlank" }); return { kind: "empty" }; }
      return { kind: "text", text: r };
    }
    return { kind: "timeout" };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local OR bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = (m) =>
    /Extension context invalidated|Receiving end does not exist|message port closed/i.test(m || "");

  function bg(msg) {
    return new Promise((resolve) => {
      const fail = (m) => resolve({
        ok: false,
        kind: isContextInvalidated(m) ? "stale-extension" : "disconnected",
        error: m,
      });
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) fail(chrome.runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (e) {
        fail(String(e && e.message || e));
      }
    });
  }

  // 'subagent' is always blocked (long-running, hangs the loop). 'screen_capture'
  // is only blocked on providers whose underlying model can't see images
  // (P.supportsVision === false) - see providers/*.js for the per-site flag.
  // Both are filtered out of the advertised command list AND refused in runTool.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  const ALWAYS_BLOCKED_TOOLS = new Set(["subagent"]);
  const VISION_TOOLS = new Set(["screen_capture"]);
  // Captures need an or-agent that carries MCP image content items through the
  // bridge (and, for Blender, the binary read-back). An older or-agent.exe
  // fails these SILENTLY - Studio answers a capture with an image item only, so
  // the old bridge forwards ok + empty text. Every capture failure therefore
  // names the build, so a stale binary is never mistaken for a broken Studio.
  const AGENT_CAPTURE_MIN = "1.18.1";
  function agentVersionBelow(version, min) {
    const m = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return true;                         // unknown ⇒ assume old
    const cur = [Number(m[1]), Number(m[2]), Number(m[3])];
    const tgt = min.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (cur[i] !== tgt[i]) return cur[i] < tgt[i];
    return false;
  }
  // A capture that answers "ok" with NO text and NO image means the picture died
  // on its way to us. WHICH fix applies is visible from the tool list: the
  // Python host (Start OR Agent.bat) advertises or_host_read_image, so
  // Studio's 27 tools become 28. No host + an old agent = the bytes are being
  // dropped inside or-agent.exe; host present = Studio itself sent no picture.
  function captureFailureHint(name) {
    const n = A.toolNames.size;
    // Version first: a 1.18.1+ agent carries Studio's MCP images itself, so with
    // a current build the Python host (and its 28th tool) is NOT required - a
    // capture that still comes back empty means Studio produced no picture.
    const v = String((A.bridge && A.bridge.agent_version) || "");
    if (!agentVersionBelow(v, AGENT_CAPTURE_MIN)) {
      ui.banner("warn", "Studio returned no picture",
        "The agent is current, so check Studio: Manage MCP Servers, and that the place is open.");
      return `ERROR calling '${name}': the capture came back with no text and no image, but the running agent ` +
        `(v${v}) does carry MCP images - so Studio itself produced no picture. Open the place in Studio and check ` +
        `Assistant -> Manage MCP Servers -> "Enable Studio as MCP Server", then call ${name} again. ` +
        `(A leftover StudioMCP.exe holding port 13469 also does this - close Studio fully, kill StudioMCP.exe in Task Manager, reopen Studio.)`;
    }
    const hostUp = A.toolNames.has("or_host_read_image");
    if (!hostUp) {
      ui.banner("warn", "Studio captures need the Python host",
        'Close OR, then start it with "Start OR Agent.bat" instead of or-agent.exe.');
      return `ERROR calling '${name}': the capture came back with no text and no image. ` +
        `TOOLS ${n} (the Python host would add a 28th tool), so the old or-agent.exe dropped the picture: ` +
        `either it was started without the host, or an old process still owns port 3000. Best fix: use the rebuilt ` +
        `or-agent.exe from the repo (no host needed). Otherwise close OR and run "Start OR Agent.bat", ` +
        `then call ${name} again.`;
    }
    return `ERROR calling '${name}': the capture came back with no text and no image. ` +
      `The Python host IS running (TOOLS ${n}), so Studio itself returned no picture: open the place in Studio and check ` +
      `Assistant -> Manage MCP Servers -> "Enable Studio as MCP Server", then call ${name} again.`;
  }

  function agentBuildNote() {
    const v = String((A.bridge && A.bridge.agent_version) || "");
    const label = v ? `agent v${v}` : "agent version unknown (an older build)";
    if (!agentVersionBelow(v, AGENT_CAPTURE_MIN)) {
      return ` (${label} - which is current, so the bridge is not the problem: check the MCP link inside Studio itself).`;
    }
    return ` (${label}). No install needed: start the agent with "Start OR Agent.bat" instead of or-agent.exe - ` +
      `it runs Studio's MCP through studio_mcp_host.py (the Python host that ships with ORscript, the same trick ` +
      `ZeroScript uses), which hands captures back as images on the exe you already have. Or rebuild: ` +
      `"cd agent && cargo build --release", copy agent/target/release/or-agent.exe over the old one, restart it. ` +
      `Open http://127.0.0.1:3000/ to see which build is actually running - 1.18.0 = the old committed exe, 1.18.1 = the fixed one.`;
  }
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  // The ONLY sanctioned way to read the active engine outside build()'s closure.
  // Returns exactly "roblox" | "local". Legacy "anim" storage maps onto Roblox
  // (animation tools + Motion tab live on RS now).
  const activeEngine = () => {
    try {
      const v = typeof window.__rsEngine === "function" ? window.__rsEngine() : null;
      return v === "local" ? "local" : "roblox";
    } catch { return "roblox"; }
  };
  const isStudioEngine = (eng = activeEngine()) => eng !== "local";
  // Ground-truth environment line appended to EVERY AgentScript tool result.
  // Long creative tasks wipe tool awareness out of a chat model's active
  // memory ("context decay") - this tag survives because it rides inside each
  // result, so the model can never claim the local engine is gone.
  function asStateTag() {
    try {
      const local = activeEngine() === "local";
      const eng = local ? "AGENTSCRIPT" : "ROBLOXSCRIPT";
      const n = A.toolList.length || 0;
      const bridge = A.bridge || {};
      const connected = bridge.connected === true;
      let extra = "OFF", plan = "OFF", lvl = "default", wm = "balanced", perm = "sandbox", dbg = "ON", multi = "OFF";
      try { if (window.__rsExtraThinking && window.__rsExtraThinking()) extra = "ON"; } catch {}
      try { if (window.__rsPlanMode && window.__rsPlanMode()) plan = "ON"; } catch {}
      try { if (window.__rsAutoDebug && window.__rsAutoDebug() === false) dbg = "OFF"; } catch {}
      try { if (window.__rsMultiAgent && window.__rsMultiAgent()) multi = "ON"; } catch {}
      try { lvl = (window.__rsThinkingLevel && window.__rsThinkingLevel()) || "default"; } catch {}
      try { wm = (window.__rsWorkMode && window.__rsWorkMode()) || "balanced"; } catch {}
      try { perm = (window.__rsPermMode && window.__rsPermMode()) || "sandbox"; } catch {}
      const blender = !!bridge.blender;
      let env = "";
      if (local) {
        const root = typeof bridge.local_root === "string" ? bridge.local_root : "";
        const full = bridge.local_full === true;
        env = ` | WORKSPACE ${root || "active"} | ${full ? "FULL PC" : "SANDBOX"}`;
      } else {
        env = connected ? " | STUDIO LINKED" : " | STUDIO UNLINKED";
      }
      return `[SYSTEM_STATE: ENGINE=${eng} | WORK=${wm} | EXTRA=${extra} | PLAN=${plan} | DEBUG=${dbg} | MULTI=${multi} | THINK=${lvl} | PERM=${perm}${env} | BRIDGE ${connected ? "UP" : "DOWN"} | BLENDER ${blender ? "ON" : "OFF"} | TOOLS ${n}]\nMODE LOCK: stay on ${eng}. Obey WORK/EXTRA/PLAN/THINK/DEBUG/MULTI this turn. ONE command per reply.\n${(RS.FEEDBACK && RS.FEEDBACK.creationFocus) || ""}`;
    } catch { return ""; }
  }
  // Is `name` a tool we actually have? The bridge ADVERTISES names that may carry
  // a per-server prefix when two MCP servers expose the same tool (see
  // list_tools in bridge.py), while the model always writes the bare name - so a
  // plain `A.toolNames.has(bare)` misses, and so does bareToolName(bare), which
  // cannot re-add a prefix it never had. Compare bare-to-bare in BOTH directions.
  const bareKey = (n) => String(n || "").split("/").pop().split(".").pop();
  function knownTool(name) {
    if (!name || !A.toolNames.size) return false;
    if (A.toolNames.has(name) || A.toolNames.has(bareToolName(name))) return true;
    const b = bareKey(name);
    for (const t of A.toolNames) if (bareKey(t) === b) return true;
    return false;
  }
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    if (VISION_TOOLS.has(bare) && !P.supportsVision) return true;
    return false;
  };

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known Roblox vision tool (screen_capture) is themed "screen" by name via
  // RS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ rsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("rsImageTools", (r) => {
      if (r && Array.isArray(r.rsImageTools)) for (const n of r.rsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // How long a fetched catalogue stays good enough to reuse without a round trip.
  const TOOLS_TTL_MS = 30000;

  // Refresh the tool catalogue - but never pay for it twice in a row.
  //
  // DEGRADED MODE (Roblox Studio closed, running on an addon server like Blender)
  // is where this used to hurt: a list_tools whose Roblox half is dead blocks the
  // bridge until it gives up, and the extension waited the FULL background timeout
  // for it. The boot sequence calls this three times in a row - startSession(),
  // then the model's list_commands, then list_mcp_servers - so the user watched
  // ~a minute of dead air with the model's reply already finished on screen
  // ("the first commands take forever even though the model clearly stopped
  // writing"). A short TTL collapses those three calls into one, and the caller
  // keeps the catalogue it already has instead of stalling for a fresh one.
  // ── Script Preview Engine (static Luau/Python analysis) ──────────────────
  // Validates scripts BEFORE sending them to the bridge, catching syntax errors,
  // unbalanced blocks, common pitfalls, and size issues locally — zero latency,
  // no wasted Studio round-trip. The AI can also call it explicitly via
  // preview_script to self-check before committing.
  function luauAnalyze(code) {
    const issues = [];
    const warnings = [];
    const info = [];
    if (!code || !code.trim()) { issues.push("Script is empty"); return { issues, warnings, info, ok: false }; }
    const lines = code.split("\n");
    const trimmed = code.trim();

    // 1. Size check — Roblox parser rejects very large scripts
    if (code.length > 60000) issues.push(`Script is ${code.length} chars — Roblox parser may reject scripts over ~64KB. Split into smaller calls.`);
    else if (code.length > 40000) warnings.push(`Script is ${code.length} chars — approaching parser limits.`);

    // 2. Block matching (function/if/for/while/do ↔ end)
    const openers = { function: 0, if: 0, for: 0, while: 0, do: 0 };
    const closers = { end: 0, until: 0 }; // until for repeat
    let inString = null, inComment = false, depthLongBracket = 0;
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      // Strip strings (simple approach: remove quoted content)
      let clean = line
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/\[\=*\[/g, "[[")
        .replace(/\]=*\]/g, "]]");
      // Strip comments
      clean = clean.replace(/--.*$/, "");
      // Count block keywords (word-boundary match)
      const words = clean.toLowerCase().match(/\b(function|if|for|while|do|end|then|repeat|until|elseif|else)\b/g) || [];
      for (const w of words) {
        if (w === "function" || w === "if" || w === "for" || w === "while") openers[w]++;
        if (w === "do" && !/\bfor\b.*\bdo\b/.test(clean.toLowerCase()) && !/\bwhile\b.*\bdo\b/.test(clean.toLowerCase())) openers.do++;
        if (w === "end") closers.end++;
        // then/elseif/else don't open or close blocks — they're part of if blocks
      }
      // repeat/until pairs
      if (/\brepeat\b/i.test(clean)) openers.do++;
      if (/\buntil\b/i.test(clean)) closers.until++;
    }
    const totalOpen = openers.function + openers.if + openers.for + openers.while + openers.do;
    const totalClose = closers.end + closers.until;
    if (totalOpen > totalClose) issues.push(`${totalOpen - totalClose} unclosed block(s) — missing 'end' keyword(s). Check function/if/for/while/do blocks.`);
    else if (totalClose > totalOpen) issues.push(`${totalClose - totalOpen} extra 'end' keyword(s) — more ends than opened blocks.`);

    // 3. Paren/bracket/brace matching
    let parens = 0, brackets = 0, braces = 0;
    for (const ch of code.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/'(?:[^'\\]|\\.)*'/g, "").replace(/--.*$/gm, "")) {
      if (ch === "(") parens++; else if (ch === ")") parens--;
      else if (ch === "[") brackets++; else if (ch === "]") brackets--;
      else if (ch === "{") braces++; else if (ch === "}") braces--;
    }
    if (parens !== 0) issues.push(`${Math.abs(parens)} unmatched ${parens > 0 ? "opening" : "closing"} parenthesis '${parens > 0 ? "(" : ")"}'.`);
    if (brackets !== 0) issues.push(`${Math.abs(brackets)} unmatched square bracket '${brackets > 0 ? "[" : "]"}'.`);
    if (braces !== 0) warnings.push(`${Math.abs(braces)} unmatched curly brace '${braces > 0 ? "{" : "}"}' (may be intentional in table constructors).`);

    // 4. Common pitfalls
    if (/^\s*print\(/m.test(code) && !/\breturn\b/.test(code))
      warnings.push("Script uses print() but has no return — print output is NOT captured. Add a `return` statement.");
    if (/WaitForChild\(\s*["'][^"']+["']\s*\)/.test(code) && !/WaitForChild\(\s*["'][^"']+["']\s*,/.test(code))
      warnings.push("WaitForChild without timeout can hang the 20s budget. Use WaitForChild(\"Name\", 5).");
    if (/\btask\.wait\(\)|\bwait\(\)/.test(code))
      warnings.push("wait()/task.wait() detected — execute_luau has a ~20s budget and cannot yield. Move waits to a real Script.");
    if (/game\.(Workspace|Lighting|ReplicatedStorage|ServerScriptService|ServerStorage|StarterGui|Players|SoundService|TweenService)\b/.test(code) && !/game:GetService/.test(code))
      info.push("Tip: use game:GetService(\"Name\") instead of game.Name for reliable service access.");
    if (/HttpService/i.test(code) && !/game:GetService/.test(code))
      warnings.push("HttpService detected — HTTP calls cannot run in execute_luau (they yield). Use a Script instance instead.");
    if (/\.Parent\s*=\s*script\.Parent/.test(code) && !/Instance\.new/.test(code))
      info.push("Setting .Parent without Instance.new — make sure the object you're parenting already exists.");

    // 5. Quick stats
    info.push(`${lines.length} lines, ${code.length} chars`);

    return { issues, warnings, info, ok: issues.length === 0, lines: lines.length, chars: code.length };
  }


  // Auto-chunk execute_luau at ~24KB so Studio's parser never hits the ~64KB wall.
  // Each piece is still one JSON-RPC/NDJSON line on the wire (no multi-line payloads).
  const LUAU_CHUNK_MAX = 18000;
  function splitLuauChunks(code, max) {
    if (!code || code.length <= max) return null;
    const lines = code.split("\n");
    const chunks = [];
    let buf = "";
    for (const line of lines) {
      if (buf.length + line.length + 1 > max && buf.length) { chunks.push(buf); buf = line; }
      else buf = buf ? buf + "\n" + line : line;
    }
    if (buf) chunks.push(buf);
    const out = [];
    for (const c of chunks) {
      if (c.length <= max) out.push(c);
      else { for (let i = 0; i < c.length; i += max) out.push(c.slice(i, i + max)); }
    }
    return out.length > 1 ? out : null;
  }
  // Embed `s` as a Luau long-string. StudioMCP parses execute_luau as REAL Luau,
  // so JSONDecode(JSON.stringify(s)) used to blow up on quotes/newlines/] =] and
  // show "Failed to parse command code". A long-string needs no escaping.
  function luauLongStr(s) {
    let n = 0;
    while (String(s).includes("]" + "=".repeat(n) + "]")) n++;
    const eq = "=".repeat(n);
    // A newline right after [[ is ignored by Lua, so the payload is byte-exact.
    return "[" + eq + "[\n" + s + "]" + eq + "]";
  }
  function wrapLuauChunk(piece, i, n) {
    const lit = luauLongStr(piece);
    const nl = "\n";
    if (i === 0 && n > 1) {
      return [
        "local ss=game:GetService(\"ServerStorage\")",
        "local f=ss:FindFirstChild(\"_ORLuau\") or Instance.new(\"Folder\")",
        "f.Name=\"_ORLuau\"; f.Parent=ss",
        "local m=f:FindFirstChild(\"Buf\") or Instance.new(\"StringValue\")",
        "m.Name=\"Buf\"; m.Parent=f",
        "m.Value=" + lit,
        "return \"OR chunk 1/" + n + " stored (" + piece.length + " chars)\"",
      ].join(nl);
    }
    if (i < n - 1) {
      return [
        "local f=game:GetService(\"ServerStorage\"):FindFirstChild(\"_ORLuau\")",
        "local m=f and f:FindFirstChild(\"Buf\")",
        "if not m then error(\"OR chunk buffer missing\") end",
        "m.Value=m.Value.." + lit,
        "return \"OR chunk " + (i + 1) + "/" + n + " stored\"",
      ].join(nl);
    }
    return [
      "local ss=game:GetService(\"ServerStorage\")",
      "local f=ss:FindFirstChild(\"_ORLuau\")",
      "local m=f and f:FindFirstChild(\"Buf\")",
      "if not m then error(\"OR chunk buffer missing\") end",
      "m.Value=m.Value.." + lit,
      "local src=m.Value",
      "if f then f:Destroy() end",
      "local fn,err=loadstring(src)",
      "if not fn then error(\"chunked luau parse: \"..tostring(err)) end",
      "return fn()",
    ].join(nl);
  }

  function pythonAnalyze(code) {
    const issues = [];
    const warnings = [];
    if (!code || !code.trim()) { issues.push("Script is empty"); return { issues, warnings, info: [], ok: false }; }
    // Indentation check (mixed tabs/spaces)
    if (/^\t/m.test(code) && /^ {2}/m.test(code)) warnings.push("Mixed tabs and spaces in indentation.");
    // Unmatched parens
    let parens = 0;
    for (const ch of code.replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "").replace(/#.*$/gm, "")) {
      if (ch === "(") parens++; else if (ch === ")") parens--;
    }
    if (parens !== 0) issues.push(`${Math.abs(parens)} unmatched parenthesis.`);
    return { issues, warnings, info: [], ok: issues.length === 0 };
  }

  // Format preview results for the AI
  function formatPreview(lang, analysis, code) {
    const parts = [`Preview of ${lang} script (${analysis.lines || code.split("\n").length} lines, ${analysis.chars || code.length} chars):`];
    if (analysis.ok) parts.push("✅ SYNTAX OK — no blocking issues found.");
    else { parts.push(`❌ ${analysis.issues.length} ERROR(S):`); analysis.issues.forEach((iss, i) => parts.push(`  ${i + 1}. ${iss}`)); }
    if (analysis.warnings.length) { parts.push(`⚠️ ${analysis.warnings.length} WARNING(S):`); analysis.warnings.forEach((w, i) => parts.push(`  ${i + 1}. ${w}`)); }
    if (analysis.info.length) { parts.push("ℹ️ Notes:"); analysis.info.forEach((n) => parts.push(`  ${n}`)); }
    if (!analysis.ok) parts.push("\nFix the errors above before executing. Use preview_script again to verify.");
    return parts.join("\n");
  }

  // ── end Script Preview Engine ────────────────────────────────────────────

  async function ensureTools(force) {
    if (!force && A.toolList.length && Date.now() - A.toolsAt < TOOLS_TTL_MS) {
      diag("tools.cached", { age: Date.now() - A.toolsAt, n: A.toolList.length });
      return A.toolList;
    }
    const t0 = Date.now();
    // Bounded retry: right after a page load or an engine switch the bridge
    // WebSocket may still be handshaking, so a single list_tools can come back
    // empty and falsely fail the bootstrap. Poll until tools arrive or ~8s.
    let r = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      r = await bg({ type: "list_tools" });
      if (r && r.tools && r.tools.length) break;
      // Engine-offline answers are AUTHORITATIVE (Studio closed etc.) — don't
      // spin on them; only transient empties (handshake races) are retried.
      if (r && r.ok === false && r.error && /offline|not connected|closed/i.test(r.error)) break;
      await new Promise((res) => setTimeout(res, 650));
    }
    diag("tools.fetched", { ms: Date.now() - t0, n: (r && r.tools && r.tools.length) || 0 });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools.filter((t) => !isBlockedTool(t.name));
      A.toolList = tools;
      A.toolNames = new Set(tools.map((t) => t.name));
      A.toolsAt = Date.now();
    }
    return A.toolList;
  }

  function luauLiteral(v) {
    if (v == null) return "nil";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "{" + v.map(luauLiteral).join(",") + "}";
    const parts = [];
    for (const [k, val] of Object.entries(v)) {
      const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : ("[" + JSON.stringify(k) + "]");
      parts.push(key + "=" + luauLiteral(val));
    }
    return "{" + parts.join(",") + "}";
  }

  function studioMeshLuau(meshes, dest, scale) {
    const payload = luauLiteral({ meshes: meshes || [], dest: dest || "Workspace", scale: Number(scale) || 20 });
    return [
      "local AssetService = game:GetService(\"AssetService\")",
      "local payload = " + payload,
      "local meshes = payload.meshes or {}",
      "local scale = tonumber(payload.scale) or 20",
      "local destName = tostring(payload.dest or \"Workspace\")",
      "local parent = workspace",
      "if destName ~= \"Workspace\" and destName ~= \"workspace\" then",
      "  local t = workspace:FindFirstChild(destName)",
      "  if t then parent = t end",
      "end",
      "local folder = parent:FindFirstChild(\"OR_Imported\")",
      "if folder then folder:Destroy() end",
      "folder = Instance.new(\"Model\")",
      "folder.Name = \"OR_Imported\"",
      "folder.Parent = parent",
      "local built = 0",
      "local usedEditable = false",
      "local function aabb(verts)",
      "  local minx,miny,minz = math.huge, math.huge, math.huge",
      "  local maxx,maxy,maxz = -math.huge, -math.huge, -math.huge",
      "  for _,v in ipairs(verts) do",
      "    local x,y,z = (v[1] or 0)*scale, (v[2] or 0)*scale, (v[3] or 0)*scale",
      "    if x<minx then minx=x end if y<miny then miny=y end if z<minz then minz=z end",
      "    if x>maxx then maxx=x end if y>maxy then maxy=y end if z>maxz then maxz=z end",
      "  end",
      "  return Vector3.new((minx+maxx)/2,(miny+maxy)/2,(minz+maxz)/2), Vector3.new(math.max(0.05,maxx-minx), math.max(0.05,maxy-miny), math.max(0.05,maxz-minz))",
      "end",
      "local function addTri(em, ids, a, b, c)",
      "  if not ids[a] or not ids[b] or not ids[c] then return end",
      "  pcall(function() em:AddTriangle(ids[a], ids[b], ids[c]) end)",
      "end",
      "for _,entry in ipairs(meshes) do",
      "  local verts, faces = entry.verts or {}, entry.faces or {}",
      "  local name = tostring(entry.name or \"Mesh\")",
      "  local part",
      "  local okEm, em = pcall(function() return AssetService:CreateEditableMesh() end)",
      "  if okEm and em then",
      "    local ids = {}",
      "    for i,v in ipairs(verts) do",
      "      local x,y,z = (v[1] or 0)*scale, (v[2] or 0)*scale, (v[3] or 0)*scale",
      "      local okv, id = pcall(function() return em:AddVertex(Vector3.new(x,y,z)) end)",
      "      if okv then ids[i] = id ids[i-1] = id end",
      "    end",
      "    for _,f in ipairs(faces) do",
      "      if #f >= 3 then",
      "        for i=2,#f-1 do addTri(em, ids, f[1], f[i], f[i+1]) end",
      "      end",
      "    end",
      "    local okPart, mp = pcall(function()",
      "      if Content and Content.fromObject then return AssetService:CreateMeshPartAsync(Content.fromObject(em)) end",
      "      return AssetService:CreateMeshPartAsync(em)",
      "    end)",
      "    if okPart and mp then part = mp usedEditable = true end",
      "  end",
      "  if not part then",
      "    local cf, size = aabb(verts)",
      "    part = Instance.new(\"Part\")",
      "    part.Size = size",
      "    part.CFrame = CFrame.new(cf)",
      "    part.Anchored = true",
      "    part.Material = Enum.Material.SmoothPlastic",
      "  end",
      "  part.Name = name",
      "  part.Anchored = true",
      "  part.Parent = folder",
      "  built += 1",
      "end",
      "pcall(function() if folder.GetPivot then folder:PivotTo(CFrame.new(0, 3, 0)) end end)",
      "local how = usedEditable and \"EditableMesh\" or \"bounding-box Parts (EditableMesh unavailable)\"",
      "return string.format(\"imported %d mesh(es) into Workspace.OR_Imported via %s\", built, how)",
    ].join("\n");
  }

  async function runAssetBridgeImport(args) {
    const a = args || {};
    const asset = String(a.asset || a.filepath || a.path || "").trim();
    const dest = String(a.dest || a.parent || "Workspace");
    const scale = Number(a.scale) || 20;
    const assetLower = asset.toLowerCase();
    let assetId = "";
    const prefix = "rbxassetid://";
    if (assetLower.indexOf(prefix) === 0) assetId = asset.slice(prefix.length).replace(/\D/g, "");
    else if (/^\d+$/.test(asset)) assetId = asset;
    if (assetId && assetLower.indexOf(".fbx") < 0) {
      const id = assetId;
      const code = [
        "local id = " + id,
        "local ok, res = pcall(function() return game:GetService(\"InsertService\"):LoadAsset(id) end)",
        "if ok and res then res.Name = \"OR_Imported\"; res.Parent = workspace; return \"inserted rbxassetid://\"..id..\" as Workspace.OR_Imported\" end",
        "local p = Instance.new(\"MeshPart\")",
        "p.Name = \"OR_Imported\"",
        "p.Size = Vector3.new(4,4,4)",
        "p.Anchored = true",
        "pcall(function() p.MeshId = \"rbxassetid://\"..id end)",
        "p.Parent = workspace",
        "return \"created MeshPart with MeshId rbxassetid://\"..id..\" (LoadAsset: \"..tostring(res)..\")\"",
      ].join("\n");
      return await runTool({ tool: "execute_luau", arguments: { code, datamodel_type: "Edit" } });
    }
    if (!(A.bridge && A.bridge.blender)) {
      return "ERROR in asset_bridge_import: Connect Blender first. The addon must still be running so OR can read the mesh.";
    }
    const dump = await bg({ type: "call_tool", name: "blender_mesh_dump", arguments: { filepath: asset, asset, objects: a.objects }, timeout: 120000 });
    if (!dump || !dump.ok) {
      return "ERROR in asset_bridge_import: " + ((dump && dump.error) || "could not dump meshes from Blender");
    }
    let data = null;
    const textOut = String(dump.text || "");
    const mark = textOut.indexOf("OR_MESH_JSON:");
    try { data = JSON.parse(mark >= 0 ? textOut.slice(mark + 13) : textOut); } catch {}
    try { if (!data) data = JSON.parse(textOut); } catch {}
    let meshes = data && (data.meshes || (data.result && data.result.meshes));
    const meshPath = (data && data.mesh_file) || dump.meshFile || "or_mesh.json";
    if (!meshes || !meshes.length) {
      const file = await bg({ type: "local_read", path: meshPath });
      if (file && file.ok && file.text) {
        try {
          const parsed = JSON.parse(String(file.text).replace(/^\uFEFF/, "").trim());
          meshes = parsed.meshes || (parsed.result && parsed.result.meshes);
        } catch {}
      }
    }
    if (!meshes || !meshes.length) {
      return "ERROR in asset_bridge_import: Blender returned no meshes. Add or select mesh objects, then blender_send_to_studio.\n" + textOut.slice(0, 400);
    }
    const code = studioMeshLuau(meshes, dest, scale);
    return await runTool({ tool: "execute_luau", arguments: { code, datamodel_type: "Edit" } });
  }

  function wrapStudioTxn(code, label) {
    const lab = String(label || "OR").replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 48) || "OR";
    return "local __orChs=game:GetService(\"ChangeHistoryService\")\n" +
      "pcall(function() __orChs:SetEnabled(true) end)\n" +
      "pcall(function() __orChs:SetWaypoint(\"OR before " + lab + "\") end)\n" +
      "local __orOk,__orRes=pcall(function()\n" + String(code || "") + "\nend)\n" +
      "pcall(function() __orChs:SetWaypoint(\"OR " + lab + "\") end)\n" +
      "if not __orOk then error(tostring(__orRes)) end\n" +
      "return __orRes";
  }
  function compressToolFeedback(text, name) {
    const s = String(text || "");
    const MAX = 10000;
    if (s.length <= MAX) return s;
    return s.slice(0, 6500) + "\n[OR context compression: dropped " + (s.length - 9000) + " chars from " + String(name || "tool") + "]\n" + s.slice(-2500);
  }
  async function attachAutoDebug(toolName, feedback) {
    let on = true;
    try { if (window.__rsAutoDebug && window.__rsAutoDebug() === false) on = false; } catch {}
    if (!on) return feedback;
    try { if (activeEngine() === "local") return feedback; } catch {}
    if (!toolName || /^(or_|list_|get_|debug_|web_|status)/.test(String(toolName))) return feedback;
    if (String(feedback || "").startsWith("ERROR")) return feedback;
    const now = Date.now();
    if (A._debugBusy) return feedback;
    if (A._debugAt && now - A._debugAt < 10000) return feedback;
    A._debugBusy = true;
    A._debugAt = now;
    try {
      const code = [
        "local hs=game:GetService(\"HttpService\")",
        "local hist={}",
        "pcall(function() hist=game:GetService(\"LogService\"):GetLogHistory() end)",
        "local out={}",
        "for i=math.max(1,#hist-50),#hist do",
        " local e=hist[i]",
        " if e and (e.messageType==Enum.MessageType.MessageError or e.messageType==Enum.MessageType.MessageWarning) then",
        "  out[#out+1]=tostring(e.message or \"\"):sub(1,240)",
        " end",
        "end",
        "return hs:JSONEncode(out)",
      ].join("\n");
      const r = await Promise.race([
        bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 8000 }),
        new Promise((res) => setTimeout(() => res(null), 8000)),
      ]);
      const raw = r && r.ok ? String(r.text || "") : "";
      let lines = [];
      try { lines = JSON.parse(raw); } catch { lines = []; }
      if (!Array.isArray(lines) || !lines.length) return feedback;
      A._debugSigs = A._debugSigs || new Set();
      const fresh = [];
      for (const ln of lines) {
        const sig = String(ln).replace(/\d+/g, "#").slice(0, 160);
        if (A._debugSigs.has(sig)) continue;
        A._debugSigs.add(sig);
        fresh.push(String(ln).slice(0, 200));
      }
      if (!fresh.length) return feedback;
      return String(feedback) + "\n[AUTO DEBUG] New Studio errors/warnings:\n- " + fresh.slice(0, 6).join("\n- ") + "\nFix these next with the smallest command.";
    } catch {
      return feedback;
    } finally {
      A._debugBusy = false;
    }
  }
  async function undoStudioTxn() {
    const code = "local chs=game:GetService(\"ChangeHistoryService\")\npcall(function() chs:SetEnabled(true) end)\nif chs:GetCanUndo() then chs:Undo() return \"UNDONE\" end\nreturn \"NOTHING\"";
    try {
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 20000 });
      const text = String((r && (r.text || r.error)) || "");
      if (/UNDONE/.test(text)) {
        try { ui.toast("Undo — last Studio change reverted"); } catch {}
        return true;
      }
      if (r && r.ok === false) {
        try { ui.toast("Undo failed — " + String(r.error || "Studio not connected").slice(0, 80)); } catch {}
        return false;
      }
      try { ui.toast("Nothing to undo in Studio"); } catch {}
      return false;
    } catch (e) {
      try { ui.toast("Undo failed — " + String(e && e.message || e).slice(0, 80)); } catch {}
      return false;
    }
  }
  try { window.__rsUndo = undoStudioTxn; } catch {}

  function parseStudioIds(text) {
    const raw = String(text || "");
    const m = raw.match(/\{[^{}]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        return { gameId: Number(j.gameId || j.GameId || 0) || 0, placeId: Number(j.placeId || j.PlaceId || 0) || 0, name: String(j.name || "") };
      } catch {}
    }
    return { gameId: 0, placeId: 0, name: "" };
  }
  async function studioUniverseIds() {
    const code = 'local hs=game:GetService("HttpService") return hs:JSONEncode({gameId=tonumber(game.GameId) or 0,placeId=tonumber(game.PlaceId) or 0,name=tostring(game.Name or "")})';
    try {
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 15000 });
      if (r && r.ok) return parseStudioIds(r.text);
    } catch {}
    return { gameId: 0, placeId: 0, name: "" };
  }
  async function createDeveloperProduct(args) {
    const productName = String(args.name || args.title || "").trim();
    const price = Number(args.price || args.price_in_robux || args.robux || 0);
    const desc = String(args.description || args.desc || productName).trim();
    const reward = String(args.reward || "").trim();
    if (!productName) return "ERROR: developer_product_create needs name (the product title players see).";
    if (!Number.isFinite(price) || price < 1) return "ERROR: price must be Robux >= 1 (got " + String(args.price || args.price_in_robux || args.robux || "none") + ").";
    const ids = await studioUniverseIds();
    let universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    const r = await bg({ type: "create_dev_product", universeId: universe, placeId: Number(args.place_id || args.placeId || ids.placeId || 0) || 0, gameId: universe, name: productName, description: desc, priceInRobux: Math.floor(price) });
    if (!r || !r.ok) {
      return "ERROR: could not create developer product — could not reach the game. " + String((r && r.error) || "Sign into roblox.com in this Chrome profile, publish the place in Studio, then retry.");
    }
    universe = Number(r.universeId || universe) || universe;
    const prod = r.product || {};
    const pid = Number(prod.id || prod.productId || prod.developerProductId || r.productId || 0) || 0;
    let out = "Output of 'developer_product_create':\nCreated Developer Product \"" + productName + "\" — " + Math.floor(price) + " Robux.\nproduct_id=" + (pid || "(see payload)") + " universe_id=" + universe + "\n" + String(r.text || JSON.stringify(prod)).slice(0, 1200);
    if (pid && args.wire !== false) {
      try {
        const wired = await runTool({ tool: "marketplace_setup", arguments: { devproduct_id: pid, reward: reward || productName } });
        out += "\n\nWired ProcessReceipt:\n" + String(wired || "").slice(0, 800);
      } catch (e) {
        out += "\n(Product created. Wire it with marketplace_setup {devproduct_id: " + pid + "} if ProcessReceipt is missing.)";
      }
    } else if (pid) {
      out += "\nNext: marketplace_setup {devproduct_id: " + pid + ", reward: \"...\"} to grant the purchase.";
    }
    return out;
  }
  async function listDeveloperProducts(args) {
    const ids = await studioUniverseIds();
    let universe = Number(args.universe_id || args.universeId || args.universe || ids.gameId || 0) || 0;
    const r = await bg({ type: "list_dev_products", universeId: universe, placeId: Number(args.place_id || args.placeId || ids.placeId || 0) || 0, gameId: universe });
    if (!r || !r.ok) return "ERROR: could not list developer products. " + String((r && r.error) || "Sign into roblox.com in this Chrome profile.");
    return "Output of 'developer_product_list':\n" + String(r.text || JSON.stringify(r.products || r, null, 2)).slice(0, 4000);
  }

  async function runTool(call) {
    let name = call.tool;
    const args = call.arguments || {};
    if (!name) return RS.FEEDBACK.parseError("malformed");
    try { name = remapToolName(name); } catch {}
    if (condoLocked() && name !== "or_status" && name !== "status") {
      return "ERROR: CONDO LOCK is active. Commands are frozen until the lock expires. Do not retry condo-game requests.";
    }
    try {
      const blob = name + " " + JSON.stringify(args).slice(0, 8000);
      if (enforceCondo("tool:" + name, blob)) {
        return "ERROR: CONDO LOCK. Condo-game requests are blocked. Do not retry.";
      }
    } catch {}
    // NEVER execute while the AI tab is backgrounded/minimized. This is the single
    // choke point for ALL execution (agentLoop's tool dispatch AND the bootstrap's
    // list_commands), so it closes the hole the loop-entry gate alone left open:
    // the tab is foreground when a cycle starts, the model then generates for
    // 30-120s, the user minimizes MID-generation, and waitForResponse returns a
    // tool call that fired into Studio off-screen (observed live: GLM minimized
    // still ran execute_luau). Parking here (no time cap) means the call runs the
    // moment the tab is foreground again, instead of being lost or run blind.
    if (document.hidden && !A.stop) {
      diag("tool.waitVisible", { name });
      // Only reachable via a user Stop while parked; agentLoop's post-runTool
      // A.stop check breaks the loop and discards this, so it just needs to be
      // a non-crashing, clearly-labelled string.
      if (!(await waitVisible()) || A.stop) return "ERROR: the command was not run - stopped by the user.";
    }
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (VISION_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    if (permMode !== "full" && /^(process_kill)$/.test(bareName)) {
      return `ERROR: '${bareName}' needs Full PC access. Switch Permissions to Full in the OR menu, or stay in Sandbox.`;
    }
    if (permMode === "ask" && ASK_OPS.has(bareName)) {
      const ok = await requestApproval(bareName, args);
      if (!ok) return `ERROR in ${bareName}: the user declined this action (Ask mode). Do not retry unless they ask.`;
    }
    // Web tools — bridge-level, no Studio needed. Uses background fetch so it works
    // even when Studio is offline.
    if (bareName === "web_fetch" || bareName === "web_search") {
      let payload = { type: bareName, ...args };
      if (bareName === "web_fetch" && !payload.url && (payload.query || payload.q)) {
        payload = { type: "web_fetch", query: payload.query || payload.q, max_chars: payload.max_chars };
      }
      const r = await bg(payload);
      if (r && r.ok) return `Output of '${name}':\n${r.text}`;
      return `ERROR in ${name}: ${(r && r.error) || "fetch failed"}\nTry a different URL/query.`;
    }
    if (bareName === "developer_product_create" || bareName === "devproduct_create") {
      return await createDeveloperProduct(args);
    }
    if (bareName === "developer_product_list" || bareName === "devproduct_list") {
      return await listDeveloperProducts(args);
    }
    // Virtual command: list the MCP server(s) RobloxScript is currently connected
    // to, with each one's REAL per-server health (from the bridge, never the
    // merged tool count - a dead server must not borrow another's numbers).
    if (name === "list_mcp_servers") {
      await ensureTools();
      const curEng2 = activeEngine();
      const servers = (A.bridge && A.bridge.servers) || [];
        const engName = (e) => e === "local" ? "AgentScript workspace" : "Roblox Studio";
      const lines = servers.length
        ? servers.map((sv) => {
            const isPrimary = sv.id === curEng2;
            const label = isPrimary ?  `${engName(curEng2)} (primary)` : `${sv.id} (addon)`;
            return `- ${sv.id}: ${label} - ${sv.alive ?  `${sv.tools || 0} commands available` : "offline (no tools)"}`;
          })
        : [`- ${curEng2}: ${engName(curEng2)} (primary) - unknown (bridge did not report server health)`];
      return (
        `Output of 'list_mcp_servers':\n` +
        `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
        `Use list_commands with a "server" param (one of the ids above) to see that server's exact commands. Without "server", list_commands defaults to "${curEng2}".`
      );
    }
    // Virtual command: list available commands with full details. Defaults to
    // the primary server for the *current* engine — Roblox when RS/AN, AgentScript when AS.
    // A DIFFERENT server's tools only show up if the model asks via {"server": "<id>"}.
    if (name === "or_debug" || name === "debug_run" || name === "debug_console") {
      const code = [
        "local hs=game:GetService(\"HttpService\")",
        "local hist={}",
        "pcall(function() hist=game:GetService(\"LogService\"):GetLogHistory() end)",
        "local out={}",
        "for i=math.max(1,#hist-60),#hist do",
        " local e=hist[i]",
        " if e then out[#out+1]={t=tostring(e.messageType),m=tostring(e.message or \"\"):sub(1,240)} end",
        "end",
        "return hs:JSONEncode({count=#out,lines=out})",
      ].join("\n");
      const r = await bg({ type: "call_tool", name: "execute_luau", arguments: { code: code, datamodel_type: "Edit" }, timeout: 15000 });
      const raw = r && r.ok ? String(r.text || "") : ("ERROR: " + String((r && r.error) || "Studio log unavailable"));
      return "Output of 'or_debug':\n" + raw.slice(0, 4000) + "\nIf there are errors, fix with the smallest command (script_analysis / set_property / script_set_source).";
    }
    if (name === "or_agent" || name === "multi_agent") {
      const role = String(args.role || args.agent || "builder").toLowerCase();
      const task = String(args.task || args.prompt || args.goal || "").slice(0, 2000);
      A.agentRole = role;
      const briefs = {
        planner: "You are the PLANNER agent. Do NOT run mutating Studio commands this turn. Restate the user request as GOAL + implied systems, write a short numbered plan that ships a finished creation, then call or_agent {role:\"builder\", task:\"...\"}.",
        builder: "You are the BUILDER agent. Execute ONE Studio command that advances a finished, styled creation (not a stub). After it succeeds, call or_agent {role:\"reviewer\", task:\"verify\"} if Multi-Agent is on.",
        reviewer: "You are the REVIEWER agent. Use read-only commands (inspect, script_analysis, or_debug). List bugs. Then call or_agent {role:\"debugger\", task:\"...\"} if something is broken, else stop.",
        debugger: "You are the DEBUGGER agent. Read console via or_debug, then apply the smallest fix. Do not expand scope.",
      };
      const brief = briefs[role] || briefs.builder;
      return "Output of 'or_agent':\nROLE=" + role + "\n" + brief + "\nTASK: " + (task || "(continue the user's request)") + "\nReply as this agent only. ONE command.";
    }
    if (name === "or_status" || name === "status") {
      let extra = false, plan = false, lvl = "default", wm = "balanced", perm = "sandbox", autoDbg = true, multi = false;
      try { extra = !!(window.__rsExtraThinking && window.__rsExtraThinking()); } catch {}
      try { plan = !!(window.__rsPlanMode && window.__rsPlanMode()); } catch {}
      try { autoDbg = !(window.__rsAutoDebug) || window.__rsAutoDebug() !== false; } catch {}
      try { multi = !!(window.__rsMultiAgent && window.__rsMultiAgent()); } catch {}
      try { lvl = (window.__rsThinkingLevel && window.__rsThinkingLevel()) || "default"; } catch {}
      try { wm = (window.__rsWorkMode && window.__rsWorkMode()) || "balanced"; } catch {}
      try { perm = (window.__rsPermMode && window.__rsPermMode()) || "sandbox"; } catch {}
      const bridge = A.bridge || {};
      const info = {
        engine: activeEngine() === "local" ? "agentscript" : "robloxscript",
        work_mode: wm,
        extra_thinking: extra,
        plan_mode: plan,
        auto_debug: autoDbg,
        multi_agent: multi,
        agent_role: A.agentRole || "",
        thinking_level: lvl,
        permissions: perm,
        bridge_connected: bridge.connected === true,
        blender: !!bridge.blender,
        agent_version: bridge.agent_version || "(unknown - rebuild the agent if captures fail)",
        tools: A.toolList.length || 0,
        agent_started: !!A.started,
        agent_running: !!A.running,
      };
      return "Output of 'or_status':\n" + JSON.stringify(info, null, 2);
    }
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      const curEng = activeEngine();
      const requested = (args.server || curEng).trim().toLowerCase();
      // The proxy keeps advertising a catalogue even with no engine attached.
      // When the DEFAULT engine's bridge is actually unusable, short-circuit into
      // a plain offline note so the model doesn't fire dead commands.
      if (requested === curEng) {
        const s = A.bridge || {};
        const srv = s.servers || [];
        if (curEng === "local") {
          const local = srv.find((x) => x.id === "local");
          const usable = !!s.connected && (
            s.local_connected === true ||
            (local && local.alive) ||
            A.toolList.length > 0
          );
          if (!usable) {
            return `Output of '${name}':\nAgentScript is currently OFFLINE (the native agent process is not running), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to start or-agent.exe.`;
          }
        } else if (curEng !== "local") {
          const rbx = srv.find((x) => x.id === "roblox" || x.id === "studio");
          const rbxUsable = !!s.connected && (
            s.roblox_connected === true ||
            s.mcpAlive === true ||
            (rbx && rbx.alive) ||
            A.toolList.length > 0
          );
          if (!rbxUsable) {
            const others = srv.filter((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
            const otherStr = others.length
              ? `Other connected MCP server(s): ${others.map((x) => x.id).join(", ")}. Call list_mcp_servers, then list_commands with a "server" param to use them for anything that does not need Roblox.`
              : `No other MCP server is connected right now.`;
            return `Output of '${name}':\nRoblox Studio is currently OFFLINE (closed, no place open, or its MCP server disabled), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to open their place in Roblox Studio and enable its MCP server. ${otherStr}`;
          }
        }
      }
      const known = new Set(A.toolList.map((t) => t.server).filter(Boolean));
      // Tools from a bridge that doesn't tag "server" yet have no .server field;
      // treat them as the current engine's server rather than hard-coding roblox.
      const scoped = A.toolList.filter((t) => (t.server || curEng) === requested);
      if (!A.toolList.length) return `Output of '${name}':\nNo commands available - the bridge or ${curEng==="local" ? "the AgentScript agent" : "Roblox Studio"} may be offline.`;
      if (!scoped.length) {
        return `Output of '${name}':\nERROR: no server named "${requested}" is connected. Connected servers: ${[...known].join(", ") || curEng}. Call list_mcp_servers to check.`;
      }
      const lines = scoped.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        // Two buckets: simple scalar params get packed onto ONE compact line;
        // params that need real explanation (array-of-object shape, or a long
        // description) keep their own line so nothing structurally important
        // gets flattened away (that per-item shape is what fixed "Unknown …
        // action: nil" bugs on user_keyboard_input/user_mouse_input).
        const compact = [];
        const detailed = [];
        for (const [k, v] of Object.entries(props)) {
          const items = v.items && typeof v.items === "object" ? v.items : null;
          const itemProps = items && items.properties;
          const mark = req.has(k) ? "" : "?";
          if (v.type === "array" && itemProps) {
            const itemReq = new Set(items.required || []);
            const fields = Object.entries(itemProps).map(([ik, iv]) => {
              const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ?  `(${iv.enum.join("|")})` : (iv.type || "any");
              return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
            });
            detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ?  " - " + v.description : ""}`);
          } else if (v.description && v.description.length > 45) {
            detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
          } else {
            const ty = Array.isArray(v.enum) && v.enum.length <= 8 ?  `(${v.enum.join("|")})` : (v.type || "any");
            compact.push(`${k}${mark}:${ty}${v.description ?  ` "${v.description}"` : ""}`);
          }
        }
        const paramLines = [compact.length ?  `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
        // Tested usage note for the error-prone commands - kept full-length
        // (these are validated fixes for real bugs, not filler).
        const note = RS.TOOL_NOTES[bareToolName(t.name)];
        const noteStr = note ?  `\n    ⚠ ${note}` : "";
        return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ?  "\n" + paramLines : ""}${noteStr}`;
      });
      const animLines = requested === "roblox" ? RSAnim.describeCommands() : [];
      const skillLines = (requested === "roblox" && typeof RobloxScriptSkills !== "undefined") ? RobloxScriptSkills.describeCommands() : [];
      const agentLines = (requested === "local" && typeof AgentScriptSkills !== "undefined") ? AgentScriptSkills.describeCommands() : [];
      const webLines = [`— OR Status: or_status {} — live engine, work mode, extra thinking, bridge, blender. Call this if you are unsure which mode you are in.`, `— Web Tools (bridge-level, no Studio needed): web_fetch {url?, query?, max_chars?} — fetch a URL, OR pass query to search the web then fetch the top result; web_search {query, limit?} — DuckDuckGo titles+URLs`, `— Screenshots: screen_capture {} — Roblox Studio viewport; get_viewport_screenshot {max_size?} — Blender viewport (Connect Blender must be on). Either one attaches the image to your next message so you can see it.`, `— Debugger: or_debug {} — Studio LogService errors/warnings. Automatic Debugger (Settings) appends new errors after mutating commands.`, `— Multi-Agent: or_agent {role: planner|builder|reviewer|debugger, task?} — hand off to a specialist. Enable Multi-Agent in Settings.`, `— Developer Products: developer_product_create {name, price, description?, reward?} — create a real Roblox Developer Product on this published universe (sign into roblox.com in Chrome). developer_product_list {} lists them. Aliases: create_developer_product, create_dev_product.`];
      const virtualCount = animLines.length + skillLines.length + agentLines.length + webLines.length;
      return `Output of '${name}':\n${requested} commands (${scoped.length}${virtualCount ?  ` + ${virtualCount} OR virtual tools` : ""}):\n\n${lines.join("\n\n")}${animLines.length ?  "\n\n" + animLines.join("\n\n") : ""}${skillLines.length ?  "\n\n" + skillLines.join("\n\n") : ""}${agentLines.length ?  "\n\n" + agentLines.join("\n\n") : ""}\n\n${webLines.join("\n")}`;
    }
    // ── Virtual animation tools ──────────────────────────────────────────
    // Create/edit Roblox animation KEYFRAME DATA (KeyframeSequence/Keyframe/
    // Pose, per-bone transforms) via execute_luau + the RSAnim Luau library.
    // The catalogue above (list_commands) advertises them; the Roblox MCP
    // itself has no such tools, so they are resolved here instead of sent
    // through as real tool names.
    if (name.startsWith("animation_")) {
      const op = name.slice("animation_".length);
      if (!RSAnim.ANIM_OPS.includes(op)) {
        return `ERROR: unknown OR animation command '${name}'. Use list_commands to see the animation_* tools.`;
      }
      const built = RSAnim.buildLuau(op, args);
      if (built.err) return built.err;
      return await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit" } });
    }
    // ── Blender FBX → Studio (real import, not the watch-folder stub) ──
    if (name === "asset_bridge_import" || bareName === "asset_bridge_import") {
      return await runAssetBridgeImport(args);
    }
    // ── Virtual Studio Skills (Lighting, UI, FX, Audio, Terrain, Camera, Diagnostics) ──
    if (typeof AgentScriptSkills !== "undefined" && AgentScriptSkills.SKILL_OPS.includes(name)) {
      return await AgentScriptSkills.run(name, args, runTool);
    }
    if (typeof RobloxScriptSkills !== "undefined" && RobloxScriptSkills.SKILL_OPS.includes(name)) {
      try { createCheckpoint(name, args); } catch {}
      if (name === "ui_create_component") {
        try { if (window.__rsForge && window.__rsForge()) args = Object.assign({}, args, { forge: true }); } catch {}
      }
      const built = RobloxScriptSkills.buildLuau(name, args);
      if (built.err) return built.err;
      const res = await runTool({ tool: "execute_luau", arguments: { code: built.code, datamodel_type: "Edit" } });
      const ok = !String(res||"").startsWith("ERROR") && !String(res||"").includes("ERROR in execute_luau");
      try { persistSession(name, args, ok); if(ok){ bumpPerf(name); showSuggestion(name); // update perf from audit if available
        if(name==="diagnostics_audit" && typeof res==="string"){
          const m=res.match(/(\d+)\s+parts?/i); if(m) { perfParts=parseInt(m[1],10)||perfParts; updatePerfPill(); try{ chrome.storage.local.set({rsPerf:{parts:perfParts, scripts:perfScripts}});}catch{} }
        }
      } } catch {}
      return res;
    }
    const BLENDER_OPS = new Set(["get_scene_info","get_object_info","execute_blender_code","get_viewport_screenshot","blender_export_fbx","blender_execute_code"]);
    if (BLENDER_OPS.has(bareName) || /^blender_/.test(bareName)) {
      if (!(A.bridge && A.bridge.blender)) {
        let st = await bg({ type: "blender_status" });
        if (!(st && (st.blender || st.ok))) st = await bg({ type: "blender_connect" });
        if (st && (st.blender || st.ok)) {
          A.bridge = A.bridge || {};
          A.bridge.blender = true;
        }
      }
      if (!(A.bridge && A.bridge.blender)) {
        return "ERROR calling '" + name + "': Blender is not connected. Menu → Connect Blender (N-panel → Start MCP Server).";
      }
      if (bareName === "blender_send_to_studio") {
        return await runAssetBridgeImport(args);
      }
      const timeout = 120000;
      const hardCap = new Promise((res) =>
        setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from Blender" }), timeout + 30000));
      let stopTimer;
      const stopWatch = new Promise((res) => {
        stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
      });
      let sendArgs = args;
      if (bareName === "execute_luau" && args && args.code && args._orNoTxn !== true && !/ChangeHistoryService/.test(String(args.code))) {
        sendArgs = Object.assign({}, args, { code: wrapStudioTxn(String(args.code), String(bareName || "edit")) });
      }
      if (sendArgs && Object.prototype.hasOwnProperty.call(sendArgs, "_orNoTxn")) {
        sendArgs = Object.assign({}, sendArgs);
        delete sendArgs._orNoTxn;
      }
      const r = await Promise.race([bg({ type: "call_tool", name: bareName, arguments: sendArgs, timeout }), hardCap, stopWatch]);
      clearInterval(stopTimer);
      if (r && r.kind === "stopped") return "(stopped by user)";
      if (!r) return RS.FEEDBACK.bridgeOffline;
      if (r.ok) {
        if (r.images && r.images.length && !P.supportsVision) {
          return `ERROR: '${bareName}' returned an image, but this assistant cannot see images. Do NOT call it again.`;
        }
        if (r.images && r.images.length) {
          ui.showImages(r.images, name);
          A.pendingImages = r.images;
          const caption = r.text && r.text.trim() ? r.text.trim() : `${r.images.length} image(s) captured.`;
          return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
        }
        const textOut = r.text && r.text.length ? r.text : "(tool returned an empty result)";
        const autoStudio = bareName === "blender_export_fbx" || bareName === "export_blender_fbx";
        if (autoStudio) {
          const imported = await runAssetBridgeImport({ source: "blender", asset: r.filepath || args.filepath || args.path || "scene", objects: args.objects, dest: args.dest, scale: args.scale });
          return `Output of '${name}':\n${textOut}\n\nStudio:\n${imported}`;
        }
        // get_viewport_screenshot writes a PNG and reports its path; the
        // extension reads those bytes back (read_file_base64) and attaches them.
        // If nothing was attached, say why - the file IS on disk, so silence
        // would look like "Blender took a screenshot but the model can't see it".
        if (bareName === "get_viewport_screenshot") {
          return `Output of '${name}':\n${textOut}\n\nNOTE: Blender saved the capture but nothing could be read back as an image.` +
            agentBuildNote() + ` Then call ${name} again.`;
        }
        return `Output of '${name}':\n${textOut}`;
      }
      return `ERROR calling '${name}': ${r.error || "Blender call failed"}`;
    }
    if (A.toolNames.size && !A.toolNames.has(name) && !A.toolNames.has(bareName)) {
      return RS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    // The player-input tools only run against the Client datamodel (play mode) and
    // "Client" is the sole allowed value, so default it when the model omits it -
    // it can only be right. (It still needs the game RUNNING; that's documented.)
    if ((bareName === "user_keyboard_input" || bareName === "user_mouse_input") && !args.datamodel_type)
      args.datamodel_type = "Client";
    if (bareName === "execute_luau" && !args._orChunk && typeof args.code === "string") {
      const pieces = splitLuauChunks(args.code, LUAU_CHUNK_MAX);
      if (pieces && pieces.length > 1) {
        const dm = args.datamodel_type || "Edit";
        let last = "";
        for (let i = 0; i < pieces.length; i++) {
          const wrapped = wrapLuauChunk(pieces[i], i, pieces.length);
          last = await runTool({ tool: "execute_luau", arguments: { code: wrapped, datamodel_type: dm, _orChunk: true } });
          if (String(last || "").startsWith("ERROR")) return last;
        }
        return last;
      }
    }
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers, the loop
    // gets a definitive result and continues.
    const hardCap = new Promise((res) =>
      setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000));
    // Stop watcher: a blocking tool (e.g. wait_job_finished) would otherwise keep
    // the loop awaiting the bridge for up to minutes, leaving the input locked and
    // the Stop button stuck. When the user halts (A.stop), abandon the wait within
    // ~150ms so the loop breaks and its finally unlocks everything. The in-flight
    // bridge call may still finish in the background; its result is just ignored.
    let stopTimer;
    const stopWatch = new Promise((res) => {
      stopTimer = setInterval(() => { if (A.stop) res({ ok: false, kind: "stopped" }); }, 150);
    });
    let r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout }), hardCap, stopWatch]);
    clearInterval(stopTimer);
    if (r && r.kind === "stopped") return "(stopped by user)";
    if (!r) return RS.FEEDBACK.bridgeOffline;
    // The MCP server answers SUCCESSFULLY (ok:true) when no Studio is attached
    // (Studio closed / no place / MCP option disabled) - with an explanatory
    // text instead of a result. Surface it as a proper environment ERROR so the
    // model stops and tells the user, instead of treating it as tool output.
    if (r.ok && /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(r.text || "")) {
      ui.banner("warn", "Roblox Studio is not connected",
        "Open your place in Roblox Studio and enable the MCP server (Assistant AI → … → Manage MCP Servers → Enable Studio as MCP Server), then try again.");
      return RS.FEEDBACK.studioOffline;
    }
    // The Roblox MCP reports missing/invalid required parameters as a SUCCESS
    // whose text is just the complaint (e.g. "datamodel_type is required").
    // Re-shape those into a real ERROR so the model corrects the call instead
    // of misreading it as tool output.
    if (r.ok && r.text && /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i.test(r.text.trim())) {
      return `ERROR calling '${name}': ${r.text.trim()}.\nA required or invalid parameter - check the command's parameters with list_commands, fix the call and retry.`;
    }
    // The Roblox MCP also reports Luau PARSE/RUNTIME errors as a SUCCESS whose
    // text is the executor's own stack trace ("…ExecuteLuauTool:139: …
    // CommandExecution:54: <real error>" - validated live). Genuine script
    // output never contains those internal paths. Re-shape into a real ERROR so
    // the model gets the fix-it hints below and the chip settles red, not ✓
    // green - and strip the internal frames so only the useful part remains.
    if (r.ok && bareName === "execute_luau" && r.text &&
        /\b(?:ExecuteLuauTool|CommandExecution):\d+:/.test(r.text)) {
      r = { ok: false, error: r.text.replace(/^(?:\S*(?:ExecuteLuauTool|CommandExecution):\d+:\s*)+/, "").trim() || r.text };
    }
    if (r.ok) {
      if (r.images && r.images.length && !P.supportsVision) {
        // Any tool from ANY connected server can turn out to return images -
        // we don't try to predict this from its name in advance. This is the
        // generic catch: whatever just ran, if it handed back images and this
        // provider's model can't see them, refuse cleanly instead of silently
        // attaching a file it will never actually process.
        return `ERROR: '${bareName}' returned an image, but this assistant cannot see images. Do NOT call it again. Use a different command to get the information as text instead.`;
      }
      if (r.images && r.images.length) {
        // Show the capture in a left-hand OR popup (from the in-memory
        // base64 - simple and reliable on every site; no DOM-embedded preview).
        ui.showImages(r.images, name);
        // Do NOT attach the image here: submitAndGetBase/typeAndSend types the
        // feedback text into the editor LATER, and on providers whose editor is
        // rebuilt via select-all + insertText (e.g. Gemini's setEditorText),
        // that wipe severs the site's internal binding between "pending upload"
        // and "message being composed" - the file then sits in the composer
        // forever while only the text goes out (validated live: Gemini kept
        // the file attached+unsent across the whole turn). Stash the images and
        // let the provider attach them as the LAST step, right before the send
        // click, so nothing mutates the editor afterward.
        A.pendingImages = r.images;
        diag("images.stashed", { count: r.images.length });
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
      }
      // A capture answering "ok" with NO text and NO image is what an OLD
      // or-agent returns: Studio's screen_capture delivers the picture as an MCP
      // image content item ONLY, so a bridge without image passthrough hands
      // back an empty string. Name the running build instead of printing a bare
      // "(tool returned an empty result)" - that message sent us hunting twice.
      if (VISION_TOOLS.has(bareName) && !String(r.text || "").trim()) {
        return captureFailureHint(name);
      }
      const text = r.text && r.text.length ?  r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    // Orphaned content script - a page reload is the only cure, so say exactly
    // that instead of blaming the bridge (see bg / isContextInvalidated).
    if (r.kind === "stale-extension") {
      ui.banner("warn", "Reload this page",
        "OR was updated or reloaded while this tab was open, so this page is running an " +
        "old copy of it and commands can no longer run. Reload the page (F5) to reconnect - your " +
        "bridge and Roblox Studio are unaffected.");
      diag("bridge.staleExtension", { name, error: r.error });
      return RS.FEEDBACK.staleExtension;
    }
    if (r.kind === "disconnected") return RS.FEEDBACK.bridgeOffline;
    if (r.kind === "timeout") {
      return `ERROR: tool '${name}' timed out after ${name === "execute_luau" ? 20 : 120}s.\n${r.error}\nTry a shorter/simpler call or check that Roblox Studio is open and responsive.`;
    }
    if (name === "execute_luau") {
      const err = r.error || "";
      // "Failed to parse command code" is StudioMCP's GENERIC parse rejection: an
      // empty/mis-marked block is only ONE of its causes. The others are ordinary
      // Luau syntax errors and - seen live on Meta AI 2026-08-13 - code that is
      // syntactically fine but too big for the parser: a `return 1+1+1+…` chain
      // ran at ~500 terms (1006 chars) and was rejected at ~1000 (2006 chars).
      // Telling the model its block was empty when we DID send it a full code
      // string sends it to fix something that isn't broken; it retries the same
      // payload and fails again (the reported spam of parse errors). Only give the
      // marker advice when the code we actually sent really was empty.
      const luaCode = args.code || "";
      const hint = err.includes("Failed to parse command code")
        ? !luaCode.trim()
          ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
          : `Roblox refused to PARSE the code (${luaCode.length} chars sent, so it was not empty). Either the Luau syntax is invalid, or the code is too large/complex for the parser - a single huge expression or a very long script can be rejected outright. Check the syntax first; if it looks correct, split the work into several smaller calls.`
        : err.includes("attempt to") || err.includes("nil value")
          ? "Lua runtime error. Check that the API you are calling exists (use game:GetService() to access services). Make sure you use 'return' to output values, not 'print()'."
          : "Check your Lua syntax, make sure you use 'return' to output values (not 'print()'), and that all APIs you call exist in the current Roblox Studio context.";
      return `ERROR in execute_luau: ${err}\n\n${hint}\n\nFix the code and retry.`;
    }
    return `ERROR calling '${name}': ${r.error}\nRead the error carefully, fix the call or try a different approach.`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "execute_luau") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could — not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Some tools answer with raw JSON on one line, and a 44-char slice of it makes
  // a chip that says nothing: list_roblox_studios read
  // `{"studios":[{"id":"8521cfad-f8d9-46f4-8cbe-2`. Summarise the SHAPE instead,
  // in the same spirit as the boot chip's "25 commands". Returns null when the
  // body isn't JSON, so plain-text outputs keep their first line unchanged.
  function jsonSummary(body) {
    if (!/^[[{]/.test(body) || body.length > 200000) return null;
    let v;
    try { v = JSON.parse(body); } catch { return null; }
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ?  "" : "s"}`;
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v);
    // The common MCP shape: one wrapper key holding the list. Its name is already
    // plural ("studios", "scripts"), so it reads correctly as-is - just drop the
    // trailing "s" when there is exactly one, so it says "1 studio".
    if (keys.length === 1 && Array.isArray(v[keys[0]])) {
      const n = v[keys[0]].length;
      const word = n === 1 ?  keys[0].replace(/s$/, "") : keys[0];
      return `${n} ${word}`;
    }
    // Otherwise show the scalar fields - that's what a human would read off.
    const scalars = keys
      .filter((k) => v[k] === null || typeof v[k] !== "object")
      .map((k) => `${k}: ${v[k]}`);
    if (scalars.length) return scalars.join(", ").slice(0, 44);
    return `${keys.length} field${keys.length === 1 ?  "" : "s"}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    // Errors are prose and read fine as-is; only reshape successful JSON.
    if (!isErr) { const j = jsonSummary(body); if (j) return j; }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
    if (isErr) return first;
    return lines > 1 ?  `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "execute_luau") return (a.code || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  function isCapabilityRefuse(text) {
    const t = String(text || "");
    if (!t) return false;
    if (/###\s*LUA\s*###|"command"\s*:\s*"/i.test(t)) return false;
    return /\b(i (can('t|not)|do not|don't) (actually )?(have (the ability|access)|run|execute|interact with|control|reach)|as an? (ai|language model|assistant) i (can('t|not)|don't)|i('m| am) not able to (run|execute|access|control|use)|cannot (run|execute) (code|commands|tools) (on|in|against) your|i don't have access to (your|the) (computer|studio|machine|roblox)|i (can't|cannot) (use|call) (external|local) (tools|commands))\b/i.test(t);
  }
  async function agentLoop(base) {
    if (A.running) return;
    if (condoLocked()) {
      try { ui.toast("CONDO LOCK — commands frozen"); } catch {}
      return;
    }
    A.running = true;
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0;
    const MAX_TRUNC = 6;
    // Dead-turn auto-retry budget (v1.12): ONE rescue for a dropped/quiet turn
    // per loop. Reset on every healthy turn (tool result or final text) so an
    // hour-long session can survive multiple one-off site hiccups, while a
    // genuinely broken provider still stops after a single failed retry.
    let deadRetries = 0;
    let refuseRetries = 0;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    const REMIND_TOOLS_EVERY = 20;
    ui.showStop(true);
    P.setInputLock(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    try {
      while (!A.stop) {
        // Gate the WHOLE cycle on tab visibility. We only advance - read the
        // reply, PARSE it, EXECUTE a tool, inject the result - while the AI tab
        // is the FOREGROUND tab of its Edge window. document.visibilityState
        // (mirrored by document.hidden) is the right signal, NOT window focus:
        //  - Edge loses OS focus but the AI tab stays the active tab (user is
        //    working in Roblox Studio) -> still "visible" -> the agent keeps
        //    running, exactly as wanted.
        //  - The AI tab is backgrounded (another tab in front) or the window is
        //    minimized -> "hidden" -> pause here. Background tabs throttle
        //    rendering/timers, which made DOM reads unreliable (misparse,
        //    duplicate sends - see the send-side guard in submitAndGetBase).
        // Parking here means we never START a parse/exec cycle off-screen; the
        // send step re-checks too, so a switch-away mid-generation is covered.
        if (document.hidden && !A.stop) {
          diag("loop.waitVisible");
          ui.inputCover(true); // keep the "Agent is working" cover up while parked
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          diag("loop.visibleAgain");
        }
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          ui.banner("limit", `${P.displayName} hit its limit`,
            (res.detail || "") + " — just open a fresh chat to keep going.");
          break;
        }
        if (res.kind === "too_long") {
          ui.banner("limit", "Chat's getting long",
            `${P.displayName} says it's getting too long. Time for a fresh session.`);
          break;
        }
        if (res.kind === "timeout") {
          // One automatic retry (v1.12): flaky providers (GLM under load, Arena
          // busy pages, Qwen cold caches) sometimes just DROP a turn. A single
          // "continue" nudge rescues the run; a second failure still stops.
          if (deadRetries < 1 && !A.stop && A.started) {
            deadRetries++;
            diag("loop.deadRetry", { kind: "timeout", n: deadRetries });
            ui.toast(P.displayName + " went quiet — retrying once…");
            base = await submitAndGetBase(RS.FEEDBACK.deadTurn);
            continue;
          }
          ui.banner("warn", `${P.displayName} went quiet`,
            `${P.displayName} didn't answer in time. Loop stopped — try again.`);
          break;
        }
        // A genuinely empty turn is effectively never produced (the warm-up guard
        // waits out slow starts). It DOES happen when the site drops a reply, and
        // ending the loop silently is what made this the single most confusing
        // failure: the pending command just settles to a grey "not run" with no
        // explanation anywhere. Say what happened - and since v1.12, retry ONCE
        // first (same rationale as the timeout retry above).
        if (res.kind === "empty") {
          diag("empty.end");
          if (deadRetries < 1 && !A.stop && A.started) {
            deadRetries++;
            diag("loop.deadRetry", { kind: "empty", n: deadRetries });
            ui.toast(P.displayName + " sent nothing — retrying once…");
            base = await submitAndGetBase(RS.FEEDBACK.deadTurn);
            continue;
          }
          ui.banner("warn", `${P.displayName} sent nothing`,
            `Got an empty reply so the loop stopped — nothing ran. Nudge ${P.displayName} to continue, or hit Start in a fresh chat.`);
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("Reply was cut off — continuing from there");
            base = await submitAndGetBase(RS.FEEDBACK.truncated);
            continue;
          }
          if (res.text){ break; } // give up resuming; keep what we have as the answer
          ui.banner("warn", "Kept getting cut off",
            "Model keeps hitting its length cap. Try something shorter or start a fresh chat.");
          break;
        }
        truncCount = 0;
        deadRetries = 0; // healthy turn (text/tool/parse outcome) — refill the retry budget

        if (res.kind === "parse_error") {
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = RSParse.toolNameFromText(res.raw || "") || "command";
          if (res.item) {
            const detail = res.reason === "unclosed" ? "cut off"
              : res.reason === "luaOpener" ? "missing ###LUA###"
              : res.reason === "envelope" ? "bad format"
              : "bad JSON";
            decorate.toolBox(res.item, failName, "err", detail, true, "", RS.toolCategory(failName));
          }
          // Pass the detected command name so the feedback only offers the
          // ###LUA### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(RS.FEEDBACK.parseError(res.reason, failName));
          continue;
        }
        if (res.kind === "text") {
          const body = String(res.text || "");
          if (refuseRetries < 1 && !A.stop && isCapabilityRefuse(body)) {
            refuseRetries++;
            diag("loop.capabilityRefuse", { n: refuseRetries });
            try { ui.toast("Model refused capability — reminding it OR is real…"); } catch {}
            base = await submitAndGetBase(RS.FEEDBACK.capabilityRefuse);
            continue;
          }
          break;
        }

        if (res.kind === "tool") {
          const calls = res.calls;
          if (calls.length > 1) {
            base = await submitAndGetBase(RS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?")));
            continue;
          }
          const call = calls[0];
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          const category = learnedImg ?  "screen" : RS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category });

          // Park BEFORE painting the chip / stamping the clock / marking the turn
          // dispatched. runTool() gates on visibility too (it is the choke point
          // that also covers the bootstrap), but parking only there would leave
          // this block's side effects applied for the whole minimize:
          //   - the chip spins "running" while nothing actually runs, and
          //     elapsedOn(rsToolT0) counts the parked time, so a 20-min minimize
          //     renders a bogus "1200.0s" on the call;
          //   - rememberExecuted() would mark the turn dispatched before it ever
          //     ran, so a reload/close while parked loses the command for good -
          //     the auto-resume watchdog refuses to re-fire an "executed" turn.
          // Parking first keeps all of that truthful: we only commit once we are
          // foreground and about to really dispatch.
          if (document.hidden && !A.stop) {
            diag("tool.parkBeforeDispatch", { name: call.tool });
            if (!(await waitVisible()) || A.stop) break;
          }
          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool });
          try { ui.trackCard(call.tool, "run", "executing\u2026", category); } catch {}
          let feedback = await runTool(call);
          // Persistent environment header (see asStateTag) — appended, never
          // prefixed, so feedbackIsError()'s startsWith("ERROR") stays intact.
          { const _tag = asStateTag(); if (_tag && !feedback.includes("[SYSTEM_STATE:")) feedback += "\n" + _tag; }
          try { feedback = await attachAutoDebug(call.tool, feedback); } catch {}
          try { feedback = compressToolFeedback(feedback, call.tool); } catch {}
          A.toolRunning = false;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            break;
          }
          const isErr = feedbackIsError(feedback);
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ?  "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (Roblox OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ?  "screen" : category;
          decorate.toolBox(res.item, call.tool, isErr ?  "err" : "done", outSummary(feedback),
            true, outBody, resultCat);
          try { ui.trackCard(call.tool, isErr ?  "err" : "ok", outSummary(feedback), resultCat); } catch {}
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ?  "err" : "done", detail: outSummary(feedback),
            body: outBody, category: resultCat, count: P.assistantCount(),
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ?  P.lastAssistantId() : undefined,
          };

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Scope the reminder to the primary Roblox server, exactly like
              // list_commands: re-injecting EVERY connected server's tools (Blender
              // etc.) merged flat would bloat the model's context - the opposite of
              // what the model gets when it lists commands itself. Anti-drift only
              // needs the primary Roblox set; addon commands were listed on demand
              // and the bridge routes by name regardless.
              const roblox = A.toolList.filter((t) => (t.server || "roblox") === "roblox");
              toSend += RS.toolsReminder(roblox) + "\n" + RS.memoryNudge();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY });
            }
          }
          // This result becomes a turn, so it counts toward the re-statement
          // budget - context volume is what makes the site summarise, and the
          // volume is overwhelmingly tool results, not how often the user types.
          bumpSys("results");
          // Ride the system-prompt re-statement out on this result if one is due
          // and it fits (see withSysResend - the result itself is never trimmed).
          toSend = withSysResend(toSend);
                    let images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ? images.length : 0 });
          base = await submitAndGetBase(toSend, images);
        }
      }
    } catch (e) {
      if (e instanceof SendAbortedError) {
        // "Couldn't send that" is already on screen from submitAndGetBase -
        // just stop quietly instead of piling an "internal error" on top.
        diag("loop.sendAborted", {});
      } else {
        diag("loop.error", { msg: String((e && e.message) || e) });
        ui.banner("warn", "Internal loop error", String((e && e.message) || e));
        try { A._sfxErr = true; } catch {}
      }
    } finally {
      try { playSfx(A.stop ? "stop" : (A._sfxErr ? "error" : "done")); A._sfxErr = false; } catch {}
      A.running = false;
      A.stop = false;
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", RS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → " Stopping…", disabled
    P.stopGeneration();
    ui.toast("Stopping the agent…");
  }

  // The full system prompt for the CURRENT provider and user settings. One
  // definition, used both by the bootstrap and by the periodic re-injection, so
  // the two can never drift apart.
    function systemPrompt() {
      let engine = "roblox";
      try { if (typeof window.__rsEngine === "function") engine = window.__rsEngine(); } catch {}
      const text = RS.buildSystemPrompt({
        siteName: P.displayName,
        customPrompt: ui.getCustomPrompt(),
        providerNotes: P.promptExtra || "",
        engine,
        fullAccess: !!(typeof window.__rsFullAccess === "function" && window.__rsFullAccess()),
        maxChars: P.sysMaxChars || 0,
      });
      // Context-meter cache: the bar shows an approximate token cost next to
      // Start so users understand why big prompts can degrade weaker chats.
      try { A.sysInfo = { len: text.length, tokens: Math.round(text.length / 4), engine }; } catch {}
      return text;
    }

  // ── Periodic system-prompt re-injection (opt-in, per provider) ────────────
  // Some sites aggressively summarise their own context mid-conversation. When
  // that happens the model keeps the gist of the task but loses the MECHANISM:
  // it forgets that an extension reads its replies and executes them, and starts
  // answering "I can't invoke those commands in this session" while the
  // extension sits there ready and waiting. Observed repeatedly on ChatGPT.
  //
  // The periodic tools reminder does NOT fix this: it re-anchors command NAMES,
  // but it never restates that the commands actually run. So providers that need
  // it set `resendSystemEvery`, and the whole prompt goes back in.
  //
  // Delivery rides on the next injected tool result rather than costing its own
  // message - free and invisible. But that channel dries up in exactly the case
  // this exists for (a model that has forgotten it can call tools stops calling
  // them, so no results flow), so a fallback sends it as its own masked turn
  // once the window has elapsed with nothing to piggyback on.
  const RESEND_SYS_EVERY = P.resendSystemEvery || 0;
  // Injected tool results get their own, larger budget (see sysResendDue).
  const RESEND_SYS_EVERY_RESULTS = 12;

  // How much conversation has accumulated since the operating instructions were
  // last stated. PERSISTED per conversation, because both simpler designs failed
  // in opposite directions - each caught live on 2026-08-14:
  //
  //  - An in-memory counter RESETS on every page reload, while the session
  //    itself survives one (A.started is persisted). After an F5, or a silent
  //    Chrome extension auto-update, the tally restarted and the re-statement
  //    could be postponed indefinitely.
  //  - Walking the DOM back to the last SYS_MARKER turn is reload-proof but
  //    UNDER-counts badly: these sites virtualize. Measured on a real ChatGPT
  //    session that had long passed the threshold - only 12 turns were rendered,
  //    the marker was not among them (so the walk silently counted from the top
  //    of the window) and it saw 5 injected results instead of the true total.
  //
  // Counting at INJECTION time and persisting sidesteps both: it is exact, and
  // virtualization cannot erase it. The DOM walk is kept as a floor, since a
  // conversation that visibly shows the threshold is due no matter what storage
  // says (e.g. a session adopted from another device, or storage cleared).
  const sysKey = () => `rsSys:${P.conversationKey() || "new"}`;
  let sysCount = { users: 0, results: 0 };
  let sysCountKey = "";

  // Hydrate from storage. Only meaningful at startup / on a conversation switch;
  // it never overwrites counts already accumulated in this tick's memory (a
  // bump that landed while the async read was in flight must not be lost).
  async function loadSysCount() {
    const k = sysKey();
    if (k === sysCountKey) return sysCount;
    sysCountKey = k;
    const local = sysCount;
    sysCount = { users: 0, results: 0 };
    try {
      const r = await new Promise((res) => chrome.storage.local.get(k, res));
      const saved = r && r[k];
      if (saved) sysCount = {
        users: Math.max(saved.users || 0, local.users || 0),
        results: Math.max(saved.results || 0, local.results || 0),
      };
    } catch {}
    return sysCount;
  }
  function saveSysCount() {
    try { chrome.storage.local.set({ [sysCountKey]: sysCount }); } catch {}
  }
  // Increment SYNCHRONOUSLY, persist asynchronously. sysResendDue() reads
  // sysCount in the same tick as the bump that should trip it, so deferring the
  // increment into the storage promise made the tally lag a full turn behind and
  // the threshold was never seen at the moment it mattered (caught live: 12 tool
  // results, counter still reading 11, no rider). Storage is a durability
  // mechanism here, not the source of truth for the current tick.
  function bumpSys(field) {
    if (!RESEND_SYS_EVERY) return;
    if (sysCountKey !== sysKey()) { sysCountKey = sysKey(); }
    sysCount[field]++;
    saveSysCount();
  }
  function resetSysCount() {
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }

  // Lower bound read straight from what is on screen (see above).
  function sinceLastSysInDom() {
    const items = P.allItems();
    let users = 0, results = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = P.classifyText(it, ".rs-chip");
      // The bootstrap turn and every rider both carry the marker - either one
      // means the rules were fully stated here, so stop counting.
      if (txt.includes(RS.SYS_MARKER)) break;
      if (!P.isUserItem(it)) continue;
      if (RSParse.isInjectedFeedback(txt)) results++;
      else users++;
    }
    return { users, results };
  }

  function sinceLastSys() {
    const dom = sinceLastSysInDom();
    return {
      users: Math.max(sysCount.users, dom.users),
      results: Math.max(sysCount.results, dom.results),
    };
  }

  // A re-statement is owed once EITHER budget is spent. Two triggers because
  // they measure different things: user turns track a long back-and-forth, while
  // injected results track context VOLUME - and volume is what actually makes
  // the site summarise. Measured live on 2026-08-14: in a real session 5 of the
  // 6 "user" turns were injected tool results and only ONE was typed by Seb, so
  // a user-turn-only trigger sat at 1/6 while five full tool payloads had
  // already landed. The results budget is the one that fires in practice.
  function sysResendDue() {
    if (A.forceSysResend) return true;   // mode toggled (Forge/Extra) — restate NOW
    if (!RESEND_SYS_EVERY) return false;
    const { users, results } = sinceLastSys();
    const due = users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS;
    // Logged sparsely on purpose: this is consulted on EVERY tool result, and an
    // entry each time would flush the 300-slot diag ring of everything else -
    // exactly the history you need when something goes wrong. The verdict turn
    // and every 4th result is enough to reconstruct the tally.
    if (due || results % 4 === 0) {
      diag("sys.tally", {
        users, results, due,
        mem: `${sysCount.users}/${sysCount.results}`,
        need: `${RESEND_SYS_EVERY}u ${RESEND_SYS_EVERY_RESULTS}r`,
      });
    }
    return due;
  }
  // Attach the prompt to an outgoing tool result IF it fits. The result is never
  // truncated to make room: the passenger is dropped and the flag stays raised,
  // so it rides the next result instead. A tool result the model is waiting on
  // is always worth more than a reminder.
  function withSysResend(text) {
    if (!sysResendDue()) return text;
    const prompt = systemPrompt();
    const rider =
      "\n\n────────────────────────────────\n" +
      RS.RESEND_MARKER + "\n" +
      "(System note from RobloxScript - an automatic re-statement of your operating " +
      "instructions, NOT a new request and NOT something to reply to. This conversation " +
      "may have been summarised, which drops the part explaining how you actually run " +
      "commands. To be explicit: the RobloxScript extension IS running in this page right " +
      "now, it DOES read your replies, and the commands below DO execute for real - the " +
      "results you have been receiving are proof of it. Keep using them exactly as " +
      "described. Just carry on with the task; do not acknowledge this note.)\n" +
      prompt;
    const cap = P.sendCharBudget || Infinity;
    if (text.length + rider.length > cap) {
      // Stays due - the next (smaller) result carries it.
      diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap });
      return text;
    }
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    A.forceSysResend = false;   // mode-change restate delivered
    diag("sys.resend", { via: "toolResult", chars: rider.length, ...spent });
    return text + rider;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession(opts = {}) {
    const isRestart = !!(opts && opts.restart);
    if (A.running || A.starting) return;
    if (condoLocked()) {
      const s = Math.ceil((condoState.until - Date.now()) / 1000);
      try { ui.toast("CONDO LOCK — Start is frozen for " + s + "s"); } catch {}
      try { showCondoLockPanel(condoState.strikes, condoState.until); } catch {}
      return;
    }
    // "Start session" is normally allowed ONLY on a blank conversation.
    // A "Restart" (existing chat, user explicitly clicked ↻ Restart) bypasses
    // this and injects the system prompt mid-chat so the AI will work.
    if (!isRestart && !P.chatIsEmpty() && !A.started) {
      ui.toast("Open a new chat first, then Start");
      return;
    }
    A.userStopped = false;
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ?  P.lastAssistantId() : null;
    A.starting = true;
    A._startingSince = Date.now(); // stale-bootstrap failsafe anchor (meter loop)
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    try {
      // The lock/cover live INSIDE the try: if any UI/provider call between
      // here and the first await throws, the finally still releases them. They
      // used to sit before the try - an exception there stuck A.starting true
      // with the composer locked and every failsafe gated off (frozen chat).
      ui.setStarting(true);
      ui.updateStartGate(); // refresh the bar into its "starting" state
      P.setInputLock(true); // block user input during bootstrap
      ui.inputCover(true);  // cover the composer ("Working…") for the WHOLE Starting Up
      await ensureTools(true); // boot: always take a fresh catalogue (the TTL then
                               // covers the list_commands / list_mcp_servers calls
                               // the model makes seconds later)
      if (!alive()) return;
      if (!A.toolList.length) {
        const eng = activeEngine();
        const tip = eng === "local"
          ? `Couldn't reach AgentScript. Run ${RUN_CMD} and give it another shot.`
          : `Couldn't grab the tools. Run ${RUN_CMD} and make sure Studio's actually open, then give it another shot.`;
        ui.banner("warn", "Bridge isn't talking", tip);
        return;
      }
      const modeState = await P.ensureComposerReady("startup");
      if (!alive()) return;
      if (!modeState.ready) {
        ui.banner("warn", `${P.displayName} isn't ready`,
          (modeState && modeState.detail) ||
          `Couldn't find ${P.displayName}'s chat box. Open a new chat or reload the page.`);
        return;
      }
      const prompt = systemPrompt();
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        // Engine down short-circuits list_commands into a plain "offline" note
        // instead of the real catalogue - detect that and show it as such, rather
        // than the STALE cached tool count below.
        const _isUnrealBoot = false;
        if (/Roblox Studio is currently OFFLINE|Unreal Editor is currently OFFLINE/.test(toolFeedback)) {
          decorate.toolBox(startRes.item, "Loading commands", "err", "Roblox offline", true);
        } else {
          // Count what the model ACTUALLY received for the *current* engine.
          const _cur = _isUnrealBoot ?  "unreal" : "roblox";
          const cnt = A.toolList.filter((t) => (t.server || _cur) === _cur).length;
          decorate.toolBox(startRes.item, "Loading commands", "done", `${cnt} commands`, true);
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2); // wait for "I'm ready" reply
        if (!alive()) return;
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
      }
      A.started = true;
      rememberSession(P.conversationKey()); // survives virtualization AND reloads
      ui.setStarted(true);
        const _eng = activeEngine() === "local" ? "AgentScript" : "Roblox";
      ui.toast(`Ready — tell ${P.displayName} what to build in ${_eng}.`);
    } catch (e) {
      if (e instanceof SendAbortedError) {
        // The bootstrap send never landed (e.g. Crax guest mode silently no-ops
        // sends). "Couldn't send that" is already on screen - stop quietly and
        // leave Start available instead of a raw "Startup failed" banner.
        diag("start.sendAborted", {});
      } else if (alive()) {
        ui.banner("warn", "Startup failed", String((e && e.message) || e));
      }
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        P.setInputLock(false); // always unlock after bootstrap
        decorate.sweep();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    screen:  SVG('<rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    roblox:  SVG('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>'),
    read:    SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    edit:    SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    generate: SVG('<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>'),
    tool:    SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>'),
    result:  SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    check:   SVG('<polyline points="20 6 9 17 4 12"/>'),
    // Bell - the mid-session system-prompt re-statement. Deliberately NOT the
    // gear: the gear means "the agent is starting up", and a reminder is the
    // opposite (a session already long enough to need re-anchoring).
    remind:  SVG('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    error:   SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    gear:    SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 11h.1a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z"/>'),
  };
  const SPIN = '<span class="rs-spin"></span>';

  function iconFor(category, phase) {
    if (phase === "run") return SPIN;
    if (phase === "err") return ICONS.error;
    if (phase === "done") return ICONS.check;
    if (phase === "result") return ICONS.result;
    if (phase === "sys") return ICONS.gear;
    if (phase === "remind") return ICONS.remind;
    return ICONS[category] || ICONS.tool;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    const chip = item.querySelector(".rs-chip");
    if (chip) chip.remove();
    item.classList.remove("rs-hidden");
    item.querySelectorAll(".rs-tool-hide").forEach((e) => e.classList.remove("rs-tool-hide"));
    item.querySelectorAll(".rs-cmd-mask").forEach((e) => e.classList.remove("rs-cmd-mask"));
    delete item.dataset.rs;
    delete item.dataset.rsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__rsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      let chip = item.querySelector(".rs-chip");
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="rs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ?  1 : 0}|${label}|${detail}|${hasBody ?  body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `rs-chip cat-${category} ${cls || ""}`;
        chip.innerHTML =
          `<div class="rs-chip-head">` +
            `<span class="rs-chip-ic">${iconFor(category, phase)}</span>` +
            `<span class="rs-chip-tx"></span>` +
            `<span class="rs-chip-dt"></span>` +
            (hasBody ?  `<span class="rs-chip-cv">${SVG('<polyline points="6 9 12 15 18 9"/>')}</span>` : "") +
          `</div>` +
          (hasBody ?  `<div class="rs-chip-body"><pre></pre></div>` : "");
        chip.querySelector(".rs-chip-tx").textContent = label;
        if (detail) chip.querySelector(".rs-chip-dt").textContent = detail;
        if (hasBody) {
          chip.querySelector(".rs-chip-body pre").textContent = body;
          const head = chip.querySelector(".rs-chip-head");
          head.style.cursor = "pointer";
          head.onclick = () => chip.classList.toggle("open");
        }
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("rs-hidden");
      } else {
        item.classList.remove("rs-hidden");
        // findToolBlockSpot ALSO applies the .rs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ?  P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ?  chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.rs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__rsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .rs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__rsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".rs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###LUA### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".rs-tool-hide") && !e.closest(".rs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .rs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".rs-tool-hide") &&
                 RSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ?  P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ?  "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || RS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".rs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .rs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".rs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(RS.RESEND_MARKER)) {
        if (item.dataset.rs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ?  `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.rs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(RS.SYS_MARKER)) {
        const phase = A.starting ?  "run" : "sys";
        if (item.dataset.rs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && RSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ?  m[1] : "note") + "|" + (isErr ?  "err" : hasImg ?  "img" : "result");
        if (item.dataset.rsig !== sig || !item.classList.contains("rs-hidden") || chipGone) {
          this.chip(item, {
            label: m ?  `${m[1]} · result` : "result",
            category: hasImg ?  "screen" : m ?  RS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ?  "err" : "result",
            cls: isErr ?  "err" : "result", whole: true,
          });
          item.dataset.rsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.rsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !RSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".rs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ?  "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real RobloxScript session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasRsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && RSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = RSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: RSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __rsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            RSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          RSParse.isInjectedFeedback(P.classifyText(next, ".rs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ?  "err" : (orphanPending ?  "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ?  "stopped" : (orphanPending ?  "not run" : "");
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".rs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (RSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: RSParse.toolNameFromText(txt) });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("rs-tool-hide") && !e.closest(".rs-tool-hide") &&
                 !e.closest(".rs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".rs-tool-hide") &&
                 RSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with Roblox screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = RSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".rs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ?  P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ?  { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".rs-chip")) {
        const tx = item.querySelector(".rs-chip-tx");
        const name = RSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.rs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.rs || item.dataset.zphase || item.querySelector(".rs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.rs || "chip-only" });
        resetDecoration(item);
      }
    },

    sweep() {
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".rs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".rs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = (() => {
    let root, bar, dot, brandEl, stateEl, actionBtn, stopBtn, extraBtn, menuEl, unstableEl, cardsBtn, cardsPanel, supportBtn;
    let cover, coverRaf, barRaf;
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    let bridgeOk = false, studioDown = false, placeDown = false, appDown = false, addonOk = false, studioProcUp = false;
    let robloxProcUp = false, unrealProcUp = false;
    let wasConnected = false, bridgeBannerEl = null;
    let currentEngine = "roblox"; // hoisted to ui scope so renderBar can read it
    // setEngine lives inside build(); expose it here so setStatus can drive it.
    let engineApi = null;
    let lastManualEngineAt = 0; // user toggled recently — auto-switch must not fight them

    function build() {
      root = document.createElement("div");
      root.id = "rs-root";
      // One consolidated status bar, anchored just above the site's composer
      // (positioned every frame by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites, custom prompt, support, Discord). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      root.innerHTML = `
        <div id="rs-bar">
          <div class="rs-cluster rs-cluster-left">
          <span id="rs-dot" class="off" title=""></span>
          <span id="rs-ornament" aria-hidden="true"></span>
          <span id="rs-brand">${BRAND_NAME}</span>
          <div id="rs-engine" data-engine="roblox">
            <span id="rs-engine-thumb"></span>
            <button data-mode="roblox" class="rs-mode-btn on" title="RobloxScript">RS</button>
            <button data-mode="local" class="rs-mode-btn" title="AgentScript">AS</button>
          </div>
          </div>
          <span id="rs-status-pill" hidden><span class="rs-status-dot"></span><span class="rs-status-text"></span></span>
          <span id="rs-state"></span>
          <span id="rs-unstable-inline" hidden title="This site can drop turns">⚠ unstable</span>
          <span id="rs-perf" hidden title="Performance budget"></span>
          <span id="rs-ctx" hidden title=""></span>
          <div class="rs-cluster rs-cluster-right">
          <button id="rs-action"></button>
          <button id="rs-stop" hidden>■ Stop</button>
          <button id="rs-extra" hidden title="Extra Thinking — the AI reviews its own work">🧠 Extra</button>
          <button id="rs-undo" hidden title="Undo last Studio change the agent made">Undo</button>
          <button id="rs-discord" aria-label="Discord" title="OR Discord"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></button>
          <button id="rs-mcp-btn" aria-label="MCP Bridges & Servers" title="MCP Bridges & External Tools (Blender, Figma, Studio)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="M12 18v4"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M18 12h4"/><circle cx="12" cy="12" r="4"/></svg></button>
          <button id="rs-settings-btn" aria-label="Settings" title="Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          </div>
        </div>
        <div id="rs-cards-panel" hidden></div>
        <div id="rs-menu" hidden></div>
        <div id="rs-mcp-menu" class="rs-menu-panel" hidden></div>
        <div id="rs-approve" hidden>
          <div class="rs-approve-card">
            <div class="rs-approve-kicker">Ask mode</div>
            <div class="rs-approve-title">Allow this action?</div>
            <div id="rs-approve-body"></div>
            <div class="rs-approve-actions">
              <button type="button" id="rs-approve-deny">Deny</button>
              <button type="button" id="rs-approve-allow">Allow</button>
            </div>
          </div>
        </div>
      `;
      document.documentElement.appendChild(root);
      bar = root.querySelector("#rs-bar");
      dot = root.querySelector("#rs-dot");
      brandEl = root.querySelector("#rs-brand");
      stateEl = root.querySelector("#rs-state");
      actionBtn = root.querySelector("#rs-action");
      stopBtn = root.querySelector("#rs-stop");
      extraBtn = root.querySelector("#rs-extra");
      const undoBtn = root.querySelector("#rs-undo");
      supportBtn = root.querySelector("#rs-settings-btn");
      const discordBtn = root.querySelector("#rs-discord");
      if (discordBtn) discordBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        try { window.open(DISCORD_URL, "_blank", "noopener"); } catch {}
      });
      // Cards live on their OWN floating button left of the chatbox (the bar
      // was too crowded) — placeBar() anchors it to the bar's left edge.
      cardsBtn = document.createElement("button");
      cardsBtn.id = "rs-cards-btn";
      cardsBtn.className = "rs-cards-fab";
      cardsBtn.setAttribute("aria-label", "Cards");
      cardsBtn.title = "Session \u2014 what the AI did + controls";
      cardsBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3.2 3L7 15"/><path d="M12.5 15H17"/></svg>';
      root.appendChild(cardsBtn);
      cardsPanel = root.querySelector("#rs-cards-panel");
      if (cardsBtn && cardsPanel) {
        // Dropup placement: above the button, right-aligned, clamped to the
        // viewport (the bar can sit near screen edges on some sites).
        const placeCards = () => {
          if (cardsPanel.hidden) return;
          const r = cardsBtn.getBoundingClientRect();
          const w = cardsPanel.offsetWidth || 340;
          const h = cardsPanel.offsetHeight || 320;
          let top = r.top - h - 10;
          if (top < 8) top = Math.min(r.bottom + 10, Math.max(8, window.innerHeight - h - 8));
          let left = r.right - w;
          left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
          cardsPanel.style.top = top + "px";
          cardsPanel.style.left = left + "px";
        };
        cardsBtn.addEventListener("click", (e)=>{
          e.stopPropagation();
          cardsPanel.hidden = !cardsPanel.hidden;
          if (!cardsPanel.hidden) {
            renderCards(cardsPanel);
            requestAnimationFrame(placeCards);
          }
        });
        document.addEventListener("click", (e)=>{
          if (cardsPanel._orUiGuard && Date.now() < cardsPanel._orUiGuard) return;
          if (!cardsPanel.hidden && !cardsPanel.contains(e.target) && !cardsBtn.contains(e.target)) cardsPanel.hidden = true;
        });
        // Don't close when scrolling inside the panel itself, or when the click
        // target was detached by a re-render during this same event (tab switches).
        window.addEventListener("resize", placeCards);
        window.addEventListener("scroll", (e) => {
          if (cardsPanel.hidden) return;
          try { if (cardsPanel._orUiGuard && Date.now() < cardsPanel._orUiGuard) return; } catch {}
          try { if (e.target && (e.target === cardsPanel || cardsPanel.contains(e.target))) return; } catch {}
          cardsPanel.hidden = true;
        }, true);
        document.addEventListener("click", (e) => {
          if (cardsPanel.hidden) return;
          try { if (cardsPanel._orUiGuard && Date.now() < cardsPanel._orUiGuard) return; } catch {}
          try { if (e.target && !e.target.isConnected) return; } catch {}
          if (!cardsPanel.contains(e.target) && !cardsBtn.contains(e.target)) cardsPanel.hidden = true;
        });
        // Delegated: tab switching, Clear-all, library card clicks.
        cardsPanel.addEventListener("click", (e)=>{
          const tab = e.target.closest && e.target.closest(".rs-cards-tab");
          if (tab) {
            // stopPropagation: renderCards detaches the clicked tab from the DOM,
            // and the document-level outside-click closer below would otherwise
            // see a detached target, fail contains(), and slam the panel shut.
            e.stopPropagation();
            const t = tab.dataset.tab;
            cardsTab = t === "activity" ? "activity" : t === "uicreator" ? "uicreator" : "library";
            renderCards(cardsPanel);
            return;
          }
          const uiStyleBtn = e.target.closest && e.target.closest("[data-ui-style]");
          if (uiStyleBtn) {
            e.stopPropagation();
            cardsUiStyle = uiStyleBtn.getAttribute("data-ui-style") || "modern";
            renderCards(cardsPanel);
            return;
          }
          const uiUnref = e.target.closest && e.target.closest("[data-ui-unref]");
          if (uiUnref) {
            e.stopPropagation();
            const idx = parseInt(uiUnref.getAttribute("data-ui-unref"), 10);
            if (idx >= 0) cardsUiRefs.splice(idx, 1);
            paintUiRefs();
            return;
          }
          const uiBuildBtn = e.target.closest && e.target.closest("[data-ui-build]");
          if (uiBuildBtn) {
            e.stopPropagation();
            sendUiCreate();
            return;
          }
          const clear = e.target.closest && e.target.closest("#rs-cards-clear");
          if (clear) {
            e.stopPropagation();
            recentCards.length = 0;
            renderCards(cardsPanel);
            return;
          }
          // Danger zone: single-click FULL ACCESS toggle (agent confirms state).
          const fullBtn = e.target.closest && e.target.closest("#rs-full-toggle");
          if (fullBtn) {
            e.stopPropagation();
            const want = !(typeof window.__rsFullAccess === "function" && window.__rsFullAccess());
            try { window.__rsFullAccess = () => want; } catch {}
            try { chrome.runtime.sendMessage({ type: "rs-set-full", enabled: want }); } catch {}
            renderCards(cardsPanel); // re-renders with new ON/OFF + note
            toast(want
              ? "\u26A0 FULL ACCESS ON \u2014 the AI can now touch your whole PC"
              : "FULL ACCESS OFF \u2014 back to the workspace sandbox");
            return;
          }
          const lib = e.target.closest && e.target.closest(".rs-lib-card");
          if (lib) {
            // Copy button takes priority over click-to-send.
            const copyBtn = e.target.closest && e.target.closest(".rs-lib-copy");
            if (copyBtn) {
              e.stopPropagation();
              const c = visibleLibCache[+copyBtn.dataset.copyIndex];
              if (c) {
                const write = navigator.clipboard && navigator.clipboard.writeText
                  ? navigator.clipboard.writeText(c.prompt)
                  : Promise.reject(new Error("no clipboard"));
                write.then(
                  () => toast("Prompt copied — paste it into any chat"),
                  () => toast("Clipboard blocked — drag the card into the chat box")
                );
              }
              return;
            }
            const c = visibleLibCache[+lib.dataset.promptIndex];
            if (c) runLibraryCard(c, !e.shiftKey);
          }
        });
        // Native drag-and-drop: the prompt travels as text/plain, so dropping
        // it into any site input/contenteditable just works — no per-site code.
        cardsPanel.addEventListener("dragstart", (e)=>{
          const lib = e.target.closest && e.target.closest(".rs-lib-card");
          const c = lib && visibleLibCache[+lib.dataset.promptIndex];
          if (c && e.dataTransfer) {
            e.dataTransfer.setData("text/plain", c.prompt);
            e.dataTransfer.effectAllowed = "copy";
          }
        });
      }
      menuEl = root.querySelector("#rs-menu");
      mcpMenuEl = root.querySelector("#rs-mcp-menu");
      const mcpBtn = root.querySelector("#rs-mcp-btn");
      bar.classList.add(`rs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`rs-site-${P.id}`);
      // Experiment flags — easy revert: set FLAGS.* to false in core/config.js
      try {
        if (RS.FLAGS && RS.FLAGS.uiGlass) document.documentElement.setAttribute("data-rs-glass", "true");
        if (RS.FLAGS && RS.FLAGS.dualMemory) document.documentElement.setAttribute("data-rs-dual", "true");
      } catch {}

      actionBtn.addEventListener("click", onActionClick);
      stopBtn.addEventListener("click", stopLoop);
      if (extraBtn) extraBtn.addEventListener("click", (e)=>{ e.stopPropagation(); setExtraThinking(!extraThinking); });
      if (undoBtn) undoBtn.addEventListener("click", (e)=>{ e.stopPropagation(); e.preventDefault(); try { if (typeof window.__rsUndo === "function") window.__rsUndo(); } catch {} });
      if (!document.getElementById("rs-plus-css")) {
        const st = document.createElement("style");
        st.id = "rs-plus-css";
        st.textContent = "#rs-undo{flex:none;padding:7px 10px;background:#3a3a48;color:#f3efe6;border:0;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}#rs-undo:hover{background:#4a4a5c}#rs-undo[hidden]{display:none}";
        (document.head || document.documentElement).appendChild(st);
      }
      unstableEl = root.querySelector("#rs-unstable-inline") || root.querySelector("#rs-unstable");
      if (unstableEl) {
        unstableEl.title = P.unstableWarning || "This site can drop turns";
        unstableEl.addEventListener("click", (e) => { e.stopPropagation(); toast(unstableEl.title); });
        // Inline pill is controlled via hidden attribute, not floating positioning
        if (P.unstableWarning) unstableEl.hidden = false;
      }
      buildMenu();
      // Both bar controls open the same panel; the heart lands on the Support
      // section (last), the model button opens at the top with Switch AI.
      const toggleMenu = (toSupport) => {
        menuEl.hidden = !menuEl.hidden;
        if (!menuEl.hidden) {
          // Rebuild on every open, not just once at page load: the initial
          // buildMenu() call runs before the bridge status (server list/health)
          // has arrived, so the very first render always shows an empty/stale
          // MCP servers section otherwise - nothing ever refreshed it after.
          buildMenu();
          syncMenuPrompt();
          // On a FRESH open, menuEl has no max-height yet - that's only applied by
          // placeBar()'s positioning pass, which runs on the next rAF tick (it's a
          // separate loop, not synchronous with this click). Without it the panel
          // has no overflow yet, so scrollHeight === clientHeight and setting
          // scrollTop here is a no-op - the "jump to Support" silently failed on
          // the very first open (reported live on Arena). Deferring one frame lets
          // placeBar's already-queued tick clip the box first, so there's real
          // scroll room by the time we set scrollTop.
          requestAnimationFrame(() => {
            if (!menuEl.hidden) menuEl.scrollTop = toSupport ?  menuEl.scrollHeight : 0;
          });
        }
      };
      supportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (mcpMenuEl) mcpMenuEl.hidden = true;
        toggleMenu(true);
      });
      if (mcpBtn) {
        mcpBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (menuEl) menuEl.hidden = true;
          mcpMenuEl.hidden = !mcpMenuEl.hidden;
          if (!mcpMenuEl.hidden) {
            buildMcpMenu();
            mcpMenuEl.scrollTop = 0;
          }
        });
      }
      // Engine toggle (Roblox ↔ AgentScript ↔ Animation)
      const engineEl = root.querySelector("#rs-engine");
      currentEngine = "roblox";
      try { chrome.storage.local.get("rs-engine", (o) => { const v = o && o["rs-engine"]; if (v === "local") setEngine("local"); else if (v === "anim" || v === "unreal") { try { chrome.storage.local.set({"rs-engine": "roblox"}); } catch {} setEngine("roblox"); } }); } catch {}
      chrome.storage?.onChanged.addListener((ch, area) => {
        if (area !== "local" || !ch["rs-engine"]) return;
        const v = ch["rs-engine"].newValue === "local" ? "local" : "roblox";
        if (v === currentMode) return;
        if (Date.now() - lastManualEngineAt < 5000) return;
        setEngine(v);
        try { markModesChanged(); } catch {}
      });
      chrome.runtime.onMessage.addListener((m)=>{
        if (!(m && m.type === "rs-engine" && m.engine)) return;
        const v = m.engine === "local" ? "local" : "roblox";
        if (v === currentMode) return;
        if (Date.now() - lastManualEngineAt < 5000) return;
        setEngine(v);
        try { markModesChanged(); } catch {}
      });
      // setStatus lives outside build() — give it a scoped handle so the
      // proc-aware auto-switch can drive the engine without ReferenceErrors.
      engineApi = { set: setEngine, get: () => currentEngine };
      // Expose currentMode for external consumers and keep currentEngine as alias
      let currentMode = currentEngine;
      try { window.__rsMode = () => currentMode; window.__rsEngine = () => currentMode; } catch {}
      function setEngine(v){
        currentEngine = v==="local" ? "local" : "roblox";
        currentMode = currentEngine;
        try { window.__rsMode = () => currentMode; window.__rsEngine = () => currentMode; } catch {}
        if (engineEl) {
          const isLocal = currentMode==="local";
          try {
            const btns = engineEl.querySelectorAll(".rs-mode-btn");
            btns.forEach(b => {
              const isOn = b.dataset.mode === currentMode;
              b.classList.toggle("on", isOn);
              b.setAttribute("aria-selected", isOn ?  "true" : "false");
            });
          } catch {}
          engineEl.title = isLocal ? "AgentScript — click RS for Roblox"
            : "RobloxScript — click AS for AgentScript";
          try { engineEl.setAttribute("data-engine", currentMode); } catch {}
          try { document.documentElement.setAttribute("data-rs-engine", currentMode); } catch {}
          // Update CSS accent via data attribute on #rs-root for per-mode theming
          try { root.setAttribute("data-mode", currentMode); } catch {}
          // Belt-and-suspenders: directly animate the thumb via inline style
          // (works even if the CSS attribute selector is cached/blocked).
          // Two equal segments: RS 0%, AS 100%.
          try {
            const thumb = engineEl.querySelector("#rs-engine-thumb");
            if (thumb) {
              thumb.style.transform = isLocal ? "translateX(100%)" : "translateX(0)";
              thumb.style.background = "transparent";
              thumb.style.borderColor = "#ffffff";
            }
          } catch {}
          const brand = root.querySelector("#rs-brand");
          // Brand stays the central product name in every engine; the pill +
          // switch toast communicate which engine is live.
          if (brand) brand.textContent = BRAND_NAME;
          try { if (cardsBtn) cardsBtn.title = isLocal ? "Session summary \u2014 what the AI did" : "Idea cards \u2014 click to open the inventory"; } catch {}
          // Status dot and brand are tinted via CSS using data-rs-engine — no inline bar styles needed
        }
        // Update bindings that depend on currentMode (colors, restart target, etc.)
        try { updatePerfPill(); } catch {}
        try { renderBar(); } catch {}
        // The library is engine-aware — re-filter an open panel immediately
        // so RS cards never linger after a toggle. Motion lives on Roblox now.
        try {
          if (cardsPanel && !cardsPanel.hidden && (cardsTab === "library" || cardsTab === "motion")) renderCards(cardsPanel);
        } catch {}
      }
      if (engineEl) {
        const engineToast = (next) => {
          const name = next === "local" ? "AgentScript" : "RobloxScript";
          const extra = (A.started || A.running) ? " — restart the agent so it uses this engine" : "";
          toast("Engine: " + name + extra);
          try { markModesChanged(); } catch {}
        };
        // Segmented control: clicks on inner buttons switch mode
        engineEl.addEventListener("click", (e)=>{
          const btn = e.target.closest(".rs-mode-btn");
          if (!btn) return;
          e.stopPropagation();
          const mode = btn.dataset.mode;
          const next = mode === "local" ? "local" : "roblox";
          if (next === currentMode) return;
          lastManualEngineAt = Date.now();
          try { chrome.storage.local.set({"rs-engine": next}); } catch {}
          try { chrome.runtime.sendMessage({type:"rs-set-engine", engine: next}).catch(()=>{}); } catch {}
          setEngine(next);
          engineToast(next);
        });
        // Fallback: clicking the container cycles RS -> AS -> AN
        engineEl.addEventListener("dblclick", (e)=>{
          e.stopPropagation();
          const next = currentMode==="local" ? "roblox" : "local";
          lastManualEngineAt = Date.now();
          try { chrome.storage.local.set({"rs-engine": next}); } catch {}
          try { chrome.runtime.sendMessage({type:"rs-set-engine", engine: next}).catch(()=>{}); } catch {}
          setEngine(next);
          engineToast(next);
        });
      }
      // expose for config.js prompt branching (read synchronously where possible)
      try { window.__rsEngine = () => currentEngine; } catch {}
      openMenuFn = (toSupport) => { if (menuEl.hidden) toggleMenu(toSupport); };
      document.addEventListener("click", (e) => {
        if (menuEl.hidden) return;
        if (!menuEl.contains(e.target) && !supportBtn.contains(e.target))
          menuEl.hidden = true;
      }, true);

      applyTheme();
      applyOrSkin();
      setInterval(applyTheme, 2000); // follow the host page toggling its theme
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind). Restart re-uses the same
    // bootstrap but forces it into an existing chat (see startSession restart).
    function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start" || kind === "start-degraded") { try { playSfx("start"); } catch {} startSession(); }
      else if (kind === "restart") { try { playSfx("start"); } catch {} startSession({ restart: true }); }
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("rsCustomPrompt", (r) => {
        if (r && typeof r.rsCustomPrompt === "string") {
          customPrompt = r.rsCustomPrompt;
          syncMenuPrompt();
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }
    // ── Agent modes (Extra Thinking, Forge GUI, Auto-fix) ─────────────────
    // All four persist. The loads below restore the user's choices after a
    // reload - they used to silently reset to these defaults on every page
    // refresh because only the setters ever touched chrome.storage.
    let autoFixEnabled = true, extraThinking = false, planMode = false, forgeMode = false, autoFixStopPlay = true, autoDebugEnabled = true, multiAgent = false;
    let diagDebug = "off"; // "off" | "basic" | "detailed" | "trace"
    try { window.__rsDiagDebug = () => diagDebug; } catch {}
    let workMode = "balanced";
    try { window.__rsWorkMode = () => workMode; } catch {}
    try { window.__rsPlanMode = () => planMode; } catch {}
    try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
    try { window.__rsMultiAgent = () => multiAgent; } catch {}
    try {
      chrome.storage.local.get(["rs-shot-max", "rs-shot-quality", "rsShotFast", "rsAutoFix", "rsExtraThinking", "rsPlanMode", "rsForgeMode", "rsAutoFixStopPlay", "rsWorkMode", "rsThinkingLevel", "rsSounds", "rsBgMode", "rsAutoDebug", "rsMultiAgent", "rsDiagDebug"], (r) => {
        if (!r) return;
        // rs-shot-max is the single source of truth (0 = send originals).
        {
          const m = Number(r["rs-shot-max"]);
          if (Number.isFinite(m)) shotFast = m > 0;
          else if (typeof r.rsShotFast === "boolean") shotFast = r.rsShotFast;
          try { buildMenu(); } catch {}
        }
        if (typeof r.rsAutoFix === "boolean") autoFixEnabled = r.rsAutoFix;
        if (typeof r.rsExtraThinking === "boolean") {
          extraThinking = r.rsExtraThinking;
          try { window.__rsExtraThinking = () => extraThinking; } catch {}
        }
        if (typeof r.rsPlanMode === "boolean") {
          planMode = r.rsPlanMode;
          try { window.__rsPlanMode = () => planMode; } catch {}
        }
        if (typeof r.rsAutoDebug === "boolean") {
          autoDebugEnabled = r.rsAutoDebug;
          try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
        }
        if (typeof r.rsMultiAgent === "boolean") {
          multiAgent = r.rsMultiAgent;
          try { window.__rsMultiAgent = () => multiAgent; } catch {}
        }
        if (typeof r.rsForgeMode === "boolean") {
          forgeMode = r.rsForgeMode;
          try {
            document.documentElement.setAttribute("data-rs-forge", forgeMode ? "1" : "0");
            window.__rsForge = () => forgeMode;
          } catch {}
        }
        if (typeof r.rsAutoFixStopPlay === "boolean") autoFixStopPlay = r.rsAutoFixStopPlay;
        if (["off", "basic", "detailed", "trace"].includes(r.rsDiagDebug)) {
          diagDebug = r.rsDiagDebug;
          try { window.__rsDiagDebug = () => diagDebug; } catch {}
        }
        
                if (["fast","balanced","thorough"].includes(r.rsWorkMode)) {
          workMode = r.rsWorkMode;
          try { window.__rsWorkMode = () => workMode; } catch {}
        }
        if (!menuEl.hidden) buildMenu();
      });
    } catch {}
    // ── Thinking Level ──
    let thinkingLevel = "default";
    try {
      chrome.storage.local.get("rsThinkingLevel", (r) => {
        if (r && ["default","low","mid","high","max"].includes(r.rsThinkingLevel)) {
          thinkingLevel = r.rsThinkingLevel;
          try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
          if (!menuEl.hidden) buildMenu();
        }
      });
    } catch {}
    try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes) return;
        let dirty = false;
        if (changes.rsExtraThinking && typeof changes.rsExtraThinking.newValue === "boolean") {
          extraThinking = changes.rsExtraThinking.newValue;
          try { window.__rsExtraThinking = () => extraThinking; } catch {}
          dirty = true;
        }
        if (changes.rsPlanMode && typeof changes.rsPlanMode.newValue === "boolean") {
          planMode = changes.rsPlanMode.newValue;
          try { window.__rsPlanMode = () => planMode; } catch {}
          dirty = true;
        }
        if (changes.rsAutoDebug && typeof changes.rsAutoDebug.newValue === "boolean") {
          autoDebugEnabled = changes.rsAutoDebug.newValue;
          try { window.__rsAutoDebug = () => autoDebugEnabled; } catch {}
          dirty = true;
        }
        if (changes.rsMultiAgent && typeof changes.rsMultiAgent.newValue === "boolean") {
          multiAgent = changes.rsMultiAgent.newValue;
          try { window.__rsMultiAgent = () => multiAgent; } catch {}
          dirty = true;
        }
        if (changes.rsForgeMode && typeof changes.rsForgeMode.newValue === "boolean") {
          forgeMode = changes.rsForgeMode.newValue;
          try {
            document.documentElement.setAttribute("data-rs-forge", forgeMode ? "1" : "0");
            window.__rsForge = () => forgeMode;
          } catch {}
          dirty = true;
        }
        if (changes.rsAutoFix && typeof changes.rsAutoFix.newValue === "boolean") {
          autoFixEnabled = changes.rsAutoFix.newValue; dirty = true;
        }
        if (changes.rsAutoFixStopPlay && typeof changes.rsAutoFixStopPlay.newValue === "boolean") {
          autoFixStopPlay = changes.rsAutoFixStopPlay.newValue; dirty = true;
        }
        if (changes.rsBgMode && typeof changes.rsBgMode.newValue === "boolean") {
          bgMode = changes.rsBgMode.newValue; dirty = true;
        }
        if (changes.rsThinkingLevel && ["default","low","mid","high","max"].includes(changes.rsThinkingLevel.newValue)) {
          thinkingLevel = changes.rsThinkingLevel.newValue;
          try { window.__rsThinkingLevel = () => thinkingLevel; } catch {}
          dirty = true;
        }
        if (changes.rsWorkMode && ["fast","balanced","thorough"].includes(changes.rsWorkMode.newValue)) {
          workMode = changes.rsWorkMode.newValue;
          try { window.__rsWorkMode = () => workMode; } catch {}
          dirty = true;
        }
        if (changes.rsPermMode && ["sandbox","ask","full"].includes(changes.rsPermMode.newValue)) {
          permMode = changes.rsPermMode.newValue;
          try { window.__rsPermMode = () => permMode; } catch {}
          dirty = true;
        }
        if (changes.rsTheme && OR_THEMES[changes.rsTheme.newValue]) {
          orTheme = changes.rsTheme.newValue;
          try { applyOrSkin(); } catch {}
          dirty = true;
        }
        if (changes.rsSounds && typeof changes.rsSounds.newValue === "boolean") {
          soundOn = changes.rsSounds.newValue;
          dirty = true;
        }
        if (dirty) {
          try { markModesChanged(); } catch {}
          try { updateExtraButton(); } catch {}
          try { if (typeof buildMenu === "function") buildMenu(); } catch {}
          try { renderBar(); } catch {}
        }
      });
    } catch {}
    function setThinkingLevel(v){
      if (!["default","low","mid","high","max"].includes(v)) return;
      thinkingLevel = v;
      try{ chrome.storage.local.set({rsThinkingLevel: v}); }catch{}
      try{ window.__rsThinkingLevel = () => thinkingLevel; }catch{}
      buildMenu(); markModesChanged();
      if (v !== "default") toast("Thinking level: " + v.toUpperCase());
    }
    // ── Smart Checkpoint & Undo (auto-snapshot before mutating tools) ──
    let rsCheckpoints = [];
    try{ chrome.storage.local.get("rsCheckpoints", r=>{ if(Array.isArray(r.rsCheckpoints)) rsCheckpoints=r.rsCheckpoints; }); }catch{}
    const MUTATING_OPS = new Set(["lighting_set_preset","lighting_setup_day_night","terrain_fill_region","terrain_clear","ui_create_screen","ui_create_component","fx_create_emitter","fx_create_light","fx_create_vfx","audio_setup_sound_hierarchy","audio_create_sound","camera_set_style","datastore_setup","leaderboard_setup","remote_setup","teams_setup","npc_spawn_pathfinding","proximity_setup","tween_create","marketplace_setup","web_fetch","web_search","plugin_create"]);
    function createCheckpoint(op, args){
      try{
        if(/^(get_|list_|web_|or_|debug_)/.test(op) || /_(info|inspect|list)$/.test(op) || op==="get_property") return;
        const cp={op, args: JSON.parse(JSON.stringify(args||{})), at: Date.now()};
        rsCheckpoints.unshift(cp); if(rsCheckpoints.length>12) rsCheckpoints.pop();
        try{ chrome.storage.local.set({rsCheckpoints}); }catch{}
      }catch{}
    }
    function undoLastCheckpoint(){
      try { if (typeof window.__rsUndo === "function") { window.__rsUndo(); return; } } catch {}
      toast("Nothing to undo yet");
    }
    // ── Smart Performance Budget (live part/script estimate) ──
    let perfParts = 0, perfScripts = 0;
    function updatePerfPill(){
      const el = document.getElementById("rs-perf");
      if(!el) return;
      if(perfParts===0 && perfScripts===0){ el.hidden=true; return; }
      el.hidden=false;
      const lvl = perfParts>8000||perfScripts>120 ?  "high" : perfParts>3000||perfScripts>60 ?  "mid" : "low";
      el.dataset.lvl=lvl;
      el.textContent = `${perfParts||0} parts • ${perfScripts||0} scripts`;
      el.title = lvl==="high" ? "High budget — consider optimizing" : lvl==="mid" ? "Moderate budget" : "Budget OK";
    }
    function bumpPerf(op){
      if(op.startsWith("terrain_")) perfParts+=120;
      else if(op.startsWith("fx_")) perfParts+=8;
      else if(op.startsWith("ui_")) perfScripts+=1;
      else if(op.startsWith("audio_")) perfScripts+=1;
      else if(op==="datastore_setup"||op==="leaderboard_setup") perfScripts+=2;
      updatePerfPill();
      try{ chrome.storage.local.set({rsPerf:{parts:perfParts, scripts:perfScripts}}); }catch{}
    }
    try{ chrome.storage.local.get("rsPerf", r=>{ if(r.rsPerf){ perfParts=r.rsPerf.parts||0; perfScripts=r.rsPerf.scripts||0; updatePerfPill(); }}); }catch{}
    // ── Smart Next-Step Suggestions ──
    const NEXT_STEP = {
      lighting_set_preset: "Next: add terrain (terrain_fill_region) or a HUD (ui_create_component)",
      terrain_fill_region: "Next: set lighting (lighting_set_preset) or scatter foliage",
      ui_create_screen: "Next: add a component (ui_create_component) to this ScreenGui",
      ui_create_component: "Next: preview in Studio or add another component",
      fx_create_emitter: "Next: add a light (fx_create_light) or sound",
      datastore_setup: "Next: add a leaderboard (leaderboard_setup) or remotes",
      _default: "Next: run diagnostics_audit to check health"
    };
    function showSuggestion(op){
      const hint = NEXT_STEP[op] || NEXT_STEP._default;
      try{
        const s = document.getElementById("rs-state");
        if(s && !A.running) { /* subtle hint in state line for 4s */ const prev=s.textContent; s.textContent=hint; s.style.opacity="0.95"; setTimeout(()=>{ if(s) { s.textContent=prev; s.style.opacity=""; } }, 4000); }
        else toast(hint);
      }catch{}
    }
    // ── Smart Session Continuity & Auto-Resume ──
    let sessionOps = [];
    try{ chrome.storage.local.get("rsSessionOps", r=>{ if(Array.isArray(r.rsSessionOps)) sessionOps=r.rsSessionOps; }); }catch{}
    function persistSession(op, args, ok){
      try{
        sessionOps.unshift({op, args: JSON.parse(JSON.stringify(args||{})), ok: !!ok, at: Date.now()});
        if(sessionOps.length>20) sessionOps.pop();
        chrome.storage.local.set({rsSessionOps: sessionOps});
      }catch{}
    }
    function tryResumeSession(){
      if(!sessionOps.length) return;
      const last = sessionOps[0];
      if(Date.now()-last.at > 1000*60*30) return; // older than 30m, ignore
      ui.banner("warn","Resume?",`Last session ended on ${last.op} (${last.ok?"OK":"err"}). Re-open the same chat and hit Start to continue.`);
    }
    setTimeout(tryResumeSession, 1800);
    function setAutoFix(v){ autoFixEnabled=!!v; try{chrome.storage.local.set({rsAutoFix: autoFixEnabled});}catch{}; buildMenu(); }
    function setAutoFixStopPlay(v){ autoFixStopPlay=!!v; try{chrome.storage.local.set({rsAutoFixStopPlay: autoFixStopPlay});}catch{}; buildMenu(); }
    // ── Background mode (v1.12): keep working on other sites ──
    function setBgMode(v){
      bgMode = !!v;
      try{ chrome.storage.local.set({rsBgMode: bgMode}); }catch{}
      buildMenu();
      toast(bgMode
        ? "\u{1F310} Background mode ON \u2014 the agent keeps working while you're on other sites"
        : "Background mode OFF \u2014 the agent pauses when this tab is hidden");
    }
    function setWorkMode(id, silent){
      if (!["fast","balanced","thorough"].includes(id)) return;
      workMode = id;
      const preset = {
        fast: { thinking: "low" },
        balanced: { thinking: "mid" },
        thorough: { thinking: "high" },
      }[id];
      thinkingLevel = preset.thinking;
      try {
        chrome.storage.local.set({
          rsWorkMode: workMode,
          rsThinkingLevel: thinkingLevel,
        });
      } catch {}
      try {
        window.__rsWorkMode = () => workMode;
        window.__rsThinkingLevel = () => thinkingLevel;
      } catch {}
      buildMenu(); updateExtraButton(); renderBar(); markModesChanged();
      if (!silent) {
        const label = id === "fast" ? "Fast" : id === "thorough" ? "Thorough" : "Balanced";
        toast("Work mode: " + label + " — Extra Thinking stays " + (extraThinking ? "on" : "off"));
      }
    }
    function setExtraThinking(v){ extraThinking=!!v; try{chrome.storage.local.set({rsExtraThinking: extraThinking});}catch{}; try{ window.__rsExtraThinking = () => extraThinking; }catch{}; buildMenu(); updateExtraButton(); renderBar(); toast(v ? "Extra Thinking on — the AI will review its own work" : "Extra Thinking off"); markModesChanged(); }
    function setPlanMode(v){ planMode=!!v; try{chrome.storage.local.set({rsPlanMode: planMode});}catch{}; try{ window.__rsPlanMode = () => planMode; }catch{}; buildMenu(); renderBar(); toast(v ? "Plan mode on — the AI writes a plan, then production code" : "Plan mode off"); markModesChanged(); }
    function setAutoDebug(v){ autoDebugEnabled=!!v; try{chrome.storage.local.set({rsAutoDebug: autoDebugEnabled});}catch{}; try{ window.__rsAutoDebug = () => autoDebugEnabled; }catch{}; buildMenu(); toast(v ? "Automatic Debugger on — new Studio errors are sent to the AI" : "Automatic Debugger off"); markModesChanged(); }
    function setMultiAgent(v){ multiAgent=!!v; try{chrome.storage.local.set({rsMultiAgent: multiAgent});}catch{}; try{ window.__rsMultiAgent = () => multiAgent; }catch{}; buildMenu(); toast(v ? "Multi-Agent on — planner, builder, reviewer, debugger" : "Multi-Agent off"); markModesChanged(); }
    function setForgeMode(v){ forgeMode=!!v; try{chrome.storage.local.set({rsForgeMode: forgeMode});}catch{}; try{ document.documentElement.setAttribute("data-rs-forge", forgeMode?"1":"0"); window.__rsForge = () => forgeMode; }catch{}; buildMenu(); markModesChanged(); }
    // Toggling a mode mid-session must reach the AI on the NEXT turn, not ~12
    // results later: force the full system prompt (which now carries the
    // EXTRA THINKING / FORGE sections) to ride the next outgoing result.
    function markModesChanged(){ try { if (A.started || A.running) A.forceSysResend = true; } catch {} try { updateExtraButton(); } catch {} }
    function isForgeMode(){ try{ return !!(window.__rsForge && window.__rsForge()); }catch{ return forgeMode; } }
    function updateExtraButton(){
      const eb = document.getElementById("rs-extra");
      if (eb) eb.hidden = true;
      const ub = document.getElementById("rs-undo");
      if (ub) {
        let local = false;
        try { local = activeEngine() === "local"; } catch {}
        ub.hidden = !A.started || local;
      }
    }
    // Auto-fix playtest watcher — polls console whenever autoFix is on and Studio is in Play.
    // User request: "whenever a user plays a playtest in Roblox Studio, and there is an error
    // in the output, it suddenly stops playing and the system automatically copies the error
    // in the output and then pastes it into AI to check and fix it."
    // v1.11 rewrite — the old version re-fired the SAME error forever because:
    //  (a) _autofixBusy was never set, so overlapping 4s ticks double-injected;
    //  (b) the dedupe hash was tail+length, so ANY new console line (prints, the
    //      fix's own output) re-triggered the previous error;
    //  (c) play state was guessed from a fuzzy regex over get_studio_state text,
    //      letting EDIT-mode stale errors trigger a loop that itself stopped Play.
    // Contract now: only fires on errors that appeared AFTER this play session
    // started, at most once per distinct error signature, never while the agent
    // loop itself is mid-turn, with a hard cooldown between injections.
    let _autofixBusy = false;          // re-entrancy guard (actually set now)
    let _autofixLastAt = 0;            // cooldown anchor
    const AUTOFIX_COOLDOWN_MS = 90000; // min gap between two injections
    let _wasPlaying = false;           // play-session edge detector
    let _playBaseline = "";            // console snapshot taken when Play started
    let _reportedSigs = new Set();     // error signatures already fed to the AI
    // Normalize one error line into a stable signature: timestamps, durations,
    // leading line numbers and whitespace stripped, lowercased. Two occurrences
    // of the same runtime error a minute apart must hash identically.
    function _autofixSig(line) {
      return String(line)
        .replace(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, "TS")   // 12:34:56.789 timestamps
        .replace(/\d+(?:\.\d+)?\s*(?:ms|s\b)/gi, "DUR")     // durations
        .replace(/^\s*\d+\s*[.|:|)]\s*/, "")                // "12." / "12:" / "12)" prefixes
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
    // Extract the LAST complete error block (header + its stack) from text.
    function _autofixExtractBlock(txt) {
      const lines = txt.split(/\r?\n/);
      // Walk backwards for a header line: Roblox errors carry "…:NN: message"
      // or an explicit "Error" / "Stack Begin" context.
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l) continue;
        if (/(?:^|\s)(?:error|exception|traceback|failed to load)\b/i.test(l) ||
            /:\d+: .*attempt|:\d+: .*expected|:\d+: .*invalid|:\d+: .*unable/i.test(l)) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return "";
      const out = [];
      // Header first (plus one line of context above when it looks like a
      // "The error occurred in" locator), then the stack block that follows.
      if (idx > 0 && /error occurred/i.test(lines[idx - 1] || "")) out.push(lines[idx - 1]);
      for (let i = idx; i < lines.length && out.length < 22; i++) {
        out.push(lines[i]);
        if (/stack end/i.test(lines[i])) break;
      }
      return out.join("\n").slice(0, 900);
    }
    async function checkPlaytestErrors(){
      try {
        const eng = activeEngine();
        if (eng !== "roblox" && eng !== "anim") return;      // Studio-only feature
      } catch { return; }
      if (!autoFixEnabled || _autofixBusy || (document.hidden && !bgMode)) return;
      if (!A.started) return;                                 // no live session → nothing to feed
      if (A.running || A.starting || A.stopping || A.injecting) return; // never interleave with the loop
      if (Date.now() - _autofixLastAt < AUTOFIX_COOLDOWN_MS) return;
      if (!(A.bridge && (A.bridge.connected || A.bridge.roblox_connected))) return; // Studio path down
      _autofixBusy = true;
      try {
        // 1. Authoritative play probe: execute_luau against the SERVER datamodel
        //    only exists while the game is running. Edit mode answers with a
        //    "...not available..." error — which itself means "not playing".
        let isPlaying = false;
        try {
          const probe = await bg({
            type: "call_tool", name: "execute_luau",
            arguments: {
              code: 'local rs = game:GetService("RunService")\nreturn tostring(rs:IsRunning())',
              datamodel_type: "Server",
            },
            timeout: 15000,
          });
          if (probe && probe.ok && typeof probe.text === "string") {
            isPlaying = /true/i.test(probe.text);
          } else {
            // Server datamodel missing (Edit mode) or Studio offline → not playing.
            isPlaying = false;
          }
        } catch { isPlaying = false; }
        // 2. Play-session edge: snapshot the console at the moment Play starts so
        //    ONLY errors emitted after it count. Old output from previous runs
        //    can never re-trigger the watcher.
        const out = await bg({ type: "call_tool", name: "get_console_output", arguments: {} });
        if (!out || !out.ok || typeof out.text !== "string") return;
        const txt = out.text;
        if (isPlaying && !_wasPlaying) {
          _playBaseline = txt;
          _reportedSigs = new Set();      // fresh session, fresh error memory
          _wasPlaying = true;
          diag("autofix.playstart", { len: txt.length });
        } else if (!isPlaying && _wasPlaying) {
          _wasPlaying = false;
          return;                          // play ended cleanly — nothing to do
        }
        if (!isPlaying) return;
        // 3. Only the output appended since the baseline is eligible.
        let fresh = "";
        if (_playBaseline && txt.startsWith(_playBaseline)) {
          fresh = txt.slice(_playBaseline.length);
        } else if (_playBaseline && txt.length > _playBaseline.length) {
          fresh = txt.slice(-Math.max(200, txt.length - _playBaseline.length)); // rotated/cleared console
        } else if (!_playBaseline) {
          fresh = txt.slice(-1500);        // baseline missed (loaded mid-play): tail only
        }
        if (!/(error|stack begin|exception|traceback|failed to load)/i.test(fresh)) return;
        const errBlock = _autofixExtractBlock(fresh);
        if (!errBlock) return;
        const sig = _autofixSig(errBlock.split(/\r?\n/).find((l) => l && l.trim()) || errBlock);
        if (!sig || _reportedSigs.has(sig)) return;
        _reportedSigs.add(sig);
        _autofixLastAt = Date.now();
        diag("autofix.trigger", { len: txt.length, sig: sig.slice(0, 90) });
        // 4. Stop the playtest (optional) so the error doesn't spam while fixing.
        if (autoFixStopPlay) {
          try { await bg({ type: "call_tool", name: "start_stop_play", arguments: { is_start: false } }); } catch {}
          _wasPlaying = false;
        }
        toast("Playtest error — sending it to the AI to fix");
        // 5. Feed the error to the AI as if the user reported it.
        const prompt =
          "\u26a0\ufe0f PLAYTEST ERROR (auto-captured from Output while the game was running):\n" +
          "```\n" + errBlock + "\n```\n" +
          (autoFixStopPlay
            ? "The playtest was stopped automatically. "
            : "The playtest is still running; it will keep spamming this error until fixed. ") +
          "Fix the script that caused this error. Keep it simple: explain the fix in one sentence, " +
          "then rewrite the script. Do NOT re-run the game yourself — I will playtest again after your fix.";
        const base = await submitAndGetBase(prompt);
        // The normal loop picks the turn up from here.
        diag("autofix.injected", { base });
      } catch (e) { diag("autofix.err", { msg: String(e && e.message || e).slice(0, 120) }); }
      finally { _autofixBusy = false; }
    }
    // Poll every 4s when enabled. Cheap when idle: the guards above return
    // before any tool call unless a session is live AND Studio is playing.
    setInterval(checkPlaytestErrors, 4000);
    // Reflect the saved value back into the menu textarea (unless being edited).
    function syncMenuPrompt() {
      const ta = root && root.querySelector("#rs-set-text");
      if (ta && document.activeElement !== ta) ta.value = customPrompt;
    }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // User-added MCP servers shown at the very bottom of the menu. These are
    // ADDONS: the Roblox server stays primary and is never in this list. Each
    // entry is { id, name, command } - `command` is the raw string the user
    // typed (split into command+args when sent to the bridge). The bridge writes
    // them to config.json and restarts to load them; this local list only drives
    // the menu UI and is kept in sync with the bridge's server health.
    let customMcpServers = [];
    try {
      chrome.storage.local.get("rsCustomMcpServers", (r) => {
        if (r && Array.isArray(r.rsCustomMcpServers)) {
          customMcpServers = r.rsCustomMcpServers;
          if (!menuEl.hidden) buildMenu();
        }
      });
    } catch {}
    function getCustomMcpServers() { return customMcpServers; }
    function saveCustomMcpServers() {
      try { chrome.storage.local.set({ rsCustomMcpServers: customMcpServers }); } catch {}
    }
    const BLENDER_MCP = { id: "blender", name: "Blender", command: "blender-mcp addon :9876" };
    function blenderConnected() {
      if (A.bridge && A.bridge.blender === true) return true;
      const live = ((A.bridge && A.bridge.servers) || []);
      const hit = (s) => /blender/i.test(String((s && (s.id || s.name || s.command)) || ""));
      return live.some((s) => hit(s) && s.alive);
    }
    function syncBlenderFlag() {
      try { window.__rsBlender = () => blenderConnected(); } catch {}
    }
    try { window.__rsBlender = () => blenderConnected(); } catch {}
    // The bridge (config.json + live health) is the SOURCE OF TRUTH for which
    // addon servers actually exist - chrome.storage.local is just a display-name
    // cache, and the two CAN drift (e.g. storage cleared, or config.json edited
    // by hand). Rendering from the bridge's live list means an addon never
    // "disappears" from the menu while still running - and self-heals the local
    // cache the moment we see a server it didn't know about.
    function mergedMcpServers() {
      const live = ((A.bridge && A.bridge.servers) || []).filter((sv) => sv.id !== "roblox");
      const byId = new Map(customMcpServers.map((s) => [s.id, s]));
      const merged = live.map((sv) => {
        const cached = byId.get(sv.id);
        return {
          id: sv.id, name: (cached && cached.name) || sv.id, command: cached && cached.command,
          alive: sv.alive, tools: sv.tools,
        };
      });
      // Self-heal: cache didn't know about a server the bridge actually has.
      let healed = false;
      for (const sv of live) {
        if (!byId.has(sv.id)) { customMcpServers.push({ id: sv.id, name: sv.id }); healed = true; }
      }
      if (healed) saveCustomMcpServers();
      // A server we just added/removed but the bridge hasn't reported back on
      // yet (mid-restart) - still show it, health unknown, so it doesn't blink
      // out of the list during the few seconds the bridge is restarting.
      for (const s of customMcpServers) {
        if (!merged.some((m) => m.id === s.id)) merged.push({ ...s, alive: undefined, tools: undefined });
      }
      return merged;
    }
    // Derive a config-safe server id from a display name (roblox is reserved).
    function mcpSlug(name) {
      let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!s || s === "roblox") s = `addon-${s || "server"}`;
      let id = s, n = 2;
      while (customMcpServers.some((x) => x.id === id)) id = `${s}-${n++}`;
      return id;
    }
    // Split a raw "command with args" string into command + args (shell-lite:
    // whitespace-separated, honouring "double" and 'single' quotes).
    function splitCommand(raw) {
      const parts = String(raw || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const clean = parts.map((p) => p.replace(/^["']|["']$/g, ""));
      return { command: clean[0] || "", args: clean.slice(1) };
    }
    // Wait for the bridge to come back after its restart (config reload). Resolves
    // true once reconnected (optionally once `id` shows up in server health).
    async function waitForBridgeBack(id, timeoutMs = 15000) {
      const t0 = Date.now();
      // Give the bridge a moment to actually drop before we start polling, so we
      // don't instantly match the pre-restart "connected" state.
      await new Promise((r) => setTimeout(r, 1200));
      while (Date.now() - t0 < timeoutMs) {
        const s = await bg({ type: "status" });
        if (s && s.connected) {
          if (!id || (Array.isArray(s.servers) && s.servers.some((x) => x.id === id))) return true;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      return false;
    }

    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control: other AI sites, the custom
    // prompt, and support (Robux). Opens above the bar.
    
    function buildMcpMenu() {
      if (!mcpMenuEl) return;
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const mergedServers = mergedMcpServers();
      let mcpList =
        `<div class="rs-mcp-item rs-mcp-item-primary"><div class="rs-mcp-info"><span class="rs-mcp-name">Roblox Studio</span><span class="rs-mcp-url">primary - probe status above</span></div></div>`;
      mergedServers.forEach((s) => {
        const healthClass = s.alive === true ? "on" : s.alive === false ? "off" : "unknown";
        const healthTitle = s.alive === true ? `${s.tools || 0} tools available` : s.alive === false ? "offline" : "status unknown";
        mcpList += `<div class="rs-mcp-item"><span class="rs-mcp-health rs-mcp-health-${healthClass}" title="${healthTitle}"></span><div class="rs-mcp-info"><span class="rs-mcp-name">${esc(s.name)}</span><span class="rs-mcp-url">${esc(s.command || s.id)}</span></div><button class="rs-mcp-remove" data-id="${esc(s.id)}" title="Remove">✕</button></div>`;
      });

      mcpMenuEl.innerHTML = `
        <div class="rs-menu-head">
          <span class="rs-menu-mark" aria-hidden="true"></span>
          <div class="rs-menu-head-txt">
            <span class="rs-menu-logo">MCP</span>
            <span class="rs-menu-tag">External Tools & Bridges</span>
          </div>
          <span class="rs-menu-glyph">❖</span>
        </div>

        <section class="rs-menu-sec">
          <div class="rs-sec-label"><span>Blender 3D Bridge</span></div>
          <div class="rs-menu-note">Connect to Blender addon on port 9876. Model, animate, and auto-export into Studio.</div>
          <div class="rs-blender-card ${blenderConnected() ? "on" : ""}">
            <div class="rs-blender-top">
              <span class="rs-blender-mark" aria-hidden="true"></span>
              <div class="rs-blender-copy">
                <span class="rs-blender-name">Blender MCP</span>
                <span class="rs-blender-sub">${blenderConnected() ? "Live — model here, export FBX into Studio." : "Addon running in Blender? N-panel → Start MCP Server, then connect."}</span>
              </div>
              <span class="rs-blender-pill">${blenderConnected() ? "on" : "off"}</span>
            </div>
            <div class="rs-blender-actions">
              <button type="button" id="rs-mcp-blender">${blenderConnected() ? "Reconnect Blender" : "Connect Blender"}</button>
              ${blenderConnected() ? '<button type="button" class="rs-blender-off" id="rs-mcp-blender-off">Disconnect</button>' : ""}
              <button type="button" class="rs-blender-link" id="rs-blender-site">blender.org</button>
            </div>
          </div>
        </section>

        <section class="rs-menu-sec">
          <div class="rs-sec-label"><span>Figma Live Bridge</span></div>
          <div class="rs-menu-note">Live canvas bridge on port 9878. AI designs frames & components in Figma and auto-exports to ScreenGui.</div>
          <div class="rs-blender-card ${figmaConnectedCached ? "on" : ""}">
            <div class="rs-blender-top">
              <span class="rs-blender-mark" aria-hidden="true" style="background:#38bdf8;"></span>
              <div class="rs-blender-copy">
                <span class="rs-blender-name">Figma Desktop Plugin</span>
                <span class="rs-blender-sub">${figmaConnectedCached ? "Live (Port 9878) — AI builds in Figma & auto-exports." : "Import or-figma-plugin/manifest.json in Figma Desktop."}</span>
              </div>
              <span class="rs-blender-pill" style="${figmaConnectedCached ? "background:#10b981;color:#fff;" : ""}">${figmaConnectedCached ? "on" : "off"}</span>
            </div>
            <div class="rs-blender-actions">
              <button type="button" id="rs-mcp-figma-toggle">${figmaConnectedCached ? "Disconnect" : "Connect Figma"}</button>
              <button type="button" id="rs-mcp-figma-export">Export Selection</button>
            </div>
          </div>
        </section>

        <section class="rs-menu-sec">
          <div class="rs-sec-label"><span>Custom MCP Servers</span></div>
          <div class="rs-menu-note">Roblox Studio is primary. Add additional local MCP servers below.</div>
          ${mcpList}
          <div class="rs-mcp-sep"></div>
          <input id="rs-mcp-name" class="rs-mcp-field" placeholder="Name, e.g. Sketchfab" />
          <input id="rs-mcp-url" class="rs-mcp-field" placeholder="Start command, e.g. npx -y @some/mcp-server" />
          <div class="rs-set-row">
            <button id="rs-mcp-add">Add server</button>
            <button id="rs-mcp-repair" title="Restart Studio MCP helper">Repair Studio</button>
            <span id="rs-mcp-status"></span>
          </div>
        </section>
        <div class="rs-menu-foot">OR External Tools • Port 3000 / 9876 / 9878</div>
      `;

      // Wire Blender controls in MCP menu
      const bBtn = mcpMenuEl.querySelector("#rs-mcp-blender");
      const bOff = mcpMenuEl.querySelector("#rs-mcp-blender-off");
      const bSite = mcpMenuEl.querySelector("#rs-blender-site");
      if (bBtn) bBtn.addEventListener("click", () => {
        bg({ type: "blender_connect" }).then((r) => {
          if (r && r.ok) {
            rememberBlender();
            toast("Blender MCP connected!");
            playSfx("ok");
            buildMcpMenu();
          } else {
            toast("Blender MCP not found on port 9876.");
            playSfx("error");
          }
        });
      });
      if (bOff) bOff.addEventListener("click", () => {
        disconnectBlender();
        toast("Blender disconnected");
        buildMcpMenu();
      });
      if (bSite) bSite.addEventListener("click", () => {
        window.open("https://www.blender.org/download/", "_blank", "noopener");
      });

      // Wire Figma controls in MCP menu
      const fBtn = mcpMenuEl.querySelector("#rs-mcp-figma-toggle");
      const fExport = mcpMenuEl.querySelector("#rs-mcp-figma-export");
      if (fBtn) fBtn.addEventListener("click", async () => {
        if (!figmaConnectedCached) {
          toast("Connecting to Figma Bridge on port 9878…");
          const res = await bg({ type: "figma_connect" });
          if (res && res.ok) {
            figmaConnectedCached = true;
            try { chrome.storage.local.set({ rsFigmaConnected: true }); } catch {}
            toast("Figma Bridge connected!");
            playSfx("ok");
          } else {
            toast("Could not reach Figma on port 9878. Is plugin running?");
            playSfx("error");
          }
        } else {
          await bg({ type: "figma_disconnect" });
          figmaConnectedCached = false;
          try { chrome.storage.local.set({ rsFigmaConnected: false }); } catch {}
          toast("Figma disconnected");
        }
        buildMcpMenu();
      });
      if (fExport) fExport.addEventListener("click", () => {
        toast("Exporting Figma selection to Roblox Studio…");
      });

      // Wire custom MCP Add/Remove
      const addBtn = mcpMenuEl.querySelector("#rs-mcp-add");
      const repBtn = mcpMenuEl.querySelector("#rs-mcp-repair");
      const nameIn = mcpMenuEl.querySelector("#rs-mcp-name");
      const urlIn = mcpMenuEl.querySelector("#rs-mcp-url");
      const stat = mcpMenuEl.querySelector("#rs-mcp-status");

      if (addBtn) addBtn.addEventListener("click", () => {
        const name = (nameIn.value || "").trim();
        const url = (urlIn.value || "").trim();
        if (!name || !url) { if (stat) stat.textContent = "Fill name and command"; return; }
        const s = { id: "mcp_" + Date.now(), name, command: url, alive: true };
        customMcpServers.push(s);
        try { chrome.storage.local.set({ rsMcpServers: customMcpServers }); } catch {}
        nameIn.value = ""; urlIn.value = "";
        buildMcpMenu();
      });

      if (repBtn) repBtn.addEventListener("click", () => {
        toast("Restarting Studio MCP helper…");
        bg({ type: "studio_mcp_repair" }).then(() => toast("Studio MCP helper restarted"));
      });

      mcpMenuEl.querySelectorAll(".rs-mcp-remove").forEach((rm) => {
        rm.addEventListener("click", () => {
          const id = rm.dataset.id;
          customMcpServers = customMcpServers.filter((x) => x.id !== id);
          try { chrome.storage.local.set({ rsMcpServers: customMcpServers }); } catch {}
          buildMcpMenu();
        });
      });
    }

    function buildMenu() {
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      let sites = "";
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const label = `<span class="rs-site-name"><span>${s.name}</span><span class="rs-site-host">${hostOf(s.url)}</span></span>`;
        sites += current
          ? `<div class="rs-site-opt rs-site-here">${label}<span class="rs-site-badge">active</span></div>`
          : `<button class="rs-site-opt" data-u="${s.url}">${label}<span class="rs-site-go">&rarr;</span></button>`;
      }
      let passes = "";
      for (const p of ROBUX_PASSES) {
        passes += `<button class="rs-tip-opt rs-tip-rbx" data-u="${passUrl(p.id)}" data-pass="${p.id}"><span class="rs-rbx-cur">R$</span><span class="rs-rbx-amt"></span></button>`;
      }
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const mergedServers = mergedMcpServers();
      // Roblox always heads the list as the primary target. Its health is shown
      // by the main status dot and it cannot be removed from this menu.
      let mcpList =
        `<div class="rs-mcp-item rs-mcp-item-primary"><div class="rs-mcp-info"><span class="rs-mcp-name">Roblox Studio</span><span class="rs-mcp-url">primary - probe status above</span></div></div>`;
      mergedServers.forEach((s, i) => {
        // alive === undefined -> the bridge hasn't reported this server's health
        // yet (just added/removed, still restarting) - shown neutral, not red.
        const healthClass = s.alive === true ?  "on" : s.alive === false ?  "off" : "unknown";
        const healthTitle = s.alive === true ?  `${s.tools || 0} tools available` : s.alive === false ?  "offline" : "status unknown";
        mcpList += `<div class="rs-mcp-item"><span class="rs-mcp-health rs-mcp-health-${healthClass}" title="${healthTitle}"></span><div class="rs-mcp-info"><span class="rs-mcp-name">${esc(s.name)}</span><span class="rs-mcp-url">${esc(s.command || s.id)}</span></div><button class="rs-mcp-remove" data-id="${esc(s.id)}" title="Remove">✕</button></div>`;
      });
      menuEl.innerHTML =
        `<div class="rs-menu-head"><span class="rs-menu-mark" aria-hidden="true"></span><div class="rs-menu-head-txt"><span class="rs-menu-logo">OR</span><span class="rs-menu-tag">v${EXT_VERSION} · ${(OR_THEMES[orTheme]&&OR_THEMES[orTheme].name)||"Night"}</span></div><span class="rs-menu-glyph">${(OR_THEMES[orTheme]&&OR_THEMES[orTheme].glyph)||"☾"}</span></div>

         <section class="rs-menu-sec">
           <div class="rs-sec-label"><span>Switch AI</span></div>
           ${sites}
         </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Help</span></div>
            <button class="rs-tip-opt rs-tip-star" id="rs-menu-tutorial"><span>Read the Tutorial</span><span class="rs-tip-sub">text walkthrough \u2014 always up to date</span></button>
            ${WORKINK_URL ?  `<button class="rs-tip-opt rs-tip-ad" data-u="${WORKINK_URL}"><span>Watch an ad to support</span><span class="rs-tip-sub">free, takes a minute</span></button>` : ""}
          </section>
         <section class="rs-menu-sec">
           <div class="rs-sec-label"><span>Support with Robux</span></div>
             <div class="rs-rbx-grid">${passes}</div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Work mode</span></div>
              <div class="rs-menu-note">How hard the AI plans. Extra Thinking is its own toggle below — work mode will not turn it off.</div>
              <div class="rs-work-row">
                <button type="button" class="rs-work-card ${workMode==="fast"?"on":""}" data-work="fast"><span class="rs-work-name">Fast</span><span class="rs-work-sub">Short path, low thinking</span></button>
                <button type="button" class="rs-work-card ${workMode==="balanced"?"on":""}" data-work="balanced"><span class="rs-work-name">Balanced</span><span class="rs-work-sub">Plan, build, one check</span></button>
                <button type="button" class="rs-work-card ${workMode==="thorough"?"on":""}" data-work="thorough"><span class="rs-work-name">Thorough</span><span class="rs-work-sub">High thinking, then verify</span></button>
              </div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Permissions</span></div>
              <div class="rs-menu-note">Sandbox = Studio and the project folder. Ask = confirm each write. Full = the whole PC (AgentScript).</div>
              <div class="rs-work-row">
                <button type="button" class="rs-work-card ${permMode==="sandbox"?"on":""}" data-perm="sandbox"><span class="rs-work-name">Sandbox</span><span class="rs-work-sub">Roblox / workspace only</span></button>
                <button type="button" class="rs-work-card ${permMode==="ask"?"on":""}" data-perm="ask"><span class="rs-work-name">Ask</span><span class="rs-work-sub">Confirm each write / run</span></button>
                <button type="button" class="rs-work-card ${permMode==="full"?"on":""}" data-perm="full"><span class="rs-work-name">Full</span><span class="rs-work-sub">All PC files + processes</span></button>
              </div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Theme</span></div>
              <div class="rs-menu-note">${(OR_THEMES[orTheme] && OR_THEMES[orTheme].blurb) || "Pick a chrome skin. Colors, glows, and labels all follow it."}</div>
              <div class="rs-work-row rs-theme-row">
                ${Object.keys(OR_THEMES).map((id) => {
                  const th = OR_THEMES[id];
                  let art = "";
                  try { art = chrome.runtime.getURL("ui/swatch-" + id + ".jpg"); } catch (e) {}
                  return `<button type="button" class="rs-work-card rs-theme-card ${orTheme===id?"on":""}" data-theme="${id}"><span class="rs-theme-art"${art ? ` style="background-image:url('${art}')"` : ""}></span><span class="rs-work-glyph">${th.glyph||""}</span><span class="rs-work-name">${th.name}</span><span class="rs-work-sub">${th.sub}</span></button>`;
                }).join("")}
              </div>
            </section>
            <section class="rs-menu-sec">
              <div class="rs-sec-label"><span>Thinking</span></div>
              <div class="rs-menu-note">How much the AI plans and self-reviews. Higher is slower and more careful. Extra Thinking is a separate toggle.</div>
              <div class="rs-thinking-row">
                ${["default","low","mid","high","max"].map(l => `<button class="rs-lvl-btn ${thinkingLevel===l?"on":""}" data-lvl="${l}" title="Set thinking level: ${l}">${l[0].toUpperCase()+l.slice(1)}</button>`).join("")}
              </div>
              <div class="rs-menu-note" id="rs-thinking-hint" style="margin-top:8px;">${thinkingLevel==="default" ? "Default — this site picks its own thinking depth." : `Level ${thinkingLevel.toUpperCase()} — applied on the next turn.`}</div>
            </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Agent modes</span></div>
            <div class="rs-tgl-row" data-mode="bgmode" role="switch" aria-checked="${bgMode}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Work in background tabs</span>
              <span class="rs-tgl-sub">Keep building while you browse other sites — this tab can stay in the background.</span></span>
              <span class="rs-tgl ${bgMode ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="autofix" role="switch" aria-checked="${autoFixEnabled}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Auto-fix playtest errors</span>
              <span class="rs-tgl-sub">Watches Output during Play and sends new errors to the AI.</span></span>
              <span class="rs-tgl ${autoFixEnabled ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row rs-tgl-sub-row" data-mode="autofixstop" role="switch" aria-checked="${autoFixStopPlay}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Stop playtest on error</span>
              <span class="rs-tgl-sub">Stop Play when an error is caught (off = keep playing while the AI fixes it).</span></span>
              <span class="rs-tgl ${autoFixStopPlay ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="extra" role="switch" aria-checked="${extraThinking}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Extra Thinking</span>
              <span class="rs-tgl-sub">The AI reviews its own work and iterates until it is satisfied.</span></span>
              <span class="rs-tgl ${extraThinking ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="plan" role="switch" aria-checked="${planMode}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Plan mode</span>
              <span class="rs-tgl-sub">First a written plan, then production-quality scripts — no stubs, no leftover prints.</span></span>
              <span class="rs-tgl ${planMode ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="autodebug" role="switch" aria-checked="${autoDebugEnabled}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Automatic Debugger</span>
              <span class="rs-tgl-sub">After Studio edits, new Output errors are sent to the AI to fix.</span></span>
              <span class="rs-tgl ${autoDebugEnabled ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="multiagent" role="switch" aria-checked="${multiAgent}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Multi-Agent</span>
              <span class="rs-tgl-sub">Planner → builder → reviewer → debugger. Call or_agent to hand off.</span></span>
              <span class="rs-tgl ${multiAgent ? "on" : ""}"></span>
            </div>
            <div class="rs-tgl-row" data-mode="sounds" role="switch" aria-checked="${soundOn}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Sound effects</span>
              <span class="rs-tgl-sub">Chime when the agent starts, finishes, or errors.</span></span>
              <span class="rs-tgl ${soundOn ? "on" : ""}"></span>
            </div>
          </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Captures</span></div>
            <div class="rs-tgl-row" data-mode="fastshots" role="switch" aria-checked="${shotFast}" tabindex="0">
              <span class="rs-tgl-info"><span class="rs-tgl-name">Fast screenshots</span>
              <span class="rs-tgl-sub">Resize captures over 350 KB to 1400 px before upload — a screenshot arrives much quicker, still readable. Off = full-size originals.</span></span>
              <span class="rs-tgl ${shotFast ? "on" : ""}"></span>
            </div>
          </section>
            
                    <section class="rs-menu-sec" id="rs-diag-sec">
            <div class="rs-sec-label"><span>Diagnostic Debug System</span></div>
            <div class="rs-menu-note">Embeds structured runtime observability directly into scripts (no separate module). Tracks earnings/losses, trajectories, state transitions, and pre-failure histories without Output spam.</div>
            <div class="rs-diag-row">
              <button type="button" class="rs-diag-btn ${diagDebug === "off" ? "on" : ""}" data-diag="off" title="Disabled — zero overhead, no diagnostics, silent">Off</button>
              <button type="button" class="rs-diag-btn ${diagDebug === "basic" ? "on" : ""}" data-diag="basic" title="Basic — critical events, state transitions, failures, and transactions">Basic</button>
              <button type="button" class="rs-diag-btn ${diagDebug === "detailed" ? "on" : ""}" data-diag="detailed" title="Detailed — adds periodic 0.5s snapshots, calculations, and bounded history">Detailed</button>
              <button type="button" class="rs-diag-btn ${diagDebug === "trace" ? "on" : ""}" data-diag="trace" title="Trace — deep state tracking and high-frequency diagnostics for elusive bugs">Trace</button>
            </div>
            <div class="rs-menu-note" style="margin-top:4px;">${
              diagDebug === "off" ? "Disabled — scripts run with standard code and no diagnostic overhead." :
              diagDebug === "basic" ? "Basic — tracks critical transactions, state shifts, and failures directly in code." :
              diagDebug === "detailed" ? "Detailed — includes periodic snapshots (trajectories, calculations) in bounded buffers." :
              "Trace — maximum internal state tracking and deep failure context."
            }</div>
          </section>

          <section class="rs-menu-sec" id="rs-checkpoint-sec">
            <div class="rs-sec-label"><span>Recent Checkpoints</span></div>
            <div class="rs-menu-note">Saved before each change. Use Studio Undo (Ctrl+Z) if needed. Last 10 kept.</div>
            <div id="rs-checkpoint-list" class="rs-checkpoint-list">${(() => {
              if (!rsCheckpoints.length) return `<div style="font-size:11px;color:#9aa0a8;">No checkpoints yet — run a command to create one.</div>`;
              return rsCheckpoints.slice(0,5).map((cp,i)=>`<div class="rs-checkpoint-item"><span class="rs-checkpoint-op">${esc(cp.op)}</span><span class="rs-checkpoint-time">${new Date(cp.at).toLocaleTimeString()}</span><button class="rs-checkpoint-undo" data-idx="${i}">Undo</button></div>`).join("");
            })()}</div>
          </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Image to model</span></div>
            <div class="rs-menu-note">Pastes a proven builder template into the composer. Attach your reference image, hit send, and a vision-capable AI builds it step by step (study → plan → build → screenshot-compare → refine).</div>
            <div class="rs-set-row"><button id="rs-i2m-btn">🖼 Paste builder template</button><span id="rs-i2m-status"></span></div>
          </section>
          <section class="rs-menu-sec">
            <div class="rs-sec-label"><span>Custom prompt</span></div>
            <div class="rs-menu-note">Added below the system prompt on every new session. The built-in prompt can't be edited.</div>
            <textarea id="rs-set-text" rows="4" placeholder="e.g. Always comment your Luau code. Prefer small modular scripts."></textarea>
            <div class="rs-set-row"><button id="rs-set-save">Save</button><span id="rs-set-status"></span></div>
          </section>
          
          <div class="rs-menu-foot">OR v${EXT_VERSION} • ${currentEngine==="local"?"AS":currentEngine==="anim"?"AN":"RS"} • ${esc(P.displayName)}</div>`;
      const open = (url) => {
        try {
          if(url && url.startsWith("ollama://")){
            const u = chrome.runtime.getURL("ollama.html");
            window.open(u, "_blank", "noopener");
          } else if(url) window.open(url, "_blank", "noopener");
        } catch {} menuEl.hidden = true;
      };
      menuEl.querySelectorAll("button.rs-site-opt, .rs-tip-opt:not([data-mode])").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      try { fillRobuxPrices(menuEl); } catch (e) {}
      // In-app tutorial (no external link): opens the centered modal.
      // Tab bar switching
      menuEl.querySelectorAll(".rs-menu-tab-btn").forEach((tBtn) => {
        tBtn.addEventListener("click", () => {
          const tab = tBtn.dataset.tab;
          if (tab && tab !== menuActiveTab) {
            menuActiveTab = tab;
            buildMenu();
          }
        });
      });

      // Figma Connect Tab Buttons
      const figmaTabConnect = menuEl.querySelector("#rs-figma-tab-connect");
      if (figmaTabConnect) {
        figmaTabConnect.addEventListener("click", async () => {
          if (!figmaConnectedCached) {
            toast("Connecting to Figma Bridge on port 9878…");
            const res = await bg({ type: "figma_connect" });
            if (res && res.ok) {
              figmaConnectedCached = true;
              try { chrome.storage.local.set({ rsFigmaConnected: true }); } catch {}
              toast("Figma Bridge connected!");
              playSfx("ok");
            } else {
              toast("Could not reach Figma on port 9878. Make sure the Figma plugin is running.");
              playSfx("error");
            }
          } else {
            await bg({ type: "figma_disconnect" });
            figmaConnectedCached = false;
            try { chrome.storage.local.set({ rsFigmaConnected: false }); } catch {}
            toast("Figma disconnected");
          }
          buildMenu();
        });
      }

      const figmaTabExport = menuEl.querySelector("#rs-figma-tab-export");
      if (figmaTabExport) {
        figmaTabExport.addEventListener("click", () => {
          toast("Exporting Figma selection to Roblox Studio…");
        });
      }

      const tutBtn = menuEl.querySelector("#rs-menu-tutorial");
      if (tutBtn) tutBtn.addEventListener("click", () => { menuEl.hidden = true; openTutorial(); });
      const ta = menuEl.querySelector("#rs-set-text");
      const saveBtn = menuEl.querySelector("#rs-set-save");
      const status = menuEl.querySelector("#rs-set-status");
      ta.value = customPrompt;
      saveBtn.addEventListener("click", () => {
        customPrompt = ta.value;
        try { chrome.storage.local.set({ rsCustomPrompt: customPrompt }); } catch {}
        status.textContent = "Saved ✓";
        setTimeout(() => { status.textContent = ""; }, 1600);
      });
      menuEl.querySelectorAll("[data-mode]").forEach(btn=>{
        const flip = () => {
          const m=btn.dataset.mode;
          if(m==="autofix") setAutoFix(!autoFixEnabled);
          else if(m==="autofixstop") setAutoFixStopPlay(!autoFixStopPlay);
          else if(m==="bgmode") setBgMode(!bgMode);
          else if(m==="extra") setExtraThinking(!extraThinking);
          else if(m==="plan") setPlanMode(!planMode);
          else if(m==="autodebug") setAutoDebug(!autoDebugEnabled);
          else if(m==="multiagent") setMultiAgent(!multiAgent);
          else if(m==="fastshots") setShotFast(!shotFast);
          else if(m==="sounds") { setSounds(!soundOn); try { buildMenu(); toast(soundOn ? "Sound effects on" : "Sound effects off"); if (soundOn) playSfx("ok"); } catch {} }
        };
        btn.addEventListener("click", flip);
        btn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
        });
      });
      // ── Image → Model: paste the vision builder template ──
            // ── Visual Reference settings events ──
      const refModeGuiBtn = menuEl.querySelector("#rs-ref-mode-gui");
      const refModeBuildBtn = menuEl.querySelector("#rs-ref-mode-build");
      if (refModeGuiBtn) refModeGuiBtn.addEventListener("click", () => setVisualRefMode("gui"));
      if (refModeBuildBtn) refModeBuildBtn.addEventListener("click", () => setVisualRefMode("build"));

      // ── Diagnostic Debug System buttons ──
      menuEl.querySelectorAll(".rs-diag-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const lvl = btn.getAttribute("data-diag");
          if (lvl) setDiagDebug(lvl);
        });
      });

      const i2mBtn = menuEl.querySelector("#rs-i2m-btn");
      if (i2mBtn) i2mBtn.addEventListener("click", () => {
        let visionOk = false;
        try { visionOk = typeof P.supportsVision === "function" ? !!P.supportsVision() : !!P.supportsVision; } catch {}
        if (!visionOk) {
          // Honest refusal: a non-vision chat can never see the attached image,
          // so the flow would silently build from nothing.
          const st = menuEl.querySelector("#rs-i2m-status");
          if (st) { st.textContent = "This site can't read images"; setTimeout(() => { st.textContent = ""; }, 2600); }
          toast("This chat can't see images — open DeepSeek, Gemini, Kimi, GLM, Qwen, or Meta.");
          return;
        }
        const tpl = RS.buildImageToModelPrompt("", activeEngine());
        const fakeCard = { prompt: tpl, title: "Image \u2192 Model", icon: "\u{1F5BC}\uFE0F", cat: "Vision", engine: "rs", desc: "" };
        const pasted = pasteLibraryCard(fakeCard, { silent: true });
        menuEl.hidden = true;
        toast(pasted
          ? "\u{1F5BC}\uFE0F Template pasted \u2014 now ATTACH your reference image and send."
          : "Open a chat first \u2014 composer not found.");
      });
      const mcpNameEl = menuEl.querySelector("#rs-mcp-name");
      const mcpUrlEl = menuEl.querySelector("#rs-mcp-url");
      const mcpStatus = menuEl.querySelector("#rs-mcp-status");
      const mcpAddBtn = menuEl.querySelector("#rs-mcp-add");
      const mcpRepairBtn = menuEl.querySelector("#rs-mcp-repair");
      // Disable every add/remove control and show the restart spinner. Adding or
      // removing a server rewrites config.json and restarts the whole bridge, so
      // no other server edit may run until it is back.
      let mcpBusy = false;
      function setMcpBusy(on, label) {
        mcpBusy = on;
        mcpAddBtn.disabled = on;
        if (mcpRepairBtn) mcpRepairBtn.disabled = on;
        menuEl.querySelectorAll(".rs-mcp-remove").forEach((b) => (b.disabled = on));
        mcpStatus.innerHTML = on
          ? `<span class="rs-mcp-spin-row"><span class="rs-mcp-spin"></span>${label || "Restarting bridge…"}</span>`
          : "";
      }

      // ── Repair Studio link (v1.12): restart the StudioMCP helper ──
      // The agent exe only recycles a DEAD helper when a tool call proves it
      // dead; after a Studio update or sleep/resume the helper can sit dead
      // between calls ("connected" pill, every command failing). This forces a
      // restart on demand and waits for the bridge to come back.
      if (mcpRepairBtn) mcpRepairBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        setMcpBusy(true, "Restarting Studio MCP…");
        const r = await bg({ type: "restart_mcp" });
        if (!r || r.ok === false) {
          setMcpBusy(false);
          mcpStatus.textContent = (r && r.error) || "Restart failed — is or-agent.exe running?";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 3200);
          return;
        }
        await waitForBridgeBack(null);
        buildMenu();
        toast("Studio MCP restarted — try that command again");
      });

      menuEl.querySelectorAll(".rs-mcp-remove").forEach((b) =>
        b.addEventListener("click", async () => {
          if (mcpBusy) return;
          const id = b.dataset.id;
          if (!id) return;
          setMcpBusy(true, "Restarting bridge…");
          const r = await bg({ type: "remove_server", server_id: id });
          if (!r || !r.ok) {
            setMcpBusy(false);
            mcpStatus.textContent = (r && r.error) || "Couldn't remove server";
            setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
            return;
          }
          customMcpServers = customMcpServers.filter((s) => s.id !== id);
          saveCustomMcpServers();
          await waitForBridgeBack(null);
          buildMenu(); // rebuilds with the spinner cleared
        }));

      mcpAddBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        const name = mcpNameEl.value.trim();
        const command = mcpUrlEl.value.trim();
        if (!name || !command) {
          mcpStatus.textContent = "Name and command required";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 1800);
          return;
        }
        const id = mcpSlug(name);
        const { command: cmd, args } = splitCommand(command);
        setMcpBusy(true, "Restarting bridge…");
        const r = await bg({ type: "add_server", server_id: id, command: cmd, args });
        if (!r || !r.ok) {
          setMcpBusy(false);
          mcpStatus.textContent = (r && r.error) || "Couldn't add server";
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 2400);
          return;
        }
        customMcpServers.push({ id, name, command });
        saveCustomMcpServers();
        await waitForBridgeBack(id);
        syncBlenderFlag();
        buildMenu(); // rebuilds with the new server listed + spinner cleared
      });

      const blenderBtn = menuEl.querySelector("#rs-mcp-blender");
      if (blenderBtn) blenderBtn.addEventListener("click", async () => {
        if (mcpBusy) return;
        setMcpBusy(true, "Checking Blender on port 9876…");
        const r = await bg({ type: "blender_connect" });
        setMcpBusy(false);
        if (!r || !r.ok) {
          const err = String((r && r.error) || "Couldn't reach Blender").slice(0, 180);
          mcpStatus.textContent = err;
          try { toast(err); playSfx("error"); } catch {}
          setTimeout(() => { if (!mcpBusy) mcpStatus.textContent = ""; }, 8000);
          syncBlenderFlag();
          buildMenu();
          return;
        }
        customMcpServers = customMcpServers.filter((s) => s.id !== "blender");
        saveCustomMcpServers();
        try { A.toolsAt = 0; } catch {}
        try { await ensureTools(true); } catch {}
        syncBlenderFlag();
        try { toast("Blender connected — restart the agent so it sees Blender tools"); playSfx("ok"); } catch {}
        buildMenu();
      });
      const blenderOff = menuEl.querySelector("#rs-mcp-blender-off");
      if (blenderOff) blenderOff.addEventListener("click", async () => {
        if (mcpBusy) return;
        setMcpBusy(true, "Disconnecting Blender…");
        await bg({ type: "blender_disconnect" });
        setMcpBusy(false);
        try { A.toolsAt = 0; } catch {}
        try { await ensureTools(true); } catch {}
        syncBlenderFlag();
        try { toast("Blender disconnected"); playSfx("ok"); } catch {}
        buildMenu();
      });
      const blenderSite = menuEl.querySelector("#rs-blender-site");
      if (blenderSite) blenderSite.addEventListener("click", () => {
        try { window.open("https://www.blender.org/", "_blank", "noopener"); } catch {}
      });

      // ── Work mode cards ──
      menuEl.querySelectorAll("[data-work]").forEach(btn=>{
        btn.addEventListener("click", () => setWorkMode(btn.dataset.work));
      });
      menuEl.querySelectorAll("[data-theme]").forEach(btn=>{
        btn.addEventListener("click", () => {
          setOrTheme(btn.dataset.theme);
          try { buildMenu(); } catch {}
          const th = OR_THEMES[orTheme];
          try { toast("Theme: " + (th ? th.name : orTheme)); playSfx("ok"); } catch {}
        });
      });
      menuEl.querySelectorAll("[data-perm]").forEach(btn=>{
        btn.addEventListener("click", () => {
          setPermMode(btn.dataset.perm);
          try { buildMenu(); } catch {}
          const label = permMode === "full" ? "Full PC access" : permMode === "ask" ? "Ask before acting" : "Sandbox (Studio + workspace)";
          try { toast("Permissions: " + label); } catch {}
        });
      });
      // ── Thinking level buttons ──
      menuEl.querySelectorAll(".rs-lvl-btn").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          setThinkingLevel(btn.dataset.lvl);
          menuEl.querySelectorAll(".rs-lvl-btn").forEach(b=>b.classList.toggle("on", b.dataset.lvl===btn.dataset.lvl));
          const hint = menuEl.querySelector("#rs-thinking-hint");
          if (hint) hint.textContent = btn.dataset.lvl==="default" ? "Default — this site picks its own thinking depth." : "Level " + btn.dataset.lvl.toUpperCase() + " — applied on the next turn.";
        });
      });
      // ── Checkpoints undo ──
      menuEl.querySelectorAll(".rs-checkpoint-undo").forEach(btn=>{
        btn.addEventListener("click", ()=>{ undoLastCheckpoint(); });
      });
    }

    // ── Cards (lemonade.gg-style mechanic library + activity feed) ──────────
    // Lemonade's model: a card INVENTORY of pre-made game mechanics you drop
    // into your project; the embedded multi-step prompt drives the agent.
    // Panel = two tabs: Library (engine-aware mechanic cards, click-to-run +
    // native drag into any input) and Activity (live tool-result feed).
    let recentCards = [];
    let cardsTab = "library";
    let visibleLibCache = [];
    let cardsQuery = "";
    function escRs(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function trackCard(tool, status, detail, category) {
      const top = recentCards[0];
      if (top && top.tool === tool && top.status === "run" && status !== "run") {
        top.status = status;
        top.detail = String(detail || "").slice(0, 120);
        top.at = Date.now();
      } else {
        recentCards.unshift({ tool, status, detail: String(detail || "").slice(0, 120), category: category || "tool", at: Date.now() });
        if (recentCards.length > 24) recentCards.pop();
      }
      if (cardsTab === "activity" || (activeEngine() === "local" && cardsPanel && !cardsPanel.hidden)) renderCards(cardsPanel);
    }

    const RNG_TOPICS = [
      { title: "+1 Keyboard", desc: "Every kill drops a keyboard. Stack them for damage." },
      { title: "Survive the Apocalypse", desc: "Last squad standing as the city falls apart." },
      { title: "+1 Speed every second", desc: "WalkSpeed never stops climbing. Don't fly off the map." },
      { title: "The Floor is Lava", desc: "Platforms crumble. Don't touch red." },
      { title: "Find the Buttons", desc: "Hidden buttons open the exit before the timer hits zero." },
      { title: "Obby but you're a cube", desc: "Parkour as a bouncing Part with a camera that tries to keep up." },
      { title: "Clicker Simulator", desc: "Click, rebirth, prestige. A shop that actually spends currency." },
      { title: "Grow a Garden", desc: "Plant, water, sell — and other players can steal." },
      { title: "Build to Survive", desc: "Waves come. Your base is scrap parts you just placed." },
      { title: "Murder Mystery", desc: "One murderer, one sheriff, the rest innocents. Round timer." },
      { title: "Escape the Facility", desc: "Keycards, puzzles, a door that is closing." },
      { title: "Rising Water", desc: "The flood climbs. Race the vertical obby." },
      { title: "Red Light, Green Light", desc: "Move on green. Freeze on red or you're out." },
      { title: "Backrooms", desc: "Noclip into yellow halls. Find the exit before the entity does." },
      { title: "Hot Potato Bomb", desc: "Pass it or explode. Last holding it loses." },
      { title: "Hide and Seek", desc: "Hiders vs a seeking titan with a flashlight." },
      { title: "Only one color", desc: "Touch the wrong hue and you die. The safe color rotates." },
      { title: "Gravity Flip", desc: "Ceilings become floors on a timer." },
      { title: "Invisible Maze", desc: "Walls you can only hear. A bell marks collisions." },
      { title: "Day 1 Zombie", desc: "Sunrise is safety. Night is not." },
      { title: "Become a Titan", desc: "Eat to grow. Buildings are snacks." },
      { title: "Random event every 30s", desc: "Storm, meteor, candy rain, or a boss. HUD announces it." },
      { title: "Tycoon from a cardboard box", desc: "Droppers, upgraders, a sad start that actually pays." },
      { title: "Doors", desc: "Hotel rooms, entities, don't look back." },
      { title: "Pet hatching", desc: "Eggs, luck, a tiny arena where pets fight." },
      { title: "Fishing Simulator", desc: "Cast, rarity, sell, boat upgrade." },
      { title: "Prison Escape", desc: "Jobs by day, tunnel by night." },
      { title: "Superhero Academy", desc: "Pick a power. Training course. Ranked 1v1." },
      { title: "Lights Out", desc: "The power dies. Flashlight vs something in the dark." },
      { title: "Kart race", desc: "Three laps, item pads, a cheap figure-eight." },
      { title: "Capture the Flag", desc: "Two bases, one flag each, a scoreboard." },
      { title: "Wave Defense", desc: "Hold the point for 10 waves. A shop between waves." },
      { title: "Color switch tiles", desc: "Stand on the shouted color. Wrong tile = out." },
      { title: "Memory tiles", desc: "Simon pattern on the floor. One miss and you're out." },
      { title: "Shop but everything is cursed", desc: "Every purchase has a downside the UI must show." },
      { title: "Time stop", desc: "Q freezes the world for 2 seconds. Cooldown HUD." },
      { title: "One piece of furniture is alive", desc: "It wants out of the house. You decide if it leaves." },
      { title: "Desert island", desc: "Wood, hunger, a raft, a storm on a timer." },
      { title: "Winter survival", desc: "Temperature bar. Fire or freeze." },
      { title: "Bank heist", desc: "Drill, lasers, a getaway pad." },
      { title: "Ninja training", desc: "Wall jump, shuriken, a sensei that yells scores." },
      { title: "Pirate ship", desc: "Cannons, boarding, a treasure map GUI." },
      { title: "Western duel", desc: "High noon. Draw on the bell. First accurate shot wins." },
      { title: "Elevator of doom", desc: "Each floor is a mini-game. Don't pick the wrong button." },
      { title: "Last in the circle", desc: "The ring shrinks. Knock others out." },
      { title: "Parkour gun", desc: "Shoot pads that you then run. Miss and you fall." },
      { title: "Talking backpack", desc: "Inventory is a character with opinions in a speech bubble." },
      { title: "+1 Jump", desc: "Every orb you grab adds JumpPower. The ceiling is optional." },
      { title: "Natural Disaster", desc: "A random disaster every round. A safe zone that lies." },
      { title: "Tag", desc: "You're it. Tag transfers. A crown on the runner." },
    ];
    function rngPromptFor(topic) {
      return (
        "Build this Roblox experience in Studio now: \"" + topic.title + "\". " + topic.desc + "\n\n"
        + "Ship a playable vertical slice, not a mock. Production code only — named functions, WaitForChild with timeouts, no TODO stubs, no leftover prints, no default grey Frame standing in for UI.\n\n"
        + "Do this in order:\n"
        + "1) Write a short PLAN first: player loop, win/lose, Server vs Local scripts, remotes, GUI tree.\n"
        + "2) Implement with commands (ui_build / scripts / parts). One command per reply.\n"
        + "3) Verify with script_read or ui_list_tree before declaring done.\n"
      );
    }
    function rngTopicCard() {
      const topic = RNG_TOPICS[Math.floor(Math.random() * RNG_TOPICS.length)] || RNG_TOPICS[0];
      return {
        engine: "rs",
        icon: "\u2684",
        cat: "RNG",
        title: topic.title,
        desc: topic.desc,
        prompt: rngPromptFor(topic),
      };
    }
    function runRngTopic() {
      const card = rngTopicCard();
      try { toast("RNG — " + card.title); } catch {}
      try { runLibraryCard(card, true); } catch (e) { try { diag("cards.rngFail", { err: String(e).slice(0, 120) }); } catch {} }
    }
    const CARD_LIBRARY = [
      // ── RobloxScript (RS) ──
      { engine: "rs", icon: "\u2764", cat: "UI", title: "Health / Hunger Bar", desc: "ScreenGui bar tracking Humanoid stats",
        prompt: "Add a polished health bar HUD to StarterGui: a ScreenGui with a rounded frame that smoothly interpolates with Humanoid.Health, plus a hunger bar that drains 1% every 5 seconds and damages the player at zero. Include a local script and test values." },
      { engine: "rs", icon: "\u2600", cat: "System", title: "Day/Night Cycle", desc: "Smooth Lighting clock with phases",
        prompt: "Build a day/night cycle: a ServerScriptService script that rotates Lighting.ClockTime over a configurable 10-minute day, shifts ambient/brightness/fog color between dawn/day/dusk/night phases, and broadcasts the phase name so UI can show a clock." },
      { engine: "rs", icon: "\u26F9", cat: "Gameplay", title: "Sprint + Double Jump", desc: "Stamina sprint and mid-air jump",
        prompt: "Implement sprinting (hold LeftShift, WalkSpeed ramps 16\u219226 with a stamina bar that drains/refills) and double-jumping via UserInputService/JumpRequest, both client-side with clean state resets on respawn." },
      { engine: "rs", icon: "\u{1F3EA}", cat: "System", title: "Shop + Currency", desc: "leaderstats coins, buyable items",
        prompt: "Create a shop system: leaderstats Coins earned over time, a ProximityPrompt shop stand that opens a ScreenGui shop frame listing 3 items with prices, server-side purchase validation via RemoteEvent, and equipped-item effects." },
      { engine: "rs", icon: "\u{1F4BE}", cat: "Data", title: "DataStore Save/Load", desc: "Profile-style autosave + loadout",
        prompt: "Add robust DataStore saving: load player data (Coins, Level, ownedItems) on join with retry + session-lock pattern, autosave every 120s and on leave via BindToClose, and a safe Increment API other scripts can call." },
      { engine: "rs", icon: "\u{1F9DF}", cat: "AI", title: "Chase NPC", desc: "Zombie pathfinds and attacks",
        prompt: "Spawn a zombie NPC that uses PathfindingService to chase the nearest player within 60 studs, deals damage on touch with a cooldown, plays walk/attack animations, respawns 10s after death, and never targets players in the lobby zone." },
      { engine: "rs", icon: "\u2728", cat: "FX", title: "Explosion FX Pack", desc: "Beam, trail, explosion presets",
        prompt: "Build an FX kit in ReplicatedStorage: one explosion effect (particles + light flash + camera shake RemoteEvent), one energy beam, and one sword trail \u2014 each as a single function other scripts can call with a position/handle argument." },
      { engine: "rs", icon: "\u{1F6A9}", cat: "Gameplay", title: "Checkpoint System", desc: "Stage saves + spawn pad visuals",
        prompt: "Make a checkpoint system: numbered checkpoint pads that glow when reached, save each player's stage (session + DataStore), respawn them at their latest checkpoint, and a leaderstats Stage counter with anti-cheat validation." },
      { engine: "rs", icon: "\u{1F392}", cat: "UI", title: "Hotbar Inventory", desc: "Slot-based equip/unequip hotbar",
        prompt: "Create a 6-slot hotbar inventory: number-key selection, item icons with counts, equip/unequip tool handling synced with Backpack, and a server-validated pickup that fills the first free slot." },
      { engine: "rs", icon: "\u{1F50E}", cat: "FX", title: "Flashlight Toggle", desc: "Spotlight attached to character",
        prompt: "Add a toggleable flashlight (F key): a Spotlight attached to the character's head following the camera direction, battery that drains while on with a small UI meter, and sound effects for on/off." },
      { engine: "rs", icon: "\u{1F3B5}", cat: "FX", title: "Music Zones", desc: "Region-based ambient tracks",
        prompt: "Set up ambient music zones: invisible region parts each with their own track, clientside detection of the zone the local player stands in with smooth volume crossfade between tracks, and admin-configurable playlist via attributes." },
      { engine: "rs", icon: "\u{1F4AC}", cat: "UI", title: "Chat Bubbles", desc: "Proximity 3D speech bubbles",
        prompt: "Enable proximity chat bubbles: TextChatService BubbleChatConfiguration styling (font, colors, duration), plus a custom billboard bubble for NPC dialogue triggered by ProximityPrompt with typewriter text." },
      // ── Animation (AN) cards: drive the animation_* suite end-to-end ──
      { engine: "an", icon: "\u{1F9CD}", cat: "Idle", title: "Idle Breathing", desc: "Subtle 4s breathing loop",
        prompt: "Animate a subtle idle breathing loop: chest rise with a slight shoulder lift and small head follow-through, 4 seconds, looping, gentle easing. Run animation_test first, then create/open, pose the keyframes, preview, and QA with animation_simulate before finishing." },
      { engine: "an", icon: "\u{1F6B6}", cat: "Locomotion", title: "Walk Cycle", desc: "Contact-down-pass-up walk",
        prompt: "Build a proper walk cycle: contact, down, passing, and up poses for the pinned rig with natural arm counter-swing, 1 second loop. Run animation_test first, lay keyframes with animation_set_pose, verify foot planting with animation_simulate {all:true}, then preview for me." },
      { engine: "an", icon: "\u{1F3C3}", cat: "Locomotion", title: "Run Cycle", desc: "Lean-forward sprint loop",
        prompt: "Animate a run cycle: forward torso lean, higher knee lift than a walk, bent elbows pumping, 0.7 second loop. Calibrate with animation_test first, author the keyframes, run the numeric QA sweep, fix flagged metrics, then preview." },
      { engine: "an", icon: "\u{1F938}", cat: "Action", title: "Jump", desc: "Anticipate, launch, land",
        prompt: "Create a jump animation: crouch anticipation, explosive launch extension, tucked air pose, and a landing that absorbs into a slight crouch before recovering. About 1.2 seconds total. Test the rig sign convention first, then keyframe, simulate, and preview." },
      { engine: "an", icon: "\u2694\uFE0F", cat: "Combat", title: "Sword Combo", desc: "Two-hit slash with weight",
        prompt: "Author a two-hit sword slash combo: wind-up anticipation for each swing, fast strike with follow-through, and weight-shift between hits. Right hand grips (approximate a held sword pose). Run animation_test first; exaggerate silhouettes so the hits read clearly; QA and preview when done." },
      { engine: "an", icon: "\u{1F44B}", cat: "Emote", title: "Wave Hello", desc: "Friendly 3x wave",
        prompt: "Make a wave emote: right arm raises with a slight head tilt, waves three times at the wrist, then relaxes back to rest. 2 seconds. Calibrate the rig, pose it, set smooth easing, and preview for me to confirm." },

      // ── Voice / how the AI works ──
      { engine: "rs", icon: "\u{1F910}", cat: "Voice", title: "Silent Builder", desc: "Tools only — almost no chatter",
        prompt: "Work in Silent Builder mode for this task. Do not narrate. Do not recap. Call tools immediately. One short line only when you need a decision from me or when the thing is actually done." },
      { engine: "rs", icon: "\u{1F3AD}", cat: "Voice", title: "Cinematic Director", desc: "Look first: camera, light, silhouette",
        prompt: "Work as a cinematic director. Before any prop or script: set lighting_set_preset, camera_set_style, and a readable silhouette. Prefer mood and composition. Gameplay scripts come last, and only if I asked." },
      { engine: "rs", icon: "\u{1F6E0}", cat: "Voice", title: "Ruthless QA", desc: "Break it, then the smallest fix",
        prompt: "Work as ruthless QA. Reproduce first (run / playtest / read Output). Name the real cause in one line. Apply the smallest correct diff. Re-run the failing check and report before/after. No drive-by refactors." },
      { engine: "rs", icon: "\u{1F9EA}", cat: "Voice", title: "Teacher", desc: "Explain the why as you build",
        prompt: "Work as a teacher. Before each tool batch, say in one sentence WHAT you will do and WHY. After it lands, say what to look at in Studio. Keep jargon light. Never skip the build — teach while shipping." },
      { engine: "rs", icon: "\u26A1", cat: "Voice", title: "Speedrun", desc: "Shortest path that actually works",
        prompt: "Speedrun this. Prefer high-level skills over hand-rolled Luau. No extra research loops. First working version in as few commands as possible, then stop and tell me what to click." },
      { engine: "rs", icon: "\u{1F3B2}", cat: "Voice", title: "Chaos Sandbox", desc: "Weird, loud, still playable",
        prompt: "Chaos sandbox: make it weird and loud (particles, sounds, ridiculous numbers) but it MUST stay playable — no unanchored disaster, no infinite loops, no lag bombs. Fun first, still ships." },
      { engine: "rs", icon: "\u{1F4BB}", cat: "Voice", title: "Production", desc: "Modules, WaitForChild, no magic numbers",
        prompt: "Production mode: small modules, named constants, pcall around fallible calls, WaitForChild with timeout, no magic numbers, no leftover debug prints. Verify by running it before you claim it works." },

      // ── More ideas ──
      { engine: "rs", icon: "\u{1F3D7}", cat: "Gameplay", title: "Tycoon Dropper", desc: "Pad, dropper, collector, rebirth",
        prompt: "Build a tiny tycoon loop: a claimed plot, a dropper that spawns parts on a belt into a collector, +cash on touch, a buy pad that upgrades drop rate, and a rebirth that multiplies income. Use leaderstats Coins. Keep it 1 plot, readable, and test the cash path." },
      { engine: "rs", icon: "\u{1F9E7}", cat: "Gameplay", title: "Obby Kit", desc: "Checkpoints, kill bricks, moving platforms",
        prompt: "Build an obby kit: neon kill bricks, a moving platform tween, a spinning hazard, checkpoints that set RespawnLocation, and a finish pad that awards a badge-style win in leaderstats. 8 stages, clean materials, and a lobby spawn." },
      { engine: "rs", icon: "\u{1F3AF}", cat: "Gameplay", title: "Battle Zone", desc: "Shrinking safe circle + storm",
        prompt: "Make a battle-royale zone: a shrinking cylinder Part as the safe circle, players outside take tick damage, a billboard shows time-to-shrink, and the circle color-shifts as it gets small. Server-authoritative. No guns — just the zone." },
      { engine: "rs", icon: "\u{1F43E}", cat: "Gameplay", title: "Pet Follow", desc: "Companion that hops after you",
        prompt: "Spawn a cute pet that follows the local player with a hop (not a slide), idles when close, and sits when the player stands still 2s. Client visual, server spawn. No combat. Name it and give it a tiny overhead billboard." },
      { engine: "rs", icon: "\u{1F3CD}", cat: "Gameplay", title: "Grapple Hook", desc: "Click-to-swing with a beam",
        prompt: "First-person grapple: click a surface, fire a Beam + attachment, pull the character with a brief BodyVelocity/LinearVelocity, then release. Cooldown 1.2s, max 80 studs, and a whoosh sound. Don't let it fling you under the map." },
      { engine: "rs", icon: "\u{1F6A6}", cat: "Gameplay", title: "Traffic Cars", desc: "Simple chassis + throttle",
        prompt: "A driveable car: a VehicleSeat chassis, wheel cylinders, basic throttle/steer, a horn ProximityPrompt, and a camera that sits behind the seat. Keep physics tame (no rocket cars). One spawn in Workspace." },
      { engine: "rs", icon: "\u{1F3A3}", cat: "Gameplay", title: "Fishing Mini", desc: "Cast, wait, bite, reel",
        prompt: "Fishing minigame: ProximityPrompt on a dock, a bobber Part that floats, random bite after 2–6s, a timing UI bar to reel, and a random fish name + coins into leaderstats. Missed reel = splash and retry." },
      { engine: "rs", icon: "\u{1F3E0}", cat: "Gameplay", title: "Tower Defense", desc: "Path, waves, one tower type",
        prompt: "Mini tower defense: a visible path of waypoints, dummy enemies that walk it, one tower type that shoots the nearest, a buy pad, and a base HP. Wave 1 = 5 enemies. Game over when base HP hits 0. Keep it readable from above." },
      { engine: "rs", icon: "\u{1F409}", cat: "Gameplay", title: "Boss Arena", desc: "Telegraph slam + weak point",
        prompt: "A boss arena: a big dummy, a slam attack with a telegraph circle on the floor, a glowing weak-point Attachment, 3-phase HP bar BillboardGui, and a victory chest. Player sword optional — if none, give a simple click tool." },
      { engine: "rs", icon: "\u{1F5FA}", cat: "World", title: "Proc Dungeon", desc: "Rooms from a kit, one seed",
        prompt: "Procedural dungeon from a kit of 4 room models (start, hall, chamber, loot). Place 7 rooms with door attachments aligned, a seed so it's repeatable, spawn at start, loot chest at the end. No overlapping rooms." },
      { engine: "rs", icon: "\u{1F4CA}", cat: "UI", title: "Skill Tree", desc: "Node grid, unlock, persist",
        prompt: "Skill tree UI: a ScreenGui of connected nodes (3 rows), click to unlock if you have SkillPoints leaderstats, grey out locked, gold the owned, and persist with datastore_setup. Start with 1 point. Hover shows a one-line desc." },
      { engine: "rs", icon: "\u{1F3EA}", cat: "UI", title: "Trading Booth", desc: "Pad, listing, take offer",
        prompt: "A trading plaza booth: a pad you stand on to list a tool from your backpack for Coins, a world SurfaceGui showing the listing, and a ProximityPrompt for another player to buy. Server checks currency. One booth is enough." },
      { engine: "rs", icon: "\u{1F576}", cat: "FX", title: "Horror Flash", desc: "Flicker light, drain battery",
        prompt: "Horror flashlight: a Tool with a SpotLight, flicker when battery < 20%, battery drains while on, recharge at a wall charger pad. Dark the Lighting (clock 0, ambient low) so it matters. No jumpscares unless I ask." },
      { engine: "rs", icon: "\u{1F3B5}", cat: "FX", title: "Hitstop Juice", desc: "Punch impact freeze + punch sound",
        prompt: "Combat juice: on a melee hit, 3-frame hitstop (slow clock), a brief FOV punch, a spark emitter, and a thud. Wire it to a simple punch Tool. Keep it 1 hit = 1 juice, no spam stacking." },
      { engine: "rs", icon: "\u{1F9F1}", cat: "World", title: "Build Mode", desc: "Place, rotate, delete furniture",
        prompt: "Plot build mode: 6 placeable furniture models, a hotbar to pick, click-to-place on a plot baseplate, R to rotate 90, X to delete hovered, and ghost preview. Stay on the plot. Save placements in a Folder under the plot." },
      { engine: "rs", icon: "\u{1F680}", cat: "Gameplay", title: "Rocket Ride", desc: "Hold to fly, fuel, land",
        prompt: "Rocket tool: hold to thrust up/forward with fuel that drains, a ScreenGui fuel bar, and fall damage if you land too fast. Refuel pad. Cap speed so you can't leave the map in 2 seconds." },
      { engine: "rs", icon: "\u{1F9F1}", cat: "Blender", title: "Low-poly Sword", desc: "Model in Blender, FBX into Studio",
        prompt: "If Connect Blender is off, tell me to click it (Blender: N → MCP for Blender → Start MCP Server) and stop. If it is on: build a game-ready low-poly sword (blade + guard + grip, ~800 tris, origin at the grip, +Y up). Apply transforms. Export FBX (Forward -Z, Up Y) then asset_bridge_import {source:\"blender\", asset:<fbx path>, target_engine:\"roblox\"} and parent it to a Tool in StarterPack. Screenshot the viewport before export so I can see it." },
      { engine: "rs", icon: "\u{1F333}", cat: "Blender", title: "Stylized Tree", desc: "Trunk + canopy, then MeshPart",
        prompt: "If Connect Blender is off, tell me to click it and stop. If it is on: make a stylized tree (cylinder trunk, icosphere canopy, 2 materials). Keep it under 1500 tris, origin at roots. Export FBX and asset_bridge_import into Workspace as a prop. Scale so it's ~12 studs tall." },
      { engine: "rs", icon: "\u{1F9E9}", cat: "Blender", title: "Sci-fi Crate", desc: "Beveled crate with trim",
        prompt: "If Connect Blender is off, tell me to click it and stop. If it is on: a sci-fi crate — beveled cube, inset panel, corner bolts (not 10k tris). Bake a simple color grid if you can. Export FBX, asset_bridge_import to Workspace.Crate, and sit it on a baseplate." },
      { engine: "rs", icon: "\u{1F3A8}", cat: "Blender", title: "Hero Prop", desc: "Describe it — Blender then Studio",
        prompt: "If Connect Blender is off, tell me to click it and stop. If it is on: pick a readable hero prop (lantern / radio / potion flask), model it in Blender with clean origin and real-world-ish scale in studs, screenshot, export FBX, asset_bridge_import into Studio, and place it on a pedestal with a PointLight." }
    ];

    function libFiltered() {
      if (currentEngine === "local") return []; // AgentScript has no mechanic cards
      const q = cardsQuery.trim().toLowerCase();
      return CARD_LIBRARY.filter((c) => (c.engine === "rs" || c.engine === "an")
        && (!q || (c.title + " " + c.desc + " " + c.cat + " " + c.prompt).toLowerCase().includes(q)));
    }
    function gridHtml() {
      if (!visibleLibCache.length) return currentEngine === "local"
        ? '<div class="rs-cards-empty"><div class="rs-cards-empty-glyph">\u2726</div>AgentScript works on your project folder directly \u2014 no mechanic cards here.<br><span>Flip to RS for the card library.</span></div>'
        : '<div class="rs-cards-empty">No cards match.</div>';
      return '<div class="rs-cards-grid">' + visibleLibCache.map((c, i) =>
        '<div class="rs-lib-card" draggable="true" data-prompt-index="' + i + '" data-cat="' + escRs(c.cat) + '" title="' + escRs(c.prompt) + '">'
        + '<div class="rs-card-icon">' + c.icon + '</div>'
        + '<div class="rs-lib-body"><div class="rs-lib-title">' + escRs(c.title) + '</div>'
        + '<div class="rs-lib-desc">' + escRs(c.desc) + '</div>'
        + '<span class="rs-lib-cat">' + escRs(c.cat) + '</span></div>'
        + '<div class="rs-lib-ops">'
        + '<button type="button" class="rs-lib-copy" data-copy-index="' + i + '" title="Copy the prompt (click the card to SEND it)">\u29C9</button>'
        + '<span class="rs-lib-run" title="Send">+</span>'
        + '</div></div>').join("")
      + '</div>';
    }
    function libraryHtml() {
      const total = CARD_LIBRARY.filter((c) => c.engine === "rs" || c.engine === "an").length;
      visibleLibCache = libFiltered();
      return '<div class="rs-cards-searchrow">'
        + '<input id="rs-cards-search" type="text" placeholder="Search the library\u2026" value="' + escRs(cardsQuery) + '" spellcheck="false">'
        + '<button type="button" id="rs-cards-rng" title="Random game topic — send it to chat">RNG</button>'
        + '<span class="rs-cards-count-info">' + visibleLibCache.length + '/' + total + '</span>'
        + '</div>'
        + '<div class="rs-cards-hint">Click send \u00b7 Shift+click paste \u00b7 Drag into chat \u00b7 RNG for a random game</div>'
        + '<div id="rs-cards-grid-wrap">' + gridHtml() + '</div>';
    }

    function activityHtml() {
      if (!recentCards.length) {
        return '<div class="rs-cards-empty"><div class="rs-cards-empty-glyph">\u2726</div>No results yet<br><span>Every tool result lands here as a card.</span></div>';
      }
      const shown = recentCards.slice(0, 12);
      const doneN = shown.filter((c) => c.status === "ok").length;
      const errN = shown.filter((c) => c.status === "err").length;
      const head =
        '<div class="rs-cards-head"><span class="rs-cards-title">Activity</span>'
        + (doneN ? '<span class="rs-cards-count">' + doneN + '<i>ok</i></span>' : "")
        + (errN ? '<span class="rs-cards-count err">' + errN + '<i>err</i></span>' : "")
        + '<button id="rs-cards-clear" type="button">Clear</button></div>';
      return head + shown.map((c, i) => {
        const icon = { edit: "\u270E", read: "\u2139", screen: "\u25A3", generate: "\u2726", roblox: "\u25A6", tool: "\u2699" }[c.category] || "\u2699";
        const cls = c.status === "ok" ? "done" : c.status === "err" ? "err" : "run";
        const ago = Math.max(0, Math.round((Date.now() - c.at) / 1000));
        const agoStr = ago < 60 ? ago + "s" : ago < 3600 ? Math.round(ago / 60) + "m" : Math.round(ago / 3600) + "h";
        return '<div class="rs-card rs-card-' + cls + '" data-idx="' + i + '" style="animation-delay:' + Math.min(i * 45, 400) + 'ms">'
          + '<div class="rs-card-icon">' + icon + '</div>'
          + '<div class="rs-card-body"><div class="rs-card-title">' + escRs(c.tool) + '</div>'
          + '<div class="rs-card-detail">' + escRs(c.detail) + '</div></div>'
          + '<div class="rs-card-meta"><span class="rs-card-status"><span class="rs-card-dot"></span>'
          + (c.status === "ok" ? "Done" : c.status === "err" ? "Failed" : "Running")
          + '</span><span class="rs-card-time">' + agoStr + ' ago</span></div>'
          + '</div>';
      }).join("");
    }

    // ── AgentScript Session Summary ──
    // In AS mode there are no mechanic cards: the panel becomes a live summary
    // of WHAT THE AI DID this session - edit/run/inspect counters plus a feed
    // of every action with its outcome. Data source is the same recentCards
    // stream trackCard() already records from the agent loop.
    function summaryActions() {
      return recentCards.filter((c) => c.tool !== "list_commands" && c.tool !== "list_tools" && c.tool !== "list_mcp_servers");
    }
    function summaryHtml() {
      const acts = summaryActions();
      const full = !!(typeof window.__rsFullAccess === "function" && window.__rsFullAccess());
      const head = '<div class="rs-cards-head"><span class="rs-cards-title">Session</span>'
        + '<span class="rs-sum-live">' + (full ? "\u25CF FULL" : "\u25CB sandboxed") + '</span>'
        + '<button id="rs-cards-clear" type="button">Clear</button></div>';
      // ── Danger zone FIRST — it must be visible immediately, every time,
      // empty session or not. Single FULL ACCESS toggle; agent state is truth.
      const danger =
        '<div class="rs-danger-zone">'
        + '<div class="rs-dz-head">\u26A0 Danger zone</div>'
        + '<div class="rs-dz-row">'
        +   '<div class="rs-dz-text"><b>FULL ACCESS</b><span>Let the AI read and write anywhere on this PC and control processes \u2014 not just the workspace.</span></div>'
        +   '<button id="rs-full-toggle" class="' + (full ? "on" : "") + '" title="' + (full ? "Click to return to the workspace sandbox" : "Lift the workspace sandbox") + '">' + (full ? "ON" : "OFF") + '</button>'
        + '</div>'
        + '</div>';
      if (!acts.length) {
        return head + danger
          + '<div class="rs-cards-empty"><div class="rs-cards-empty-glyph">\u25A6</div>No actions yet<br><span>File edits, terminal runs and searches land here as they happen.</span></div>';
      }
      const is = (c, re) => re.test(c.tool);
      const edits = acts.filter((c) => is(c, /^(write_file|edit_file|create_folder|delete_path|move_path)$/)).length;
      const runs = acts.filter((c) => is(c, /^run_command$/)).length;
      const reads = acts.filter((c) => is(c, /^(read_file|grep_files|search_files|tree|list_directory|file_info|env_info|process_list|process_kill|open_path|download_file|workspace_info)$/)).length;
      const errs = acts.filter((c) => c.status === "err").length;
      const chip = (n, label, cls) => `<span class="rs-sum-chip${cls ? " " + cls : ""}${n ? "" : " zero"}">${n} <i>${label}</i></span>`;
      const stats =
        '<div class="rs-sum-stats">'
        + chip(edits, "edits", "ed")
        + chip(runs, "runs", "run")
        + chip(reads, "inspects", "rd")
        + (errs ? chip(errs, "failed", "er") : "")
        + '</div>';
      const rows = acts.slice(0, 30).map((c, i) => {
        const icon = { edit: "\u270E", read: "\u2139", screen: "\u25A3", generate: "\u2726", roblox: "\u25A6", tool: "\u2699" }[c.category] || "\u2699";
        const cls = c.status === "ok" ? "done" : c.status === "err" ? "err" : "run";
        const ago = Math.max(0, Math.round((Date.now() - c.at) / 1000));
        const agoStr = ago < 60 ? ago + "s" : ago < 3600 ? Math.round(ago / 60) + "m" : Math.round(ago / 3600) + "h";
        return '<div class="rs-card rs-card-' + cls + '" style="animation-delay:' + Math.min(i * 35, 320) + 'ms">'
          + '<div class="rs-card-icon">' + icon + '</div>'
          + '<div class="rs-card-body"><div class="rs-card-title">' + escRs(c.tool) + '</div>'
          + '<div class="rs-card-detail">' + escRs(c.detail || "") + '</div></div>'
          + '<div class="rs-card-meta"><span class="rs-card-status"><span class="rs-card-dot"></span>'
          + (c.status === "ok" ? "Done" : c.status === "err" ? "Failed" : "Running")
          + '</span><span class="rs-card-time">' + agoStr + ' ago</span></div>'
          + '</div>';
      }).join("");
      return head + danger + stats + '<div class="rs-cards-grid rs-sum-feed">' + rows + '</div>';
    }

let cardsUiStyle = "modern";
    let cardsUiPrompt = "";
    let cardsUiRefs = [];
    let sendUiBusy = false;
    const UI_STYLES = {
      stud: {
        title: "Stud", blurb: "Classic brick",
        ref: "STYLE BIBLE — STUD (classic Roblox 2008–2012). Copy this, do not modernize. Palette: brick-red 170,0,0 / bright yellow 255,255,0 / legacy blue 0,162,255 / white 255,255,255 / black 0,0,0 / grey 163,162,165. UICorner Radius=0 everywhere. BorderSizePixel=2, BorderColor3=black. No UIGradient, no UIStroke, no blur, no drop shadow. Font=Enum.Font.Legacy or SourceSansBold. TextStrokeTransparency=0, TextStrokeColor3=black, TextScaled=true. Buttons are bright and chunky. Background Color3 31,31,31 or 255,255,255. Looks like old Roblox menus and the catalog of 2012."
      },
      modern: {
        title: "Modern", blurb: "Clean Studio",
        ref: "STYLE BIBLE — MODERN. Palette: bg 18,18,22 / panel 28,28,34 / text 235,235,240 / muted 140,140,150 / accent 88,166,255. UICorner 8px on panels, 6px on buttons. UIStroke 1px white at Transparency 0.88. Font=GothamMedium / Gotham. Padding 12. UIListLayout with 8px padding. No comic outlines, no gold, no neon. Quiet, Apple-meets-Studio. BackgroundTransparency 0.08 on panels."
      },
      glue: {
        title: "Glue", blurb: "Jelly gloss",
        ref: "STYLE BIBLE — GLUE (glossy jelly). Palette: bubblegum 255,105,180 / mint 80,255,190 / lemon 255,230,80 / white highlight. UICorner 18–24 (very round). UIStroke 3px darker same hue. UIGradient top-to-bottom: white 0.35 transparency into the fill. Soft UIDropShadow. Font=FredokaOne or GothamBlack. Big candy buttons, squishy padding 16. No sharp corners, no thin hairlines."
      },
      ancient: {
        title: "Ancient", blurb: "Stone & gold",
        ref: "STYLE BIBLE — ANCIENT. Palette: parchment 232,210,170 / ink 62,39,20 / gold 198,149,58 / moss 74,92,58 / stone 120,108,90. UICorner 2. UIStroke 2px gold. Nested inner frames (carved). Font=Fantasy or DenkOne. No neon, no glass blur. Text Color3 ink. Buttons look like engraved plaques. Optional slight brown UIGradient."
      },
      futuristic: {
        title: "Futuristic", blurb: "HUD cyan",
        ref: "STYLE BIBLE — FUTURISTIC. Palette: void 8,12,18 / cyan 0,255,230 / magenta 255,40,180 / dim 20,28,40. UICorner 2. Hairline UIStroke 1px cyan Transparency 0.2. Font=RobotoMono or Code. Angular layout, HUD anchors (top-left / top-right). Thin scanline frames (height 1, cyan 0.4). No rounded candy, no parchment. Text mostly cyan. BackgroundTransparency 0.25."
      },
      arcade: {
        title: "Arcade", blurb: "Neon CRT",
        ref: "STYLE BIBLE — ARCADE. Palette: black 0,0,0 / hot pink 255,0,170 / electric blue 0,180,255 / coin-gold 255,200,0. UICorner 0. UIStroke 2px neon. Font=Arcade or GothamBlack. TextStroke pink. Looks like a 1980s cabinet overlay. High contrast, blinking coin text optional. No earth tones."
      },
      royal: {
        title: "Royal", blurb: "Velvet gold",
        ref: "STYLE BIBLE — ROYAL. Palette: velvet 72,12,36 / gold 212,175,55 / ivory 245,236,214 / deep 28,8,16. UICorner 4. Double gold UIStroke (outer 2px, inner 1px). Font=GothamBold. Ornate header bar. Buttons are gold plaques on velvet. No cyan, no brick studs."
      },
      horror: {
        title: "Horror", blurb: "Grime & blood",
        ref: "STYLE BIBLE — HORROR. Palette: black 10,8,8 / blood 138,12,12 / bone 214,204,186 / rust 90,40,28. UICorner 0–2. Distressed UIStroke 1px blood Transparency 0.4. Font=GothamBold. Uneven padding. Dirty BackgroundTransparency 0.15. No cute colors, no gold luxury, no cyan HUD."
      },
      minimal: {
        title: "Minimal", blurb: "Air & type",
        ref: "STYLE BIBLE — MINIMAL. Palette: white 250,250,250 / ink 20,20,20 / one accent 30,30,30. UICorner 4. Almost no strokes (UIStroke Transparency 0.92). Font=Gotham. Huge padding 20+. One accent color max. Lots of empty space. No gradients, no icons clutter, no neon."
      },
      cartoon: {
        title: "Cartoon", blurb: "Cel outline",
        ref: "STYLE BIBLE — CARTOON. Palette: sky 120,200,255 / orange 255,140,60 / cream 255,244,214 / line-black 20,20,20. UICorner 12. UIStroke 3–4px black (cel outline). Font=FredokaOne or GothamBlack. Flat fills, no realistic gradients. Bubbly shapes. Feels like a sticker book."
      }
    };
        function setDiagDebug(level) {
      if (!["off", "basic", "detailed", "trace"].includes(level)) return;
      diagDebug = level;
      try { window.__rsDiagDebug = () => diagDebug; } catch {}
      try { chrome.storage.local.set({ rsDiagDebug: level }); } catch {}
      buildMenu();
      toast("Diagnostic Debugging: " + level.toUpperCase());
    }

    function uiRefFromDataUrl(url, name) {
      const m = String(url || "").match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return null;
      return { mimeType: m[1], data: m[2], preview: url, name: name || "ref" };
    }
    function shrinkUiDataUrl(url) {
      return new Promise((resolve) => {
        try {
          const img = new Image();
          img.onload = () => {
            try {
              const max = 1280;
              let w = img.width, h = img.height;
              if (w > max || h > max) {
                const s = max / Math.max(w, h);
                w = Math.round(w * s); h = Math.round(h * s);
              }
              const c = document.createElement("canvas");
              c.width = w; c.height = h;
              c.getContext("2d").drawImage(img, 0, 0, w, h);
              resolve(c.toDataURL("image/jpeg", 0.86));
            } catch (e) { resolve(url); }
          };
          img.onerror = () => resolve(url);
          img.src = url;
        } catch (e) { resolve(url); }
      });
    }
    function readUiFile(file) {
      return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => resolve("");
        fr.readAsDataURL(file);
      });
    }
    function uiRefsThumbHtml() {
      return cardsUiRefs.map((r, i) => '<button type="button" class="rs-ui-thumb" data-ui-unref="' + i + '" title="Remove"><img alt="" src="' + r.preview + '"></button>').join("");
    }
    function uiRefsDropText() {
      const n = cardsUiRefs.length;
      return n ? (n + " image" + (n === 1 ? "" : "s") + " attached — add more or drop here") : "Drop, paste, or click to add screenshots";
    }
    function paintUiRefs() {
      if (!cardsPanel) return;
      try { cardsPanel._orUiGuard = Date.now() + 1600; } catch (e) {}
      const wrap = cardsPanel.querySelector(".rs-ui-refs");
      const lab = cardsPanel.querySelector(".rs-ui-drop-label");
      if (wrap) wrap.innerHTML = uiRefsThumbHtml();
      if (lab) lab.textContent = uiRefsDropText();
      try { window.dispatchEvent(new Event("resize")); } catch (e2) {}
    }
    function isUiRefFile(f) {
      if (!f) return false;
      const typ = String(f.type || "");
      if (/^image\//.test(typ)) return true;
      return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(f.name || ""));
    }
    async function addUiRefFiles(files) {
      const list = Array.from(files || []).filter(isUiRefFile);
      for (let i = 0; i < list.length; i++) {
        if (cardsUiRefs.length >= 4) break;
        const raw = await readUiFile(list[i]);
        if (!raw) continue;
        const small = await shrinkUiDataUrl(raw);
        const ref = uiRefFromDataUrl(small, list[i].name);
        if (ref) cardsUiRefs.push(ref);
      }
      paintUiRefs();
    }
    function uiCreatorHtml() {
      const st = UI_STYLES[cardsUiStyle] || UI_STYLES.modern;
      let tiles = "";
      Object.keys(UI_STYLES).forEach((id) => {
        const s = UI_STYLES[id];
        tiles += '<button type="button" class="rs-ui-style' + (cardsUiStyle === id ? " on" : "") + '" data-ui-style="' + id + '">'
          + '<span class="rs-ui-swatch" data-style="' + id + '"></span>'
          + '<span class="rs-ui-name">' + s.title + "</span>"
          + '<span class="rs-ui-sub">' + s.blurb + "</span></button>";
      });
      return (
        '<div class="rs-ui">'
        + '<div class="rs-cards-hint">Pick a style, drop screenshots of the GUI you want, then Create. The AI sees the photos and builds it in Studio.</div>'
        + '<div class="rs-ui-styles">' + tiles + "</div>"
        + '<div class="rs-ui-label">Reference images</div>'
        + '<button type="button" class="rs-ui-drop" data-ui-pick="1"><span class="rs-ui-drop-label">' + uiRefsDropText() + "</span></button>"
        + '<input id="rs-ui-file" type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.gif" multiple tabindex="-1">'
        + '<div class="rs-ui-refs">' + uiRefsThumbHtml() + "</div>"
        + '<div class="rs-ui-label">What to build</div>'
        + '<textarea id="rs-ui-prompt" rows="3" placeholder="e.g. 20-slot inventory, gold counter, close button" spellcheck="false">' + escRs(cardsUiPrompt) + "</textarea>"
        + '<button type="button" class="rs-ui-build" data-ui-build="1">Create ' + escRs(st.title) + " UI</button>"
        + '<div id="rs-ui-status" class="rs-motion-note">Create sends the style and your photos to chat automatically.</div>'
        + "</div>"
      );
    }
    function uiBuildPrompt(styleId, want) {
      const st = UI_STYLES[styleId] || UI_STYLES.modern;
      const thing = want || "a compact HUD: health bar, currency, and a pause button";
      const nImg = cardsUiRefs.length;
      const vision = nImg
        ? (
          "REFERENCE IMAGES: " + nImg + " screenshot(s) are attached to THIS message as real image files. You CAN see them. Study every pixel.\\n"
          + "Reproduce the photos in Studio: layout, size, color, corner radius, stroke, fonts, icons, portraits, patterns, textures, and the EXACT words on every label/button.\\n"
          + "CUSTOM IMAGES: every icon, portrait, pattern, and panel chrome MUST be an ImageLabel or ImageButton. Use rbxassetid:// IDs the user gave. If they gave none, use builtin aliases via ui_set_image image='panel'|'button'|'circle'|'icon'|'close' or rbxasset://textures/ui/... Never leave a grey Frame standing in for art.\\n\\n"
        )
        : (
          "No screenshot attached. Still ship a production GUI: ImageLabel/ImageButton for every icon and panel texture (builtin panel/button/circle/icon/close or rbxassetid), UIGradient for fills, TextLabel/TextButton for every string. Default Studio grey is a bug.\\n\\n"
        );
      return (
        "Build a production Roblox ScreenGui in Studio NOW. Daily-usable, not a mock. Follow the style bible EXACTLY.\\n\\n"
        + "UNDERSTAND THE REQUEST: WHAT TO BUILD is the spec. Infer implied HUD pieces (labels, icons, states, mobile scale) even if the user wrote one line. Reproduce every word and layout.\\n\\n"
        + vision
        + st.ref + "\\n\\n"
        + "WHAT TO BUILD: " + thing + "\\n\\n"
        + "PIPELINE (do this, in order):\\n"
        + "1) Prefer ui_build {screen:\"OR_" + st.title.replace(/\\s+/g, "") + "UI\", widgets:[{class_name,name,size,position,text,image,corner,stroke,background}]} so textures land in the same call.\\n"
        + "2) If you need Luau instead: execute_luau in Edit. ScreenGui in StarterGui, ResetOnSpawn=false, IgnoreGuiInset=true, ZIndexBehavior=Sibling. Instance ImageLabels for art, TextLabels for copy, UIListLayout/UIPadding/UICorner/UIStroke on every chrome piece. UDim2 scale.\\n"
        + "3) Then restyle: ui_set_image / ui_set_texture / ui_set_slice for every graphic; ui_set_text for every string; ui_set_property for anything else (Image, ImageColor3, ScaleType, Font, BackgroundColor3). ui_paint or ui_apply_theme for the whole tree.\\n"
        + "4) Builtin texture names: panel, button, circle, icon, close (passed as image=). Numeric ids become rbxassetid://.\\n"
        + "5) Do not declare done until the GUI is parented, visible, and every icon/background is an ImageLabel (not an empty Frame). Reply with one line: style, instance name, what it contains, which images were set."
      );
    }

    async function sendUiCreate() {
      if (sendUiBusy) return;
      const ta = cardsPanel && cardsPanel.querySelector("#rs-ui-prompt");
      if (ta) cardsUiPrompt = ta.value;
      const st = UI_STYLES[cardsUiStyle] || UI_STYLES.modern;
      const status = cardsPanel && cardsPanel.querySelector("#rs-ui-status");
      const btn = cardsPanel && cardsPanel.querySelector("[data-ui-build]");
      const text = uiBuildPrompt(cardsUiStyle, (cardsUiPrompt || "").trim());
      if (enforceCondo("ui-create", (cardsUiPrompt || "") + "\n" + text)) {
        if (status) status.textContent = "CONDO LOCK — that topic is blocked.";
        return;
      }
      const imgs = cardsUiRefs.map((r) => ({ mimeType: r.mimeType || "image/jpeg", data: r.data }));
      if (typeof P === "undefined" || !P.typeAndSend) {
        if (status) status.textContent = "Chat composer not ready.";
        toast("Couldn't send — click the chat box and try again");
        return;
      }
      sendUiBusy = true;
      if (btn) btn.disabled = true;
      if (status) status.textContent = imgs.length ? ("Sending " + st.title + " UI with " + imgs.length + " photo" + (imgs.length === 1 ? "" : "s") + "…") : ("Sending " + st.title + " UI…");
      let sent = false;
      try {
        if (P.ensureComposerReady) { try { await P.ensureComposerReady(); } catch (e0) {} }
        await P.typeAndSend(text, imgs.length ? imgs : undefined);
        sent = true;
      } catch (e) {
        try { diag("ui.sendFail", { err: String(e).slice(0, 160) }); } catch (e2) {}
        if (status) status.textContent = "Couldn't send — " + String((e && e.message) || e).slice(0, 80);
        toast("Couldn't send — click the chat box and try again");
      } finally {
        sendUiBusy = false;
        if (btn) btn.disabled = false;
      }
      if (sent) {
        if (status) status.textContent = st.title + " UI sent" + (imgs.length ? (" with " + imgs.length + " reference image" + (imgs.length === 1 ? "" : "s")) : "") + ".";
        toast("UI Creator \u2014 " + st.title + (imgs.length ? (" +" + imgs.length + " ref") : "") + " sent");
        try { cardsPanel.hidden = true; } catch (e3) {}
      }
    }

function renderCards(panel) {
      if (!panel) return;
      // AgentScript mode: the whole panel IS the session summary.
      if (activeEngine() === "local") {
        panel.innerHTML = summaryHtml();
        return;
      }
      if (cardsTab === "motion") cardsTab = "library";
      const actN = recentCards.length ? ' <b>' + recentCards.length + '</b>' : '';
      panel.innerHTML =
        '<div class="rs-cards-top">'
        + '<div class="rs-cards-brand"><span class="rs-cards-kicker">OR</span><span class="rs-cards-heading">Cards</span></div>'
        + '<div class="rs-cards-tabs">'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "library" ? " on" : "") + '" data-tab="library">Library</button>'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "activity" ? " on" : "") + '" data-tab="activity">Log' + actN + '</button>'
        + '<button type="button" class="rs-cards-tab' + (cardsTab === "uicreator" ? " on" : "") + '" data-tab="uicreator">UI Creator</button>'
        + '</div></div>'
        + '<div class="rs-cards-body">'
        + (cardsTab === "library" ? libraryHtml() : cardsTab === "uicreator" ? uiCreatorHtml() : activityHtml())
        + '</div>';
      try { panel.classList.toggle("rs-cards-ui", cardsTab === "uicreator"); } catch (e0) {}
      try { panel.scrollTop = 0; } catch (e1) {}
      const uiPrompt = panel.querySelector("#rs-ui-prompt");
      if (uiPrompt) {
        uiPrompt.addEventListener("input", () => { cardsUiPrompt = uiPrompt.value; });
      }
      const uiFile = panel.querySelector("#rs-ui-file");
      if (uiFile) {
        uiFile.addEventListener("click", (ev) => ev.stopPropagation());
        uiFile.addEventListener("change", () => {
          try { panel._orUiGuard = Date.now() + 1600; } catch (e) {}
          addUiRefFiles(uiFile.files);
          try { uiFile.value = ""; } catch (e2) {}
        });
      }
      const uiDrop = panel.querySelector(".rs-ui-drop");
      if (uiDrop) {
        uiDrop.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          try { panel._orUiGuard = Date.now() + 1600; } catch (e) {}
          if (uiFile) uiFile.click();
        });
        ["dragenter", "dragover"].forEach((evn) => uiDrop.addEventListener(evn, (ev) => { ev.preventDefault(); ev.stopPropagation(); uiDrop.classList.add("on"); }));
        uiDrop.addEventListener("dragleave", () => uiDrop.classList.remove("on"));
        uiDrop.addEventListener("drop", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          uiDrop.classList.remove("on");
          try { panel._orUiGuard = Date.now() + 1600; } catch (e) {}
          addUiRefFiles(ev.dataTransfer && ev.dataTransfer.files);
        });
      }
      panel.onpaste = (ev) => {
        if (cardsTab !== "uicreator") return;
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf("image/") === 0) {
            const f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) { ev.preventDefault(); addUiRefFiles(files); }
      };
      const search = panel.querySelector("#rs-cards-search");
      if (search) {
        search.addEventListener("input", () => {
          cardsQuery = search.value;
          visibleLibCache = libFiltered();
          const wrap = panel.querySelector("#rs-cards-grid-wrap");
          if (wrap) wrap.innerHTML = gridHtml();
        });
        setTimeout(() => { try { search.focus(); } catch {} }, 0);
      }
      const rngBtn = panel.querySelector("#rs-cards-rng");
      if (rngBtn) {
        rngBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          runRngTopic();
        });
      }
    }

    // ── Card send-embed ──
    // Pressing a library card shows a floating embed of exactly what you
    // picked (icon/title/category/desc) with a live status footer, AND wraps
    // the outgoing text in a matching unicode frame so your message in the
    // chat reads back as the same card you clicked.
    let cardEmbedEl = null, cardEmbedTimer = 0;
      function engineLabel(engine) { return engine === "an" ? "Animation" : "Roblox"; }
    function cardEmbedText(card) {
      // Plain text (NOT HTML) — this is what actually gets typed into the chat.
      const body = "\u256D\u2500 " + card.icon + " " + card.title + "  \u00B7 " + card.cat + " (" + engineLabel(card.engine) + ")\n"
        + "\u2502 " + card.desc + "\n"
        + "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"
        + card.prompt;
      try { if (RS.wrapTaskPrompt) return RS.wrapTaskPrompt(body); } catch {}
      return body;
    }
    function hideCardEmbed() {
      if (cardEmbedTimer) { clearTimeout(cardEmbedTimer); cardEmbedTimer = 0; }
      if (cardEmbedEl) cardEmbedEl.hidden = true;
    }
    function showCardEmbed(card, mode) {
      if (!card || !root) return;
      try {
        if (!cardEmbedEl || !cardEmbedEl.isConnected) {
          cardEmbedEl = document.createElement("div");
          cardEmbedEl.id = "rs-card-embed";
          root.appendChild(cardEmbedEl);
        }
        const stMap = {
          run:   '<span class="rs-ce-dot"></span>Sending to AI\u2026',
          ok:    '<span class="rs-ce-dot ok"></span>Sent to AI \u2713',
          paste: '<span class="rs-ce-dot paste"></span>In composer \u2014 press Enter',
          err:   '<span class="rs-ce-dot err"></span>Composer not found'
        };
        cardEmbedEl.innerHTML =
          '<div class="rs-ce-glyph">' + card.icon + '</div>'
          + '<div class="rs-ce-body">'
          +   '<div class="rs-ce-title">' + escRs(card.title)
          +     '<span class="rs-ce-chip">' + escRs(card.cat) + '</span>'
          +     '<span class="rs-ce-chip dim">' + engineLabel(card.engine) + '</span>'
          +   '</div>'
          +   '<div class="rs-ce-desc">' + escRs(card.desc) + '</div>'
          +   '<div class="rs-ce-status">' + (stMap[mode] || stMap.run) + '</div>'
          + '</div>';
        try { cardEmbedEl.dataset.mode = mode || "run"; } catch {}
        // Anchor above the cards FAB, right-aligned, clamped to the viewport.
        const r = cardsBtn.getBoundingClientRect();
        const w = cardEmbedEl.offsetWidth || 300;
        const h = cardEmbedEl.offsetHeight || 96;
        let top = r.top - h - 10;
        if (top < 8) top = Math.min(r.bottom + 10, Math.max(8, window.innerHeight - h - 8));
        let left = r.right - w;
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
        cardEmbedEl.style.top = top + "px";
        cardEmbedEl.style.left = left + "px";
        cardEmbedEl.hidden = false;
        // Restart the pop animation even when a second card replaces this one.
        cardEmbedEl.style.animation = "none";
        void cardEmbedEl.offsetWidth;
        cardEmbedEl.style.animation = "";
        if (cardEmbedTimer) clearTimeout(cardEmbedTimer);
        cardEmbedTimer = setTimeout(hideCardEmbed, mode === "paste" ? 4200 : 2600);
      } catch {}
    }

    // Click-to-run: drops the card's prompt straight into the site's composer
    // via the browser's native editing command (updates React/Angular/Vue
    // state the same way the agent loop injects its result messages).
    // Click-to-send: the card goes straight to the AI via the same
    // provider-native path the agent loop uses (types the framed embed into
    // the composer, then sends). Shift+click = paste only, for stacking
    // several cards first.
    async function runLibraryCard(card, send = true) {
      if (enforceCondo("card", [card && card.title, card && card.desc, card && card.prompt].filter(Boolean).join("\n"))) return;
      if (!send) { pasteLibraryCard(card); return; }
      try { cardsPanel.hidden = true; } catch {}
      hideCardEmbed();
      showCardEmbed(card, "run");
      let sent = false;
      try {
        if (typeof P !== "undefined" && P.typeAndSend) {
          await P.typeAndSend(cardEmbedText(card));
          sent = true;
        }
      } catch (e) { try { diag("cards.sendFail", { err: String(e).slice(0, 120) }); } catch {} }
      if (!sent) {
        const pasted = pasteLibraryCard(card, { silent: true });
        try {
          const btn = document.querySelector('[aria-label*="Send" i], [data-testid*="send" i], button[type="submit"]');
          if (btn && pasted) { btn.click(); sent = true; }
        } catch {}
        if (!sent) showCardEmbed(card, pasted ? "paste" : "err");
      }
      if (sent) showCardEmbed(card, "ok");
    }

    // Paste-only variant: inserts at the END of the composer WITHOUT sending.
    // Uses the browser's native editing command so React/Angular/Vue composer
    // state stays in sync. opts.silent suppresses the toast (the send-embed
    // reports the outcome instead); opts.embed pastes the framed card text.
    function pasteLibraryCard(card, opts) {
      const silent = !!(opts && opts.silent);
      const body = (opts && opts.embed) ? cardEmbedText(card) : card.prompt;
      const ed = (typeof P !== "undefined" && P.getEditor && P.getEditor()) || null;
      if (!ed) { toast("Open a chat first — the message box isn't on this page"); showCardEmbed(card, "err"); return false; }
      const isInput = ed.tagName === "TEXTAREA" || ed.tagName === "INPUT";
      let existing = "";
      try { existing = isInput ? (ed.value || "") : (ed.textContent || ""); } catch {}
      const payload = existing.trim() ? "\n\n" + body : body;
      try { ed.focus(); } catch {}
      try {
        if (isInput) {
          const L = (ed.value || "").length;
          ed.setSelectionRange(L, L);
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(ed);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
      let ok = false;
      try { ok = document.execCommand("insertText", false, payload); } catch {}
      if (!ok && isInput && typeof ed.setRangeText === "function") {
        try {
          const L = (ed.value || "").length;
          ed.setRangeText(payload, L, L, "end");
          ed.dispatchEvent(new Event("input", { bubbles: true }));
          ok = true;
        } catch {}
      }
      if (!ok) {
        try { ed.textContent = (existing || "") + payload; ed.dispatchEvent(new Event("input", { bubbles: true })); ok = true; } catch {}
      }
      if (!silent) toast(ok ? ("\u2795 " + card.title + " added \u2014 press Enter to run") : "Could not type into the composer.");
      return !!ok;
    }
    // Card event wiring moved into build() so cardsBtn/cardsPanel exist
    // ── First-time onboarding card (bridge missing) ─────────────────────────
    let setupCard = null, setupSeen = false, setupRaf = null;
    try {
      chrome.storage.local.get("rsSetupSeen", (r) => {
        if (r && r.rsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "rs-setup";
      setupCard.hidden = true;
      setupCard.innerHTML =
        `<div id="rs-setup-head"><span id="rs-setup-logo">OR</span><span id="rs-setup-tag">Setup</span></div>` +
        `<div id="rs-setup-sub">Three steps. Then talk to the AI like a teammate.</div>` +
        `<ol id="rs-setup-steps">` +
          `<li>Double-click <code>${RUN_CMD}</code> and leave it running</li>` +
          `<li>Pick <b>RS</b> for Studio or <b>AS</b> for a folder on this PC</li>` +
          `<li>Click <b>Start agent</b> on the bar</li>` +
        `</ol>` +
        `<div class="rs-setup-actions">` +
          `<button type="button" id="rs-setup-tutorial">Tutorial</button>` +
          `<button type="button" id="rs-setup-close" title="Dismiss setup">\u2715</button>` +
        `</div>`;
      document.documentElement.appendChild(setupCard);

      setupCard.querySelector("#rs-setup-tutorial").addEventListener("click", () => {
        openTutorial();
      });

      setupCard.querySelector("#rs-setup-close").addEventListener("click", () => {
        setupSeen = true;
        try { chrome.storage.local.set({ rsSetupSeen: true }); } catch {}
        hideSetup();
      });
    }

    // ── In-extension text tutorial (centered, scrollable modal) ─────────────
    // Replaces the outdated YouTube link: the walkthrough ships with the
    // extension and can never go stale relative to the UI.
    let tutorialEl = null;
    const TUTORIAL_HTML = `
      <h3>Welcome to OR</h3>
      <p>This extension turns your AI chat into a real agent. You talk, it <b>does</b> — switch engines on the bar:</p>
      <ul>
        <li><b>RS — Roblox</b>: builds inside Roblox Studio (instances, scripts, terrain, UI, lighting).</li>
        <li><b>AS — AgentScript</b>: works directly on a folder on your PC — files, code, terminal commands.</li>
      </ul>

      <h3>1 · Run the agent</h3>
      <p>Double-click <code>or-agent.exe</code> in your folder. A status window opens showing engines and a live console. Keep it running while you work.</p>

      <h3>2 · Connect an engine</h3>
      <p><b>RS:</b> open Roblox Studio → Assistant AI → ⋯ → Manage MCP Servers → enable Studio as MCP Server.<br>
      <b>AS:</b> nothing to connect — it's already your machine.</p>

      <h3>3 · Start the agent</h3>
      <p>Open any supported AI chat (DeepSeek, ChatGPT, Gemini, Kimi, Qwen, Arena, Meta AI, Copilot, Crax, or the built-in Ollama page). Click <b>Start agent</b> on the bar. The AI runs <code>list_commands</code>, then waits for your first request.</p>

      <h3>Power-ups</h3>
      <p>In the ⋯ menu toggle <b>Work in background tabs</b> (on by default) so the agent keeps building while you browse other sites. <b>Image → Model</b> pastes a builder template — attach a reference image and a vision-capable chat builds it.</p>

      <h3>AgentScript basics (AS)</h3>
      <p>The terminal button next to your chatbox opens your <b>Session summary</b>: every file edit, command run and search, with pass/fail states and counters.</p>
      <p>Ask naturally: "make a python script that sorts my downloads folder" or "fix the failing test in src/". The AI explores with <code>tree</code>/<code>grep_files</code>, edits with exact patches (<code>edit_file</code>) and verifies by running your tests itself — reading stdout/stderr without bothering you.</p>

      <h3>Danger zone — FULL ACCESS</h3>
      <p>By default AgentScript is confined to its workspace folder. At the bottom of the Session panel sits a red <b>Danger zone</b> with one toggle: <b>FULL ACCESS</b>. ON = the AI may use absolute paths anywhere on this PC and control processes. It stays off unless you flip it, and the agent window shows a red badge while it's on.</p>

      <h3>Troubleshooting</h3>
      <ul>
        <li><b>"Bridge offline"</b> → run or-agent.exe.</li>
        <li><b>RS says Studio offline</b> → enable the MCP server inside Studio (step 2), or hit <b>Repair Studio link</b> in the ⋯ menu.</li>
        <li><b>Wrong tools appearing</b> → check the RS/AS switch; switching wipes caches automatically.</li>
        <li><b>Commands do nothing</b> → reload the extension after updating the folder.</li>
      </ul>`;

    function buildTutorial() {
      tutorialEl = document.createElement("div");
      tutorialEl.id = "rs-tutorial";
      tutorialEl.innerHTML =
        '<div id="rs-tut-card">'
        +  '<div id="rs-tut-head">'
        +    '<span id="rs-tut-logo">OR</span><span id="rs-tut-tag">Tutorial</span>'
        +    '<button id="rs-tut-close" title="Close">\u2715</button>'
        +  '</div>'
        +  '<div id="rs-tut-body">' + TUTORIAL_HTML + '</div>'
        +  '<div id="rs-tut-foot"><button id="rs-tut-gotit">Got it \u2014 let\u2019s build</button></div>'
        + '</div>';
      document.documentElement.appendChild(tutorialEl);
      const close = () => { if (tutorialEl) tutorialEl.hidden = true; };
      tutorialEl.querySelector("#rs-tut-close").addEventListener("click", close);
      tutorialEl.querySelector("#rs-tut-gotit").addEventListener("click", close);
      tutorialEl.addEventListener("click", (e) => { if (e.target === tutorialEl) close(); });
      try { chrome.storage.local.set({ rsTutorialSeen: true }); } catch {}
    }

    function openTutorial() {
      if (!tutorialEl) buildTutorial();
      tutorialEl.hidden = false;
      const body = tutorialEl.querySelector("#rs-tut-body");
      if (body) body.scrollTop = 0;
    }

    // The onboarding card is pinned to the top-right corner (via CSS), out of the
    // way of the composer; nothing to reposition per frame (placeSetup was removed).
    function showSetup() {
      if (!setupCard) buildSetup();
      if (setupCard.hidden) {
        setupCard.hidden = false;
        cancelAnimationFrame(setupRaf);
      }
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
      cancelAnimationFrame(setupRaf);
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      // Bridge is down, but if the user is just READING an existing
      // conversation with no OR session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
    }

    // The single source of truth for the bar's content. Decides the dot tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting the Roblox agent…"
    //  • session active   → live dot, "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/Studio warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      if (!bar) return;
      // Persona badge: only visible when a specialist persona is active.
      
      try {
        const engEl = root && root.querySelector("#rs-engine");
        if (engEl) {
          // Dim = hint only. Never set .disabled here: a disabled button swallows
          // clicks before the delegated handler can fire, which made the toggle
          // feel completely dead. Switching stays allowed; START is what's gated.
          const gating = !!(A.bridge && A.bridge.connected);
          const rb = engEl.querySelector('[data-mode="roblox"]');
          if (rb) { const ok = !gating || robloxProcUp; rb.style.opacity = ok ? "" : "0.35"; rb.title = ok ? "Switch to Roblox" : "Roblox Studio not running"; }
        }
      } catch {}
      // indicator = an optional leading dot/spinner; msg = the wrappable text.
      let toneClass = "standby", indicator = "", msg = "", label = "", kind = "", disabled = false, warn = false;
      // Orphaned page: check FIRST and return. Nothing below can be true any
      // more - the status poll is stopped, so every value it would render (the
      // green dot, "Agent active", the tool count) is a frozen snapshot of a
      // build this page no longer talks to. Leaving those up contradicted the
      // "reload this page" banner sitting right next to them, which is exactly
      // the confusing state Seb caught on 2026-08-14.
      // No action button here: the banner already carries the Reload one.
      if (A.staleExtension) {
        if (dot) dot.className = "off";
        toneClass = "warn"; warn = true;
        msg = `<b>Disconnected</b> — reload this page (F5)`;
      }
      // Show "Starting…" for the whole bootstrap. If the user actually leaves for
      // a new (empty) chat, syncSessionState clears A.starting, so this naturally
      // falls back to that chat's own state - no fragile per-key check here (fresh
      // chats share a key, and the conversation id only appears mid-bootstrap).
      else if (A.starting) {
        toneClass = "starting";
        indicator = `<span class="rs-spin"></span>`;
        const _engineStarting = currentEngine === "local" ? "AgentScript" : "Roblox";
        msg = `Starting ${_engineStarting} agent…`;
        label = "Starting…"; kind = "starting"; disabled = true;
      } else if (A.started) {
        // Prefer the ADVERTISED list length (A.toolList - the AGGREGATE catalogue
        // across every connected MCP server, already filtered by the vision/blocked
        // gate so it matches what the model actually has: e.g. screen_capture is
        // absent on non-vision providers like Kimi). After a page reload A.toolList
        // is empty until the next list_tools, so fall back to the sum of every
        // server's per-server health count (Roblox + addons like Blender) - NOT the
        // Roblox-only count, which made the total drop to just 27 after a reload.
        const healthTotal = A.bridge &&
          (A.bridge.servers || []).reduce((n, x) => n + (x.tools || 0), 0);
        const tools = A.toolList.length || healthTotal || (A.bridge && A.bridge.tools) || 0;
        // "N tools" only means StudioMCP itself is up - it advertises its full
        // catalogue even with no Studio/place attached (see probe_studio() in
        // bridge.py), so showing it while Studio/place isn't actually usable
        // reads as "everything's fine" when tool calls will just fail. Surface
        // the real blocker instead in that case.
        const _isUnrealStarted = false;
        const _isLocalStarted = currentEngine === "local";
        if (A.bridge && A.bridge.connected === false) {
          // placeDown/appDown/studioDown are all false in this case (they're
          // only computed when the bridge IS connected - see setStatus), so
          // without this check the bridge dropping fell through to the
          // stale "N tools" text below, reading as if nothing was wrong.
          toneClass = "warn"; warn = true;
          msg = `<b>Agent running</b> — bridge is down, run ${RUN_CMD}`;
        } else if (_isLocalStarted) {
          if (placeDown || appDown || studioDown) {
            toneClass = "warn"; warn = true;
            msg = `<b>Agent running</b> — AgentScript is offline, start or-agent.exe`;
          } else {
            toneClass = "active";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
          }
        } else if (_isUnrealStarted) {
          if ((placeDown || appDown || studioDown) && addonOk) {
            toneClass = "warn";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""} — engine offline`;
          } else if (placeDown || appDown || studioDown) {
            toneClass = "warn"; warn = true;
            msg = `<b>Agent running</b> — open Roblox Studio and enable its MCP server`;
          } else {
            toneClass = "active";
            msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
          }
        } else if ((placeDown || appDown || studioDown) && addonOk) {
          // DEGRADED session by CHOICE: the user started the agent with Roblox
          // down but other MCP server(s) alive (the "Start agent (Roblox
          // offline)" path) - they may only want the addon tools (e.g. Blender).
          // Keep the YELLOW dot as the honest health signal, but do NOT keep the
          // red imperative "open Roblox Studio" nag on screen for the whole
          // session (warn=false → no rs-state-warn red text). The full nag
          // still shows when NO server is usable (the branches below).
          toneClass = "warn";
          msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""} — Roblox offline`;
        } else if (placeDown) {
          toneClass = "warn"; warn = true;
          msg = `<b>Agent running</b> — open a place in Studio`;
        } else if (appDown || studioDown) {
          toneClass = "warn"; warn = true;
          msg = studioProcUp
            ? `<b>Agent running</b> — Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b>`
            : `<b>Agent running</b> — open Studio and enable its MCP server`;
        } else {
          toneClass = "active";
          // No inline dot here: the leading status dot already shows green, two
          // dots side by side looked cluttered. The green "Agent active" text
          // carries it.
          msg = `<b>Agent running</b>${tools ?  ` — ${tools} tools` : ""}`;
        }
        // Started chat — also offer Restart in the exact Start slot so user can
        // re-bootstrap mid-chat in either engine.
        {
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = !bridgeOk && !addonOk;
        }
      } else if (P.isFreshChat() || P.chatIsEmpty()) {
        // Treat ANY empty chat (no turns yet) as the standby/start case - not just
        // the strict fresh-chat match. isFreshChat() also requires an exact root
        // path AND the editor already mounted; on a cold load (e.g. arriving from a
        // search-engine link) the SPA can show pathname/editor before they settle,
        // which used to drop into the discouraging "No agent here" branch on a page
        // that is actually empty and startable. "No agent here" is only correct for
        // an EXISTING conversation (one that has turns) we did not start.
        if (bridgeOk) {
          toneClass = "standby";
          msg = `Ready — Start to drive Studio, or just chat.`;
          label = "▶︎ Start Agent"; kind = "start";
        } else if (addonOk) {
          // Primary engine is down but another MCP server is live: allow a DEGRADED start
          // (yellow). The agent runs on the other server(s); primary tools stay
          // unavailable until it's back. Button enabled, but visibly warned.
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `<b>Unreal offline</b> - start with your other MCP server(s).`;
          } else {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : studioProcUp
                ? `<b>Studio open but not connected</b> - open <b>Assistant Settings &gt; MCP Servers</b> in Studio, or start without it.`
                : `<b>Roblox Studio offline</b> - start with your other MCP server(s).`;
          }
          label = "▶︎ Start agent (engine offline)"; kind = "start-degraded";
        } else {
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          } else {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : placeDown
                ? `Open a <b>place</b> in Roblox Studio.`
                : (appDown || studioDown) && studioProcUp
                  ? `Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b> in Studio.`
                  : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          }
          label = "▶︎ Start Agent"; kind = "start";
        }
        disabled = !bridgeOk && !addonOk;
        } else {
        // Existing chat with no session: offer Restart in place of Start
        // so the AI will work mid-conversation (user request). Engine-aware
        // always occupies the same slot as Start for muscle-memory.
        const canRestart = bridgeOk || addonOk;
        if (canRestart) {
          toneClass = "standby";
          msg = `No agent on this chat. Restart to start <b>Roblox</b>.`;
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = false;
        } else {
          toneClass = "warn"; warn = true;
          if (currentEngine === "unreal") {
            msg = !A.bridge.connected
              ? `Run <b>${RUN_CMD}</b>.`
              : `Open <b>Roblox Studio</b> and enable its MCP server.`;
          } else {
            if (!A.bridge.connected) {
              msg = `Run <b>${RUN_CMD}</b>.`;
            } else if (placeDown) {
              msg = `Open a <b>place</b> in Roblox Studio.`;
            } else if ((appDown || studioDown) && studioProcUp) {
              msg = `Studio is open but MCP is off — open <b>Assistant Settings &gt; MCP Servers</b> in Studio.`;
            } else {
              msg = `Open <b>Roblox Studio</b> and enable its MCP server.`;
            }
          }
          label = "↻ Restart Agent";
          kind = "restart";
          disabled = true;
        }
      }
      // Engine readiness gate: only meaningful when the bridge is up — with the
      // agent offline the proc flags are stale, and the bridge-down branches
      // above already show the right "run or-agent.exe" message.
      if (A.bridge && A.bridge.connected && currentEngine !== "local") {
        const curUp = robloxProcUp;
        if (!curUp && (kind === "start" || kind === "start-degraded" || kind === "restart")) {
          toneClass = "warn"; warn = true;
          msg = currentEngine === "unreal"
            ? `Open <b>Roblox Studio</b> to use OR.`
            : `Open <b>Roblox Studio</b> to use OR.`;
          disabled = true;
        }
      }
      // Parked on visibility: the loop is alive but deliberately frozen because
      // this tab is not the foreground tab of its window. Say so explicitly -
      // otherwise the bar keeps claiming "Agent active" while nothing advances,
      // which reads as a hang (and is what users reported as "it died in the
      // background"). No red warn tone: this is a normal, recoverable pause.
      if (A.parked && (A.running || A.starting)) {
        toneClass = "warn"; warn = false;
        msg = `<b>Paused</b> — this tab is in the background. Bring it forward to continue.`;
      }
      // Provider mode guard: some sites (e.g. Arena) only work in one chat mode.
      // When the provider reports the current mode is unsupported, override the
      // bar into a visible warning and disable Start until the user switches back.
      // Skipped once a session is started/starting (the mode is fixed for the
      // conversation by then). Reactive: renderBar runs on every sweep, so the
      // warning appears/clears the instant the user changes the mode dropdown.
      if (!A.started && !A.starting && P.modeWarning) {
        const modeWarn = P.modeWarning();
        if (modeWarn) {
          toneClass = "warn"; warn = true; msg = modeWarn;
          if (kind === "start" || kind === "start-degraded" || kind === "restart") disabled = true;
        }
      }
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Before a session is started, the bar stays minimal: only the Start action
      // + Discord (help). The AI selector and the tips/support menu appear once the
      // agent is actually running - so the pre-start bar isn't cluttered with
      // options that only matter mid-session. (A.started is ambiguous with `warn`
      // tone - which occurs both started-with-bridge-down and standby-with-bridge-
      // down - so it's tracked explicitly in the signature.)
      const showExtras = !!A.started;
      const sig = [toneClass, indicator, msg, label, kind, disabled, warn, busy, showExtras].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. rs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      stateEl.innerHTML = indicator + `<span class="rs-state-txt">${msg}</span>`;
      stateEl.classList.toggle("rs-state-warn", warn);
      // Inline dynamic status pill — RS/US Connected, Simulated, Offline
      try {
        const pill = root.querySelector("#rs-status-pill");
        const dot = pill && pill.querySelector(".rs-status-dot");
        const txt = pill && pill.querySelector(".rs-status-text");
        if (pill && txt) {
          const isUnreal = false;
          const isSim = false;
          const procUp = robloxProcUp;
          const isConnected = A.bridge && A.bridge.roblox_connected;
          const legacyConnected = studioConnected;
          const wsConnected = isConnected !== undefined ?  isConnected : legacyConnected;
          const connected = wsConnected && procUp;
          pill.hidden = false;
          pill.classList.remove("rs-status-connected", "rs-status-simulated", "rs-status-offline");
          if (isSim) {
            pill.classList.add("rs-status-simulated");
            txt.textContent = "Simulated";
            if (dot) dot.className = "rs-status-dot";
          } else if (connected) {
            pill.classList.add("rs-status-connected");
            txt.textContent = currentMode === "local" ? "AS Connected" : "RS Connected";
            if (dot) dot.className = "rs-status-dot";
          } else {
            pill.classList.add("rs-status-offline");
            txt.textContent = "Offline - run or-agent.exe";
            if (dot) dot.className = "rs-status-dot";
          }
        }
      } catch {}
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.disabled = disabled;
      // Tooltip shows the target engine without stretching the button text
      try {
      if (kind === "restart") actionBtn.title = currentMode === "local" ? "Restart AgentScript agent" : "Restart Roblox agent";
      else if (kind === "start" || kind === "start-degraded") actionBtn.title = currentMode === "local" ? "▶︎ Start AgentScript agent" : "▶︎ Start OR agent";
        else actionBtn.title = "";
      } catch {}
      // Context meter: approximate system-prompt cost beside Start/Restart so
      // users see what this engine+site combination actually spends.
      try {
        const cEl = root.querySelector("#rs-ctx");
        if (cEl) {
          const si = A.sysInfo;
          const relevant = kind === "start" || kind === "start-degraded" || kind === "restart";
          cEl.hidden = !(si && si.tokens && relevant);
          if (!cEl.hidden) {
            const k = si.tokens / 1000;
            cEl.textContent = (k >= 1 ? k.toFixed(1).replace(/\.0$/, "") + "k" : String(si.tokens)) + " tok";
            const budget = P.sysMaxChars || 18000; // chars before compact/limits kick in
            const ratio = si.len / budget;
            cEl.classList.toggle("warn", ratio >= 0.7 && ratio < 1);
            cEl.classList.toggle("high", ratio >= 1);
            cEl.title = `System prompt \u2248 ${si.tokens.toLocaleString()} tokens (${si.len.toLocaleString()} chars)\nEngine: ${si.engine.toUpperCase()}${P.sysMaxChars ? " · site budget " + P.sysMaxChars + " chars" : ""}\nLower = faster, cheaper replies. Custom prompt & thinking level add to this.`;
          }
        }
      } catch {}
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector + tips/support: only once a session is live. Discord stays
      // visible in every state (it's the help link).
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { try{updateExtraButton();}catch{}; renderBar(); }
    function setStarting() { try{updateExtraButton();}catch{}; renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      try { window.__rsBlender = () => !!(s && s.blender); } catch {}
      // AgentScript ground truth from the agent process itself. Re-render the
      // open session panel so the Danger-zone toggle mirrors the agent.
      try {
        if (typeof s.local_full === "boolean") {
          const prev = typeof window.__rsFullAccess === "function" ? window.__rsFullAccess() : null;
          window.__rsFullAccess = () => s.local_full;
          if (prev !== s.local_full && activeEngine() === "local" && cardsPanel && !cardsPanel.hidden) {
            renderCards(cardsPanel);
          }
        }
      } catch {}
      if (!dot) return;
      const servers = s.servers || [];
      // Engine-aware primary across all three engines. Background's `engine` is
      // authoritative; fall back to the UI's currentEngine while status is in flight.
      const eff = (s.engine === "local" || currentEngine === "local") && s.engine !== "roblox"
        ? "local" : "roblox";
      const isUnreal = false;
      const isLocal = eff === "local";
      const primaryId = eff;
      const primary = servers.find((x) => x.id === primaryId);
      const mcpUp = primary ?  !!primary.alive : (!!s.mcpAlive || servers.some((x) => x.alive));
      const primaryTools = primary ?  (primary.tools || 0) : (s.tools || 0);
      // The local bridge/helper can be alive without an editor. Only the
      // editor-backed probe is allowed to make the primary server usable.
      const editorConnected = isUnreal ? s.unreal_connected === true
        : isLocal ? (s.local_connected === true || (!!primary && primary.alive === true))
        : s.roblox_connected === true;
      const mcpOk = !!s.connected;
      const totalTools = servers.reduce((n, x) => n + (x.tools || 0), 0) || s.tools || primaryTools;
      // studio === false means the engine's MCP/RemoteExecution answered but the
      // editor is not USABLE (no place/level). Same tri-state for both engines.
      const studioOff = mcpOk && !editorConnected;
      const noApp = studioOff && s.studioApp === false;
      const noPlace = studioOff && s.studioApp === true;
      const ok = mcpOk && editorConnected;
      dot.className = s.connected ?  (ok ?  "on" : "warn") : "off";
      const procUp = s.studioProc === true;
      let txt;
      if (!s.connected) txt = `Bridge offline, run ${RUN_CMD}`;
      else if (!mcpOk) txt = isUnreal ?  "Bridge OK, open Unreal Editor 5.8" : isLocal ? "Bridge OK — AgentScript workspace ready" : "Bridge OK, open Roblox Studio";
      else if (isLocal) txt = ok ? `Connected · ${totalTools} tools ready` : "AgentScript not ready - start or-agent.exe";
      else if (noPlace) txt = isUnreal ?  "Unreal Editor is open but no level is loaded - open a level" : "Roblox Studio is open but no place is loaded - open a place";
      else if (noApp) txt = procUp
        ? (isUnreal ?  "Editor is open but not connected - enable Python Remote Execution (Edit > Plugins > Python)" : "Studio is open but not connected - in Studio, open Assistant Settings > MCP Servers (or toggle its MCP server off/on)")
        : (isUnreal ?  "Unreal Editor not connected - open it and enable Remote Execution" : "Roblox Studio not connected - open it and enable its MCP server");
      else if (studioOff) txt = isUnreal ?  "Editor not connected, enable Remote Execution" : "Studio not connected, enable the MCP server in Roblox Studio";
      else txt = `Connected · ${totalTools} tools ready`;
      dot.title = txt;
      bridgeOk = ok;
      studioDown = studioOff;
      placeDown = noPlace;
      appDown = noApp;
      studioProcUp = procUp;
      if (typeof s.robloxProc === "boolean") robloxProcUp = s.robloxProc;
      else if (!isUnreal && typeof s.studioProc === "boolean") robloxProcUp = s.studioProc;
      if (typeof s.unrealProc === "boolean") unrealProcUp = s.unrealProc;
      else if (isUnreal && typeof s.studioProc === "boolean") unrealProcUp = s.studioProc;
      // Auto-follow the open editor, but NEVER fight a recent manual toggle:
      // only switch when the bridge is up, the current engine's app is closed,
      // the other one is open, and the user hasn't clicked the toggle in a while.
      try {
        // NEVER auto-switch out of AgentScript: there is no "other app" heuristic
        // for a folder, and flipping to roblox/unreal stole AS sessions silently.
        if (false && s.connected && engineApi && currentEngine !== "local" && Date.now() - lastManualEngineAt > 20000) {
          /* auto-switch between editors removed — Unreal engine is gone */
        }
      } catch {}
      // A non-primary MCP (e.g. Blender when Roblox is primary, or vice-versa) that is
      // actually alive. Lets a DEGRADED session start on the other engine.
      addonOk = !!s.connected && servers.some((x) => x.id !== primaryId && x.alive && (x.tools || 0) > 0);
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      // Once the bridge has connected at least once, onboarding is done: never
      // resurface the "download the bridge" setup card again (otherwise, if the
      // bridge later drops, it would reappear on top of the bridge-lost banner).
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ rsSetupSeen: true }); } catch {}
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // The page outlived its extension build (reload / Chrome auto-update /
    // disable+enable). Distinct from bridgeAlert on purpose: opposite cause,
    // opposite fix, and this one NEVER self-heals, so the banner has no Close
    // button and offers the reload directly rather than telling the user to go
    // restart a bridge that was never down.
    function staleExtensionAlert() {
      // Latch it BEFORE painting, so the bar drops its frozen "Agent active ·
      // N tools" in the same pass and never contradicts the banner.
      A.staleExtension = true;
      renderBar();
      if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
      if (root.querySelector(".rs-banner.rs-stale")) return;
      const b = document.createElement("div");
      b.className = "rs-banner limit rs-stale";
      b.innerHTML = `<div class="rs-banner-t">⚠ Need a refresh</div>
        <div class="rs-banner-m">This tab's running an old version after the extension updated — commands won't go through anymore. Studio and the bridge are fine, just reload this page.</div>
        <div class="rs-banner-acts"><button class="rs-banner-reload">Reload page</button></div>`;
      b.querySelector(".rs-banner-reload").addEventListener("click", () => location.reload());
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) {
      if (!on) {
        if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
        return;
      }
      if (bridgeBannerEl) return; // already shown
      const b = document.createElement("div");
      b.className = "rs-banner limit";
      // The setup tutorial lives INSIDE this banner (not as a separate card) so it
      // can never overlap the alert - the previous standalone onboarding card did.
      b.innerHTML = `<div class="rs-banner-t">⚠ Bridge went down</div>
        <div class="rs-banner-m">Bridge stopped. Just run ${RUN_CMD} again (keep Studio open) — it'll hop back on automatically when it's back.</div>
        <div class="rs-banner-acts"><button class="rs-banner-video" id="rs-banner-tut">◇ Tutorial</button><button class="rs-banner-x">Close</button></div>`;
      b.querySelector("#rs-banner-tut").addEventListener("click", () => openTutorial());
      b.querySelector(".rs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled " Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = " Stopping…";
      renderBar();
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable Roblox control.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        toast("Hit Start if you want the AI to drive Studio.");
      }
      if (!actionBtn) return;
      actionBtn.classList.add("rs-flash");
      setTimeout(() => actionBtn.classList.remove("rs-flash"), 1200);
    }

    // ── Theme auto-detection (light / dark) ─────────────────────────────────
    // The panel and the in-conversation chips are dark-themed by default. On a
    // LIGHT host page the chips' light text on a near-transparent tint becomes
    // invisible, so we detect the page's effective background luminance and add
    // `.rs-light` to <html>; overlay.css then flips to readable light colours.
    // Most chat sites declare their theme EXPLICITLY (a `dark`/`light` class on
    // <html>/<body>, a data-theme attribute, or CSS color-scheme) - far more
    // reliable than luminance, since many (e.g. z.ai) leave <html>/<body> with a
    // transparent background and paint the theme on a deeper container. Returns
    // "light" | "dark" | null (no explicit signal).
    function pageThemeHint() {
      const de = document.documentElement, b = document.body;
      const cls = (de.className + " " + (b ?  b.className : "")).toLowerCase();
      if (/\bdark\b/.test(cls)) return "dark";
      if (/\blight\b/.test(cls)) return "light";
      const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                    de.getAttribute("data-color-scheme") || "").toLowerCase();
      if (/dark/.test(attr)) return "dark";
      if (/light/.test(attr)) return "light";
      const cs = (getComputedStyle(de).colorScheme || "").toLowerCase();
      if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
      if (/light/.test(cs) && !/dark/.test(cs)) return "light";
      return null;
    }
    // Fallback only: luminance of the first opaque background up the tree.
    function effectiveBg() {
      let n = document.body;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor || "rgb(255,255,255)";
    }
    function applyTheme() {
      let light;
      const hint = pageThemeHint();
      if (hint) {
        light = hint === "light";
      } else {
        const m = (effectiveBg().match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (m.length < 3) return;
        light = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
      }
      document.documentElement.classList.toggle("rs-light", light);
    }

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (inside the composer above the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      try {
        const m = P.barMount();
        return (m && m.parent && m.parent.isConnected) ? m : null;
      } catch (e) { try { log("barMount threw", e); } catch {} return null; }
    }

    // Floating fallback geometry (used only when no inline mount is available).
    const BAR_MAX_W = 560, BAR_GAP = 8;

    // Anchored mode bookkeeping: the composer element whose top padding we are
    // borrowing to seat the bar (see the anchored branch below). Cleared when we
    // leave anchored mode so the site's composer returns to its normal layout.
    let anchorPadEl = null, inlineWidenEl = null;
    function clearAnchorPad() {
      if (anchorPadEl) { try { anchorPadEl.style.paddingTop = ""; anchorPadEl.style.maxWidth = ""; anchorPadEl.style.width = ""; anchorPadEl.style.marginLeft = ""; anchorPadEl.style.marginRight = ""; } catch {} anchorPadEl = null; }
      if (inlineWidenEl) { try { inlineWidenEl.style.maxWidth = ""; inlineWidenEl.style.width = ""; inlineWidenEl.style.marginLeft = ""; inlineWidenEl.style.marginRight = ""; } catch {} inlineWidenEl = null; }
    }

    // Inline unstable pill lives inside the bar — no floating positioning needed.
    // Keep it visible when the bar is visible and the provider is marked unstable.
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      // If it's the inline pill, just ensure it reflects P.unstableWarning and bar visibility
      if (u.id === "rs-unstable-inline") {
        const shouldShow = !!P.unstableWarning && bar && bar.style.display !== "none" && bar.getBoundingClientRect().width > 0;
        u.hidden = !shouldShow;
        return;
      }
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      u.style.left = Math.round(br.left) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    // The cards fab is a fixed SQUARE floating left of the chatbox, vertically
    // centered on the composer card (barAnchor = the rounded chatbox on every
    // site; falls back to composerFrame/editor/bar strip). Re-measured every
    // rAF tick (1-frame lag).
    const FAB_SIZE = 52;
    let fabThemeTick = 0, fabActivityTick = 0;
    function parseRgb(str) {
      const m = str && str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((s) => parseFloat(s));
      if (p.length < 3 || p.some((n) => isNaN(n))) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    // Mirror the host chatbox surface onto the FAB so it reads as native
    // chrome on every site: sample the anchor's computed background (walking
    // up past transparent shells), expose it as CSS custom properties (so
    // :hover rules still work), and tag light/dark for icon contrast.
    function syncFabTheme(fit) {
      try {
        let el = fit, bg = null, hops = 0;
        while (el && hops < 5) {
          const c = parseRgb(getComputedStyle(el).backgroundColor);
          if (c && c.a >= 0.04) { bg = c; break; }
          el = el.parentElement; hops++;
        }
        if (!bg) { // nothing solid found — back to the default glass
          cardsBtn.style.removeProperty("--fab-bg");
          cardsBtn.style.removeProperty("--fab-ring");
          cardsBtn.removeAttribute("data-lum");
          return;
        }
        const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
        const light = lum > 150;
        const mix = (v) => Math.round(Math.max(0, Math.min(255, v)));
        const ring = light ? "rgba(15,23,42,0.14)" : "rgba(255,255,255,0.10)";
        const tint = light
          ? `rgba(${mix(bg.r - 8)},${mix(bg.g - 8)},${mix(bg.b - 8)},${Math.min(1, bg.a)})`
          : `rgba(${mix(bg.r + 10)},${mix(bg.g + 10)},${mix(bg.b + 12)},${Math.min(1, bg.a + 0.06)})`;
        cardsBtn.style.setProperty("--fab-bg", tint);
        cardsBtn.style.setProperty("--fab-ring", ring);
        cardsBtn.setAttribute("data-lum", light ? "light" : "dark");
      } catch {}
    }
    function placeCardsFab() {
      try {
        if (!cardsBtn || !bar) return;
        const br = bar.getBoundingClientRect();
        if (bar.style.display === "none" || !br.width) {
          cardsBtn.style.display = "none";
          return;
        }
        let fit = null;
        try { fit = (P.barAnchor && P.barAnchor()) || null; } catch {}
        if (!fit || !fit.isConnected) { try { fit = (P.composerFrame && P.composerFrame()) || null; } catch {} }
        if (!fit || !fit.isConnected) { fit = (P.getEditor && P.getEditor()) || null; }
        if (!fit || !fit.isConnected) {
          fit = bar.parentElement;
          if (fit === root || fit === document.documentElement) fit = null;
        }
        let fr = fit ? fit.getBoundingClientRect() : null;
        if (!fr || !fr.height || fr.height < br.height) fr = br;
        if (!fr || !fr.width || fr.left < 0) {
          cardsBtn.style.display = "none";
          return;
        }
        cardsBtn.style.display = "";
        let left = fr.left - FAB_SIZE - 10;
        if (left < 8) left = 8;
        const top = fr.top + (fr.height - FAB_SIZE) / 2;
        cardsBtn.style.left = Math.round(left) + "px";
        cardsBtn.style.top = Math.round(top) + "px";
        fabThemeTick++;
        if (fit && fabThemeTick % 30 === 1) syncFabTheme(fit);
        if (cardsPanel && !cardsPanel.hidden && (cardsTab === "activity" || activeEngine() === "local") && recentCards.length) {
          fabActivityTick++;
          if (fabActivityTick % 300 === 0) renderCards(cardsPanel);
        }
      } catch (err) {}
    }

    function placeBar() {
      barRaf = requestAnimationFrame(placeBar);
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #rs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // rAF loop is resilient (its next frame is scheduled before any body code),
      // so the panel reappears on the very next frame.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every frame - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();
      placeCardsFab();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next frame once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        (P.overlayBlocking && P.overlayBlocking())
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (menuEl) menuEl.hidden = true;
        return;
      }

      // Preferred: in-flow mount inside the composer (no overlap, full width).
      const mount = computeBarMount();
      if (mount) {
        clearAnchorPad();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("rs-bar-inline")) {
          bar.classList.add("rs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        // Transparent (blends in) when mounted INSIDE the input box; surface card
        // when mounted ABOVE it. The provider's barMount() signals which via .inside.
        bar.classList.toggle("rs-bar-inside", !!mount.inside);
        bar.style.display = "flex";
        if (menuEl && !menuEl.hidden) {
          const br = bar.getBoundingClientRect();
          menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
        }
        if (mcpMenuEl && !mcpMenuEl.hidden) {
          const br = bar.getBoundingClientRect();
          mcpMenuEl.style.right = Math.round(window.innerWidth - br.right + 32) + "px";
          mcpMenuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
          mcpMenuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
        }
        return;
      }

      // Anchored mode: the provider wants the integrated, in-composer LOOK but
      // its composer is a framework-reconciled subtree we must NOT insert our
      // node into (e.g. Kimi's Vue tree - inserting #rs-bar there makes Vue's
      // next diff reuse the bar node as a host and nest the editor inside it).
      // So we keep the bar in our own #rs-root, position it (position:fixed) to
      // hug the composer's top edge at full width, and RESERVE that strip with
      // padding-top on the composer so it reads as in-flow without ever becoming
      // a child of the framework's DOM. barAnchor() returns the element to hug.
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        bar.classList.remove("rs-bar-inline", "rs-bar-inside");
        bar.classList.add("rs-bar-anchored");
        if (root && bar.parentElement !== root) root.appendChild(bar);
        const r = anchorEl.getBoundingClientRect();
        if (!r.width) { bar.style.display = "none"; clearAnchorPad(); if (menuEl) menuEl.hidden = true; return; }
        bar.style.display = "flex";
        const bh = bar.offsetHeight || 34;
        if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
        anchorPadEl = anchorEl;
        anchorEl.style.paddingTop = (bh + 6) + "px"; // reserve the strip the bar sits in (+gap)
        bar.style.left = Math.round(r.left) + "px";
        bar.style.top = Math.round(r.top) + "px";
        bar.style.width = Math.round(r.width) + "px";
        if (menuEl && !menuEl.hidden) {
          bar.classList.remove("rs-bar-inline"); // ensure fixed geometry for menu math
          menuEl.style.right = Math.round(window.innerWidth - (r.left + r.width)) + "px";
          menuEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
          menuEl.style.maxHeight = Math.max(140, Math.round(r.top - 16)) + "px";
        }
        if (mcpMenuEl && !mcpMenuEl.hidden) {
          bar.classList.remove("rs-bar-inline");
          mcpMenuEl.style.right = Math.round(window.innerWidth - (r.left + r.width) + 32) + "px";
          mcpMenuEl.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
          mcpMenuEl.style.maxHeight = Math.max(140, Math.round(r.top - 16)) + "px";
        }
        return;
      }
      bar.classList.remove("rs-bar-anchored");
      clearAnchorPad();

      // Fallback: float just above the editor (fixed positioning), for sites
      // where no clean inline mount could be resolved.
      if (bar.classList.contains("rs-bar-inline")) {
        bar.classList.remove("rs-bar-inline");
        if (root && bar.parentElement !== root) root.appendChild(bar);
      }
      const f = (P.getEditor && P.getEditor()) || (P.composerFrame && P.composerFrame());
      bar.style.display = "flex";
      // No composer yet (or 0-width during layout): keep the bar on screen so
      // the agent is never "gone". Dock it to the bottom of the viewport.
      const r = f && f.isConnected ? f.getBoundingClientRect() : null;
      // If composer is missing, unlaid-out (0 width), or scrolled off-screen / at top (0,0),
      // dock safely above the bottom of the viewport so the bar NEVER jumps to the top corner.
      if (!f || !r || !r.width || r.top <= 10 || r.bottom <= 20) {
        const w = Math.min(window.innerWidth - 24, BAR_MAX_W);
        const bh = bar.offsetHeight || 40;
        bar.style.width = w + "px";
        bar.style.left = Math.round((window.innerWidth - w) / 2) + "px";
        bar.style.top = Math.max(8, Math.round(window.innerHeight - bh - 16)) + "px";
        return;
      }
      const w = Math.min(r.width, BAR_MAX_W);
      const left = Math.round(r.left + (r.width - w) / 2);
      const bh = bar.offsetHeight || 40;
      const top = Math.max(4, Math.round(r.top - bh - BAR_GAP));
      bar.style.width = w + "px";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // Keep the open "more" menu anchored to the bar, opening upward.
      if (menuEl && !menuEl.hidden) {
        const br = bar.getBoundingClientRect();
        menuEl.style.right = Math.round(window.innerWidth - br.right) + "px";
        menuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
        menuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
      }
      if (mcpMenuEl && !mcpMenuEl.hidden) {
        const br = bar.getBoundingClientRect();
        mcpMenuEl.style.right = Math.round(window.innerWidth - br.right + 32) + "px";
        mcpMenuEl.style.bottom = Math.round(window.innerHeight - br.top + 6) + "px";
        mcpMenuEl.style.maxHeight = Math.max(140, Math.round(br.top - 16)) + "px";
      }
    }

    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // Returns a FULLY OPAQUE colour that matches what is VISUALLY behind the cover.
    // The cover must hide the typed text, so it can't be translucent - but simply
    // returning the first solid ancestor is wrong when the composer surface itself
    // is translucent: Meta's card is rgba(56,56,56,0.8) over a dark page, so its
    // real on-screen colour is a BLEND (~rgb(50,50,50)), lighter than the bare page
    // (rgb(24,24,25)). Filling the cover with the page colour made it visibly
    // darker than the composer. So collect the background layers from `el` up to
    // the first opaque ancestor and FLATTEN them (alpha compositing) into one solid
    // colour that reproduces the composer's actual appearance.
    function opaqueBg(el) {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.999) break; // opaque base reached - nothing behind matters
        }
        n = n.parentElement;
      }
      // Guarantee an opaque base at the bottom of the stack.
      if (!layers.length || layers[layers.length - 1].a < 0.999) {
        const base = parseColor(getComputedStyle(document.body).backgroundColor) ||
                     { r: 255, g: 255, b: 255, a: 1 };
        layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
      }
      // We collected top-most (el) first, so composite from the opaque base (last)
      // upward toward el (first).
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
      return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
    }
    // Parse an rgb()/rgba() computed colour into {r,g,b,a}. Returns null for
    // "transparent"/unparseable. getComputedStyle always yields rgb/rgba form.
    function parseColor(c) {
      if (!c || c === "transparent") return null;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ?  p[3] : 1 };
    }
    // Source-over compositing of a (possibly translucent) fg onto an opaque bg.
    function blendOver(fg, bg) {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    }

    function inputCover(on) {
      const ed = P.getEditor();
      if (!on) {
        if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
        if (ed) ed.classList.remove("rs-typing");
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      ed.classList.add("rs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "rs-input-cover";
        cover.innerHTML = `<span>Agent is working…</span>`;
        document.documentElement.appendChild(cover);
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        const e = P.getEditor();
        if (!e) { coverRaf = requestAnimationFrame(place); return; }
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add every frame keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("rs-typing")) e.classList.add("rs-typing");
        // The cover is SIZED to coverTarget() when a provider supplies one, else
        // to the editor node itself. Some composers (Meta AI) make the editable a
        // tiny line inside a much larger rounded card - covering only the editor
        // left the rest of the card exposed and CLICKABLE (a careful click focused
        // the editor and let the user type behind the cover). Meta returns its
        // whole composer card so the cover blankets the entire input band and its
        // pointer-events:auto blocks every click. The typing mask above still lives
        // on the real editor node `e`.
        const covNode = (P.coverTarget && P.coverTarget()) || e;
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          (P.overlayBlocking && P.overlayBlocking()) ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          coverRaf = requestAnimationFrame(place);
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .rs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        // The SAME clipping applies horizontally, and for the same reason: a
        // composer whose editor is a flex item grows to its content width when a
        // long unbroken line is injected, while an ancestor with overflow-x:hidden
        // keeps the PAGE looking right. Seen on ChatGPT at Start, where the editor
        // is filled with the (large) system prompt: the inner
        // .prosemirror-parent widened past its `-my-2.5 flex overflow-x-hidden`
        // wrapper, so the cover - position:fixed and sized to the raw rect - stuck
        // out to the RIGHT of the composer card. Clip on each axis independently:
        // the ancestor that clips X is not always the one that clips Y.
        let clipY = false, clipX = false;
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
          const st = getComputedStyle(a);
          const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
          const ar = a.getBoundingClientRect();
          if (!clipY && clips(st.overflowY)) {
            clipY = true;
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
          }
          if (!clipX && clips(st.overflowX)) {
            clipX = true;
            const left = Math.max(r.left, ar.left);
            const right = Math.min(r.right, ar.right);
            if (right > left) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never paint outside the composer card. The cover is position:fixed and
        // re-placed every rAF from a freshly measured rect, which is correct while
        // the page is still - but a site that ANIMATES its composer updates layout
        // AFTER our callback, so for the whole animation the cover trails one frame
        // behind. Seen on ChatGPT at Start: injecting the system prompt grows the
        // composer 58px -> 156px, the page gains a scrollbar, the content column
        // narrows and the composer slides 29px left - while the cover kept the
        // previous coordinates and hung 28px past the card's right edge. It only
        // showed on the FIRST send, because afterwards the composer is already
        // docked at the bottom and stops moving. Clamping to the composer frame
        // makes a stale rect impossible to see: worst case the cover is briefly a
        // few px small, which reads as nothing.
        const frame = P.composerFrame && P.composerFrame();
        if (frame) {
          const fr = frame.getBoundingClientRect();
          // Only clamp to a frame that really wraps the cover target, so a provider
          // whose frame is narrower than its editor can never shrink the cover.
          const cx = r.left + r.width / 2;
          if (fr.width > 0 && fr.left <= cx && fr.right >= cx) {
            const left = Math.max(r.left, fr.left);
            const right = Math.min(r.right, fr.right);
            if (right - left > 40) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Optionally overshoot the editor box by PAD px on every side. Some
        // composers (Gemini's Quill) keep typed text near rounded corners, so a
        // cover sized EXACTLY to the editor leaves slivers of text peeking; those
        // providers set coverPad to bleed past the edges. A native <textarea>
        // (DeepSeek) needs none - overshooting there just makes the cover overflow
        // the composer, so it defaults to 0.
        const PAD = P.coverPad || 0;
        // Optional vertical nudge: some composers (Gemini's Quill) report an
        // editor rect that sits a few px below the visual input box centre, so
        // the centred "Agent is working…" text looks low. A provider can shift it.
        const OFFY = P.coverOffsetY || 0;
        // Height is at least MIN_H so the label is readable even over a
        // single-line composer. CENTER the cover on the editor's vertical middle
        // rather than anchoring its TOP to the editor top: a short (e.g. 20px)
        // textarea bumped to 36px would otherwise grow only DOWNWARD, leaving the
        // "Agent is working…" label sitting high in the composer's input band
        // (seen on Cloudflare's 1-line textarea). For a composer already taller
        // than MIN_H the maths reduces to the old `r.top - PAD`, so DeepSeek/Gemini
        // are unchanged.
        // Hard ceiling: even though .rs-typing caps the editor's visual height
        // (see overlay.css), belt-and-suspenders clamp the cover so a composer
        // whose growing element escapes that CSS cap on some provider can never
        // turn the "Agent is working…" cover into a full-page white slab.
        const MAXH = P.coverMaxH || 200;
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = (r.left - PAD) + "px";
        cover.style.top = (centerY - h / 2) + "px";
        cover.style.width = (r.width + PAD * 2) + "px";
        cover.style.height = h + "px";
        // Composite the surface BEHIND the cover target so the fill matches what
        // the user sees (a translucent composer card blends over the page).
        cover.style.background = opaqueBg(covNode);
        // When the cover blankets a whole composer card (coverTarget), match its
        // corner radius so the cover's square corners don't poke past the card's
        // rounded ones. Editor-sized covers keep the CSS default.
        if (P.coverTarget) cover.style.borderRadius = getComputedStyle(covNode).borderRadius;
        coverRaf = requestAnimationFrame(place);
      };
      place();
    }

    function toast(msg) {
      const t = document.createElement("div");
      t.className = "rs-toast";
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => t.classList.add("show"), 10);
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function banner(kind, title, msg) {
      const b = document.createElement("div");
      b.className = `rs-banner ${kind}`;
      b.innerHTML = `<div class="rs-banner-t"></div><div class="rs-banner-m"></div>
        <div class="rs-banner-acts">
          <button class="rs-banner-x">Close</button>
        </div>`;
      b.querySelector(".rs-banner-t").textContent = title;
      b.querySelector(".rs-banner-m").textContent = msg;
      b.querySelector(".rs-banner-x").addEventListener("click", () => b.remove());
      root.appendChild(b);
    }

    // Left-hand RobloxScript popup showing the latest screen_capture. Fed from the
    // in-memory base64 (a data: URL always renders), so it works identically on
    // every provider and never touches the site's DOM. Only the most recent
    // capture is kept - a new one replaces the old.
    function showImages(images, toolName) {
      root.querySelectorAll(".rs-shot").forEach((e) => e.remove());
      const wrap = document.createElement("div");
      wrap.className = "rs-shot";
      const hdr = document.createElement("div");
      hdr.className = "rs-shot-hdr";
      const ttl = document.createElement("span");
      ttl.className = "rs-shot-ttl";
      ttl.textContent = `${toolName} · ${images.length} image${images.length > 1 ?  "s" : ""}`;
      const close = document.createElement("button");
      close.className = "rs-shot-x";
      close.textContent = "✕";
      close.addEventListener("click", () => wrap.remove());
      hdr.appendChild(ttl);
      hdr.appendChild(close);
      wrap.appendChild(hdr);
      const body = document.createElement("div");
      body.className = "rs-shot-body";
      for (const img of images) {
        const el = document.createElement("img");
        el.className = "rs-shot-img";
        el.src = `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
        body.appendChild(el);
      }
      wrap.appendChild(body);
      root.appendChild(wrap);
    }

    build();
    return { setStatus, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup, getCustomPrompt, getCustomMcpServers, trackCard, hideCardEmbed, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
  })();

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ?  Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".rs-chip .rs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".rs-chip .rs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // RobloxScript's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  document.addEventListener("click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#rs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

let _prevHardGen = null, _prevSoftGen = null;
// Composer-unlock failsafe (v1.12.1, extended in v1.12.2): whatever code path
// leaked the "Agent is working…" cover, the readonly lock, a stuck A.starting
// bootstrap or a stuck A.injecting flag, the user must NEVER be left with a
// frozen composer. Throttled - the checks are cheap but the unlock touches
// provider DOM.
let _lastUnlockSweep = 0;
rsInterval(() => {
    // Failsafe FIRST so a stuck cover can never outlive its owner, even if
    // something below throws.
    if (Date.now() - _lastUnlockSweep > 2000) {
      _lastUnlockSweep = Date.now();
      // Idle: no loop/bootstrap/injection owns the input.
      if (!A.running && !A.starting && !A.injecting) {
        try { ui.inputCover(false); } catch {}
        try { P.setInputLock(false); } catch {}
      }
      // Stuck bootstrap: starting for >120s with no live stream is a wedged
      // startSession (exception outside its try, provider deadlock, a site
      // that ate the prompt). Force-abort it so Start becomes clickable again.
      // A healthy bootstrap NEVER takes this long without generating.
      if (A.starting && A._startingSince && Date.now() - A._startingSince > 120000) {
        try {
          A.startGen++;            // invalidates the in-flight bootstrap
          A.starting = false;
          A.startingKey = null;
          A._startingSince = 0;
          ui.setStarting(false);
          ui.inputCover(false);
          P.setInputLock(false);
          ui.banner("warn", "Start got stuck",
            "The startup didn't finish in 2 minutes and was reset. Try Start again — if it repeats, reload the page.");
          try { diag("start.staleAborted", {}); } catch {}
        } catch {}
      }
      // Stuck injecting: the 400ms post-send clear in submitAndGetBase's
      // finally should have run; >60s means an exception ate it.
      if (A.injecting && A._injectingSince && Date.now() - A._injectingSince > 60000) {
        A.injecting = false;
        try { diag("inject.staleCleared", {}); } catch {}
      }
    }
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #rs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".rs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live OR session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a RS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ?  P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    ui.showStop(A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating()));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "rsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ?  A.toolArg + " · " : "") + `${s}s`);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ?  P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && RSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = RSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "rsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
        return;
      }
    }
  }, 200);

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "rs-status") {
      ui.setStatus({ connected: msg.connected, mcpAlive: msg.mcpAlive, studio: msg.studio, studioApp: msg.studioApp, studioProc: msg.studioProc, robloxProc: msg.robloxProc, roblox_connected: msg.roblox_connected, engine: msg.engine, tools: msg.tools, servers: msg.servers, local_connected: msg.local_connected, local_full: msg.local_full, local_root: msg.local_root, blender: msg.blender, blender_shim: msg.blender_shim, blender_error: msg.blender_error, agent_version: msg.agent_version });
    }
    if (msg && msg.type === "rs-open-menu") {
      ui.openMenu(false); // from the popup's Settings button — opens at the top (Switch AI / custom prompt)
    }
  });

  // Status poll. An orphaned content script (see bg / isContextInvalidated) gets
  // a failure object back whose `connected` is undefined, which setStatus would
  // read as "the bridge just dropped" and answer with the red "run or-agent.exe"
  // banner - sending the user to fix a bridge that is perfectly healthy, with
  // the one thing that WOULD fix it (reload the page) never mentioned. Catch it
  // before setStatus, say the right thing, and stop polling: the context can
  // never come back, so every later tick would just repeat the same failure.
  let statusTimer = null;
  function onStatus(s) {
    if (!s) return;
    if (s.kind === "stale-extension") {
      if (statusTimer) statusTimer();
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: s.error });
      return;
    }
    ui.setStatus(s);
  }
  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  loadSysCount();
bg({ type: "status" }).then(onStatus);
statusTimer = rsInterval(() => bg({ type: "status" }).then(onStatus), 5000);

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ rsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("rsStartedSessions", (r) => {
      if (r && Array.isArray(r.rsStartedSessions)) {
        for (const p of r.rsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS an OR session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or an OR command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasRsSignal() {
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (txt.includes(RS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###LUA### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / rsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not OR's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "▶︎ Start OR agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    const path = P.conversationKey();
    const markerInDom = domHasRsSignal();
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("rs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("rs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("rs-hidden")) continue;
      const txt = P.classifyText(item, ".rs-chip");
      if (txt.includes(RS.SYS_MARKER) ||
          (P.isUserItem(item) && RSParse.isInjectedFeedback(txt))) {
        item.classList.add("rs-hidden");
      }
    }
  }
  const mo = new MutationObserver(() => {
    preHideWholeItems();
    scheduleSweep();
  });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Belt-and-braces: a low-frequency sweep regardless of tab visibility or
    // mutation timing, so camouflage always converges. Worker-backed so it also
    // converges while the user is on another site (background mode).
    rsInterval(scheduleSweep, 1500);
  // When the user returns to the tab, immediately refresh camouflage/state.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSweep(); });

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      bumpSys("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (enforceCondo("user-send")) return; if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ?  P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
const RESUME_FRESH_MS = 180000;
rsInterval(() => {
if (!A.started || A.running || A.starting || A.injecting) return;
if (document.hidden && !bgMode) return;              // parking mode: don't parse/exec off-screen (agentLoop gate
if (A.userStopped) return;                          // user halted → never relaunch
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ?  Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        RSParse.isInjectedFeedback(P.classifyText(after, ".rs-chip"))) return;
    const txt = P.itemText(item);
    if (!RSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!RSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }, 1000);

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (withSysResend) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
const SYS_FALLBACK_IDLE_MS = 20000;
rsInterval(async () => {
if (!sysResendDue()) return;
if (!A.started || A.running || A.starting || A.injecting) return;
if ((document.hidden && !bgMode) || A.userStopped) return;
    if (P.isGenerating()) return;
    // The user is composing - their draft owns the editor, leave it alone.
    try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
    // Give the cheap path a fair chance first: only step in once the turn has
    // been settled and quiet for a while with no tool result to ride on.
    if (Date.now() - A.lastGenAt < SYS_FALLBACK_IDLE_MS) return;
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    A.forceSysResend = false;
    diag("sys.resend", { via: "ownTurn", ...spent });
    try {
      const base = await submitAndGetBase(systemPrompt());
      await waitForResponse(base);
    } catch (e) {
      diag("sys.resendFailed", { err: String(e && e.message || e) });
    }
  }, 5000);

  log(`OR content script ready (provider: ${P.id})`);
})();
