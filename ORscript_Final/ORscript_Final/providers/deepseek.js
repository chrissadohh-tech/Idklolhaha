// SPDX-License-Identifier: GPL-3.0-or-later
// providers/deepseek.js - the DeepSeek (chat.deepseek.com) provider.
// EVERYTHING that knows DeepSeek's DOM, quirks, and UI strings lives here; the
// core (core/main.js) only ever talks to the RSProvider interface this file
// exports. To support another AI site, write a sibling file exporting the same
// interface and list it (instead of this one) in the manifest's content_scripts.
//
// DeepSeek notes (re-validated 2026-09 against the UNIFIED model UI):
//  - THE MODEL PICKER IS GONE. DeepSeek merged its old Instant / Expert / Vision
//    tabs into ONE unified model and removed the model selector from the
//    composer. There is no model tab to force, sync, latch, or detect any more:
//    every chat runs the unified model, which is multimodal (images and files
//    are auto-detected and read) and picks its own reasoning depth per prompt.
//    Historical conversations can still show an "Instant"/"Expert" badge, but
//    that is a per-conversation legacy label, NOT a selectable mode - ignore it,
//    and never gate anything (least of all screen_capture) on it.
//  - Because the unified model accepts images everywhere, supportsVision is a
//    plain `true` here (see the export at the bottom).
//  - One turn = one .ds-message. User turns carry a hashed modifier class +
//    a `.fbb737a4` bubble; assistant turns carry a `.ds-markdown` body.
//  - DeepThink/R1 reasoning lives in .ds-think-content; the real answer is a
//    .ds-markdown OUTSIDE that container (so drafts inside reasoning are ignored).
//  - The input is a real <textarea> (not a contenteditable): we set its value via
//    the native setter + an input event, then click the primary send button.
//  - "generating" is detected from the primary footer button: while streaming it
//    shows a STOP glyph (a <rect> in old builds, a rounded-square <path> starting
//    "M2…" in V4) and when idle a SEND arrow (<path> starting "M8…"); see
//    isStopBtn(). .ds-loading covers the brief spin-up. During the REASONING
//    phase there is NO stop button / spinner at all - only text growth
//    says "still alive".
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // DOM selectors for chat.deepseek.com. Grouped so a future site tweak is a
  // one-liner. DeepSeek ships hashed CSS-module class names (e.g. `d29f3d7d`);
  // where possible we lean on its stable design-system "ds-" classes instead.
  const S = {
    chatItem: ".ds-message, [data-message-id], [data-ds-message]",
    userMod: "d29f3d7d", // hashed modifier on user turns (one-liner to update if DeepSeek redeploys)
    userBubble: ".fbb737a4, [data-role='user']", // user text bubble (secondary signal)
    box: ".ds-markdown",
    editor: "textarea, [contenteditable='true']",
    // The inline "edit this message" box is DeepSeek's design-system bordered
    // textarea (.ds-textarea--bordered), mounted UP in the turn list. The bottom
    // composer is NOT wrapped in one - so this scopes getEditor() away from it.
    msgEditBox: ".ds-textarea",
    thinking: ".ds-think-content, .ds-think, [class*='ds-think']",
    markdown: ".ds-markdown",
    generating: ".ds-loading, [class*='ds-loading']",
    sendBtn: ".ds-button--primary, button[type='submit'], [aria-label*='Send' i], [aria-label*='发送']",
    stopBtn: ".ds-button--primary, [aria-label*='Stop' i], [aria-label*='停止']",
    // surfaces where DeepSeek shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    // composer file/image attachments. DeepSeek's upload UI uses fully hashed
    // classes (the old `.ds-file-list` / `[class*='thumbnail']` selectors matched
    // NOTHING), so we key off the pending preview IMAGE itself - see attachThumbs.
    attachArea: "[class*='file'], [class*='upload'], [class*='attach']",
    // ── Composer toggles (no model tabs any more - see the header) ─────────
    deepThinkToggle: ".ds-toggle-button",
  };

  // Error / state regexes (English + French - DeepSeek's UI follows the locale).
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "session.{0,20}(expired|expir\\u00e9e)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    deepThink: /pensée profonde|pensee profonde|profonde|réflexion|reflexion|deep ?think|深度思考|r1/i,
    searchMode: /recherche intelligente|smart search|search|web|搜索/i,
  };

  // Completion-detection windows, calibrated on DeepSeek's DeepThink behaviour.
  // Exposed so the core's response watcher uses the provider's tuning.
  const timings = {
    GEN_IDLE_MS: 800,        // answer phase: text unchanged this long ⇒ idle
    REASON_IDLE_MS: 12000,   // reasoning stalls of several seconds are NORMAL
    WARMUP_MS: 45000,        // empty turn container may precede the first token
    REASON_NOREPLY_MS: 90000, // reasoning written but no answer yet: keep waiting
    STABLE_MS: 9000,         // generating-flag stuck ON but text frozen → done
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification (multi-signal, virtualization-safe) ──────────────
  function isUserItem(item) {
    if (!item) return false;
    const role = (item.getAttribute("data-role") || item.getAttribute("data-author") ||
                  item.getAttribute("data-message-author-role") || "").toLowerCase();
    if (role === "user" || role === "human") return true;
    if (role === "assistant" || role === "ai" || role === "model") return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (item.querySelector && (item.querySelector(S.markdown) || item.querySelector(S.thinking) || item.querySelector(S.generating))) return false;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    const cls = String(item.className || "");
    if (/\buser\b/i.test(cls) && !/assistant|model/i.test(cls)) return true;
    // New DeepSeek UI dropped hashed user classes. Right-hugging bubbles are user turns.
    try {
      const r = item.getBoundingClientRect();
      const p = (item.parentElement || item).getBoundingClientRect();
      if (r.width > 8 && p.width > r.width + 24) {
        const leftGap = r.left - p.left;
        const rightGap = p.right - r.right;
        if (leftGap > rightGap + 20) return true;
      }
    } catch {}
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // Text of an item for signature detection. For assistant turns we use ONLY
  // the non-thinking markdown, so tool blocks the model merely drafts inside
  // its reasoning are never detected, shown, or executed.
  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  // Text used by the core to CLASSIFY a turn for camouflage - excludes the
  // reasoning area AND any element matching `excludeSel` (the core's own chip),
  // so a recycled (virtualized) node wearing a stale chip is never mis-detected.
  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => {
    const rootSkip = (n) => n && !n.closest("#rs-root");
    let nodes = [...document.querySelectorAll(".ds-message")].filter(rootSkip);
    if (nodes.length) return nodes;
    return [...document.querySelectorAll(S.chatItem)].filter(rootSkip);
  };
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  // Scope to the SITE's composer only: never match OR's own injected
  // UI (e.g. the settings textarea #rs-set-text in #rs-root). Otherwise on the
  // login/OAuth pages - which have no site textarea - getEditor() would return
  // our own panel's textarea, defeating the "not on a chat page" guard in the
  // send hooks and letting them swallow the DeepSeek "Log in" click (which is
  // itself a .ds-button--primary, the same selector as the send button).
  const getEditor = () => {
    const site = [...document.querySelectorAll(S.editor)].filter(
      (e) => !e.closest("#rs-root") && e.offsetParent !== null
    );
    // Prefer the bottom composer over the inline message-EDIT box. When the user
    // edits a turn, DeepSeek mounts a bordered .ds-textarea up in the turn list;
    // it precedes the composer in DOM order, so the old "first textarea" pick
    // returned it - and barMount() then dragged the whole OR bar INTO the
    // editor. Skip any textarea inside that DS component; the composer isn't one.
    const ta = site.find((e) => e.tagName === "TEXTAREA" && !e.closest(S.msgEditBox));
    if (ta) return ta;
    const ce = site.find((e) => e.getAttribute("contenteditable") === "true" &&
      !e.closest(S.chatItem) && !e.closest(S.msgEditBox));
    return ce || site.find((e) => !e.closest(S.msgEditBox)) || site[0] || null;
  };
  // Composer may be a <textarea> (classic) or contenteditable (2026 UI).
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    if (e.tagName === "TEXTAREA" || e.tagName === "INPUT") return e.value || "";
    return (e.innerText || e.textContent || "");
  };

  function getSendBtn() {
    const sel = S.sendBtn + ", " + S.stopBtn + ", button.ds-icon-button";
    const cand = [...document.querySelectorAll(sel)].filter((b) =>
      b.offsetParent !== null && !b.closest("#rs-root") && !b.closest(".ds-message"));
    if (!cand.length) return document.querySelector(".ds-button--primary");
    const ed = getEditor();
    if (!ed) return cand[0];
    const er = ed.getBoundingClientRect();
    cand.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const da = Math.abs(ar.top - er.bottom) + Math.abs(ar.left - er.right);
      const db = Math.abs(br.top - er.bottom) + Math.abs(br.left - er.right);
      return da - db;
    });
    return cand[0];
  }

  // Lock / unlock the user textarea during agent activity. `readonly` blocks
  // interactive typing but is IGNORED by the native prototype setter used in
  // setTextareaValue(), so the loop's own injections continue to work normally.
  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.rsPlaceholder) ed.dataset.rsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
      if (ed.getAttribute("contenteditable") === "true") ed.setAttribute("contenteditable", "false");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.rsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rsPlaceholder);
      if (ed.tagName !== "TEXTAREA" && ed.tagName !== "INPUT") ed.setAttribute("contenteditable", "true");
    }
  }

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-turn identity: each .ds-message's PARENT carries
  // data-virtual-list-item-key, a monotonically increasing per-turn key
  // (validated live, 2026-07). DeepSeek VIRTUALIZES its message list (the
  // attribute name says it all), so assistantCount() stalls once old turns
  // detach - which defeated the core's count-based chip.reown guard on
  // back-to-back calls to the same tool: the previous call's settled "done"
  // chip was repainted onto the NEW streaming command turn (the "chip appears
  // done with no spinner while DeepSeek is still writing" report). This key is
  // immune to that; the core prefers it over the count whenever it exists.
  function lastAssistantId() {
    const last = lastAssistant();
    return itemKey(last);
  }

  // Stable per-turn identity for ANY item (not just the last). Same source as
  // lastAssistantId - the parent's data-virtual-list-item-key - so the core can
  // key its off-DOM dedupe maps (executed / halted) on an id that survives
  // virtualization. The positional assistantIdx it falls back to is NOT stable
  // once old turns detach: scrolling up renders a different window, so an old
  // command turn takes a low index that collides with a current turn's key and
  // the "already ran this" memory misses - the watchdog then re-fires the
  // scrolled-back tool ("commands re-execute when I scroll up" report).
  function itemKey(item) {
    if (!item) return null;
    const p = item.parentElement;
    const key = (p && p.getAttribute("data-virtual-list-item-key")) ||
      item.getAttribute("data-virtual-list-item-key") ||
      item.getAttribute("data-message-id") ||
      item.getAttribute("data-id") ||
      (p && (p.getAttribute("data-message-id") || p.getAttribute("data-id")));
    return key != null && String(key) !== "" ? String(key) : null;
  }

  // A "blank" conversation = no chat turns rendered yet.
  const chatIsEmpty = () => allItems().length === 0;

  // A genuinely FRESH/new chat (not an existing conversation whose messages are
  // still loading). Kept as a distinct helper because the Start gate and the
  // send hooks both treat a blank chat differently from a populated one.
  const isFreshChat = () => chatIsEmpty();

  // The whole composer "box" = the smallest ancestor that contains the input and
  // the send button. The core's Start gate hides this entire frame at once.
  // (Pre-2026-09 this also had to cover the Instant/Expert/Vision radio group;
  // that selector is gone with the unified model - see the header.)
  // Returns null if no input yet.
  function composerFrame() {
    const ta = getEditor();
    if (!ta) return null;
    const sb = getSendBtn();
    const targets = [sb].filter(Boolean);
    let n = ta;
    for (let i = 0; i < 14 && n && n.parentElement; i++) {
      if (targets.every((t) => n.contains(t))) return n;
      n = n.parentElement;
    }
    // Fallback: a fixed climb from the textarea.
    let f = ta;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  // Bar sits *above* the input box, not inside where you type.
  // The INPUT BOX = the lowest ancestor of the textarea that also holds the send
  // button (the rounded composer card; pre-2026-09 this check also excluded the
  // model tabs, which the unified model removed). Putting the bar
  // inside it as first child made it cover the input padding and bleed into the
  // typing area. Instead anchor it right before the card in its parent, so it is
  // a clean header above the box — consistent with copilot/crax.
  // DeepSeek's React reconciles the input card; inserting #rs-bar inside it
  // risks a diff reuse. Use anchored mode — bar hugs the composer's top
  // edge from outside the DOM tree.
  // DeepSeek is React-managed: any node we insert into the composer subtree
  // gets fought over on every re-render (flicker/overlap). So use ANCHORED
  // mode — the bar lives in our own #rs-root (position:fixed) and hugs the
  // rounded chatbox's top edge from outside the DOM tree. React never sees it.
  function barAnchor() {
    const ta = getEditor();
    if (!ta) return null;
    for (let n = ta.parentElement, i = 0; n && n !== document.body && i < 8; i++, n = n.parentElement) {
      try {
        const r = parseFloat(getComputedStyle(n).borderTopLeftRadius) || 0;
        if (r >= 12) return n;
      } catch {}
    }
    return ta.closest("form") || ta.parentElement;
  }

  // ── Composer toggles: search OFF, legacy DeepThink ON ────────────────────
  // There is NO model tab to drive any more: DeepSeek merged Instant / Expert /
  // Vision into one unified model and deleted the composer's model picker (see
  // the header). The only composer work left is best-effort housekeeping:
  //   • Smart Search must be OFF - it derails the agent by injecting web pages
  //     into the context.
  //   • A legacy DeepThink/R1 toggle, if this build still renders one, goes ON.
  // Both are optional: a build without those toggles is perfectly sendable.
  const nodeText = (n) => (n && (n.innerText || n.textContent || "").trim()) || "";
  const isPressedOn = (n) =>
    n && (n.getAttribute("aria-pressed") === "true" ||
          n.getAttribute("aria-checked") === "true" ||
          n.classList.contains("ds-toggle-button--selected"));
  const isPressedOff = (n) =>
    n && (n.getAttribute("aria-pressed") === "false" ||
          n.getAttribute("aria-checked") === "false");

  function findToggleBy(re) {
    return [...document.querySelectorAll(S.deepThinkToggle)].find((t) => re.test(nodeText(t))) || null;
  }

  // READ-ONLY state probe (no clicks). Kept for diagnostics + the ready loop.
  function composerModeState() {
    const deepThink = findToggleBy(RE.deepThink);
    const search = findToggleBy(RE.searchMode);
    return {
      deepThinkFound: !!deepThink,
      deepThinkOn: !!deepThink && isPressedOn(deepThink),
      searchFound: !!search,
      searchOff: !search || !isPressedOn(search),
    };
  }

  function enforceComposer(reason) {
    // We only DRIVE the composer when given a reason (i.e. at session startup).
    // Per-sweep calls pass no reason and are READ-ONLY: that leaves the user in
    // full control of their composer afterwards, with no per-frame click wars.
    if (!reason) return composerModeState();
    try {
      // Legacy DeepSeek UI only: if a separate DeepThink toggle still exists, turn
      // it ON once. We do NOT hide it anymore, so thinking stays user-toggleable.
      const deepThink = findToggleBy(RE.deepThink);
      if (deepThink && isPressedOff(deepThink)) {
        try { deepThink.click(); } catch (e) { diag("mode_fallback", { reason, target: "deepThink", error: String(e && e.message || e) }); }
      }

      // Search must be off (it derails the agent). Best-effort; absent in some builds.
      const search = findToggleBy(RE.searchMode);
      if (search && isPressedOn(search)) {
        try { search.click(); } catch (e) { diag("mode_fallback", { reason, target: "search", error: String(e && e.message || e) }); }
      }

      const state = composerModeState();
      diag("mode_enforce", { reason, ...state });
      return state;
    } catch (e) {
      diag("mode_fallback", { reason, target: "composer", error: String(e && e.message || e) });
      return composerModeState();
    }
  }

  // Drive the composer's best-effort toggles and wait for the chat box to appear.
  // Returns the final state with `.ready` (the core gates session start on it).
  // NOTE: "ready" is ONLY about the composer existing. It must never depend on a
  // model name or tab - the unified model is always the right model.
  async function ensureComposerReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 12; i++) {
      state = enforceComposer(reason);
      if (getEditor() && state.searchOff && (state.deepThinkOn || !state.deepThinkFound)) break;
      await sleep(120);
    }
    state = composerModeState();
    diag("mode_ready", { reason, ...state });
    // Search/DeepThink are best-effort, so a missing composer is the only real
    // "not ready". (main.js shows its own "chat box not found" banner then.)
    const ready = !!getEditor();
    return { ...state, ready };
  }

  // DeepSeek's footer button doubles as SEND (an upward arrow) and STOP (a
  // filled rounded square). Older builds drew the stop glyph with a <rect>; the
  // current V4 build draws BOTH as a <path>: the send arrow's path starts
  // mid-glyph ("M8.31…"), the stop square's path starts at a corner near the
  // origin ("M2 …"). We treat the button as "stop" when it carries a <rect> OR a
  // square-ish path (leading move to x ≤ 3) - never the M8 arrow. One-liner to
  // update if DeepSeek reskins the footer button.
  function isStopBtn(btn) {
    if (!btn) return false;
    const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.innerText || "").trim();
    if (/stop|停止|暂停|arr[eê]t/i.test(label) && !/send|发送/i.test(label)) return true;
    if (btn.querySelector("rect")) return true; // legacy stop square
    const p = btn.querySelector("path");
    if (!p) return false;
    return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "");
  }

  // ── Generation / completion detection ────────────────────────────────────
  // Everything DeepSeek is streaming for a turn: its reasoning + its answer.
  // Excludes the core's own chip so the live token meter can't masquerade as
  // model output.
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? think.textContent || "" : "";
    const replyTxt = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".rs-chip"))
      .map((m) => m.textContent)
      .join("");
    return thinkTxt + "\n" + replyTxt;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  // Stream-growth tracking - the ONLY "is it still streaming?" signal during the
  // reasoning phase (no <rect>, no spinner then). We track the MAXIMUM length the
  // current turn has reached and WHEN it last advanced; DOM flicker of a few
  // chars never counts - only a new maximum (see content history for the full
  // war story: counting churn as growth froze the loop).
  let _streamMax = -1, _streamAt = 0, _streamItem = null;

  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    // A new turn - a different node, or a big length drop (a virtualized node
    // recycled into a fresh turn) - starts tracking afresh and counts as active.
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; } // forward progress only
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  // True iff `item` is an assistant turn that has begun REASONING but produced no
  // answer yet and has NOT been halted.
  function reasoningInProgress(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    if (!thinkTxt.trim().length) return false; // not reasoning
    const replyLen = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".rs-chip"))
      .reduce((n, m) => n + (m.textContent || "").length, 0);
    if (replyLen !== 0) return false; // already answering
    if (turnHalted(item)) return false; // halted (manual / forced stop)
    return true;
  }

  // The turn carries DeepSeek's "Arrêté/Stopped" UI marker (manual stop or a
  // forced interruption) - distinguished from the model merely WRITING such a
  // word in its reasoning by requiring the marker OUTSIDE the reasoning text.
  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return RE.stopped.test(item.textContent || "") && !RE.stopped.test(thinkTxt);
  }

  // Growth-tolerant "is a generation in progress?" - the response watcher's signal.
  function isGenerating() {
    if (document.querySelector(S.generating)) return true; // spin-up spinner
    const btn = getSendBtn();
    if (isStopBtn(btn)) return true;                       // answer phase: stop square
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(timings.REASON_IDLE_MS);
    return grewWithin(timings.GEN_IDLE_MS);
  }

  // STRICT "is a generation happening RIGHT NOW?" - the gate for SENDING (the send
  // button doubles as stop, so sending mid-generation aborts the turn). Does NOT
  // linger after the answer ends.
  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = getSendBtn();
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false; // answer present / stopped → free
    return grewWithin(timings.REASON_IDLE_MS); // reasoning: live only while it keeps growing
  }

  // HARD signal only (the visible stop-square): never true just because a
  // conversation (re)loads or the user scrolls. Used for the Stop button.
  function isHardGenerating() {
    return isStopBtn(getSendBtn());
  }

  // ── Diagnostic breakdown of isGenerating() ────────────────────────────────
  // The chip "settled ✓ done while DeepSeek was still writing" bug means
  // isGenerating() flickered false at the wrong moment. This exposes EACH
  // sub-signal so the core's chip.why tracker can show WHICH one failed:
  //  - spinner  : the .ds-loading spin-up flag
  //  - stopBtn  : the footer button is in its STOP-square state (answer phase)
  //  - btnGlyph : the raw first token of the button's <path d> (to catch a
  //               DeepSeek reskin that breaks isStopBtn's M[0-3] test)
  //  - reasoning: DeepThink reasoning is in progress (no stop button then)
  //  - streamMax/streamAgeMs : stream-growth meter (the ONLY liveness signal in
  //               the reasoning phase, and the fallback when stopBtn is false)
  //  - grewGen/grewReason    : did the stream grow within the answer / reasoning
  //               idle windows (what isGenerating actually gates on)
  function genDebug() {
    try {
      sampleStream();
      const btn = getSendBtn();
      const path = btn && btn.querySelector("path");
      const rp = btn && btn.querySelector("rect");
      return {
        spinner: !!document.querySelector(S.generating),
        stopBtn: isStopBtn(btn),
        btnGlyph: rp ? "rect" : (path ? (path.getAttribute("d") || "").slice(0, 6) : "none"),
        reasoning: reasoningInProgress(lastAssistant()),
        streamMax: _streamMax,
        streamAgeMs: _streamAt ? Date.now() - _streamAt : -1,
        grewGen: grewWithin(timings.GEN_IDLE_MS),
        grewReason: grewWithin(timings.REASON_IDLE_MS),
        gen: isGenerating(),
      };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }

  // Lightweight turn snapshot for diagnostics (reasoning/reply lengths).
  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".rs-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp };
    } catch { return {}; }
  }

  // ── Truncation "Continue" button ──────────────────────────────────────────
  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue; // not visible
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const th = item.querySelector(`${S.thinking} ${S.markdown}`);
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: th ? th.textContent.trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // DeepSeek's composer is a <textarea> driven by React. We must set .value via
  // the native prototype setter so React's onChange fires, then dispatch an input
  // event, then click the primary send button (Enter inserts a newline).
  function setTextareaValue(el, v) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, v);
    } catch {
      el.textContent = v;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
    }
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  // Click DeepSeek's primary footer button to send. Send arrow and stop square
  // are the SAME button, so we refuse to click whenever a generation is live.
  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = getSendBtn();
    if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  // DeepSeek's composer accepts unbounded text at the DOM level (no maxlength),
  // but a JS guard blocks the SEND past 163840 characters (= 160 KiB, validated
  // live 2026-07-22): the send button is swallowed and a toast "Content is too
  // long (N%)" appears (N = excess percentage, NOT a char count). A large tool
  // result (big http_get / get_page_text / luau dump) would then silently wedge
  // the loop in the input box. Truncate outgoing text to a prudent margin below
  // the cap, keeping the head AND tail so neither the start nor the end of a
  // result is lost, and mark the gap so the model knows content was dropped and
  // does not retry the whole call. DeepSeek-only cap; other providers keep their
  // own. Same head+tail approach as qwen.js / arena.js.
  const SEND_CAP = 163840;   // composer send-guard limit
  const SEND_MAX = 160000;   // prudent margin below the cap (+ room for the marker)
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[…OR: result truncated to fit DeepSeek's ${SEND_CAP}-character ` +
      `input limit - ${omitted} of ${text.length} characters omitted. Do NOT re-run ` +
      `the command; work with the head and tail shown here…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("DeepSeek input box not found");
    editor.focus();
    text = truncateForSend(text);
    setTextareaValue(editor, text);
    // Attach images LAST, right before the send click - see gemini.js's
    // typeAndSend for why (attaching before retyping the text can sever the
    // site's binding between the pending upload and the message being sent).
    const hasImages = !!(images && images.length);
    if (hasImages) {
      try { await attachImages(images); } catch {}
      // DeepSeek REFUSES the send until the attachment finishes uploading, and its
      // upload spinner (.ds-loading) is NOT a reliable "done" signal - it lingers on
      // the thumbnail and isBusyNow() counts it as "busy", which is what wedged the
      // send. So don't gate on the spinner: POLL - click the send ARROW (guarded on
      // !isStopBtn so we never hit the stop square) and confirm the composer
      // cleared; retry until the upload completes and DeepSeek accepts the send, or
      // we time out. Self-correcting, with no dependency on the exact upload-done
      // DOM node (the file-input path in attachImages does the real upload).
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const btn = getSendBtn();
        if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
          try { btn.click(); } catch {}
        }
        // Editor cleared = the message left; stop square up = generation started.
        if (await waitFor(() => editorText().trim() === "" || isHardGenerating(), 1200)) return;
      }
      return;
    }
    // Text-only: wait for React to re-enable the send button, then click.
    await waitFor(() => {
      const btn = getSendBtn();
      return btn && btn.getAttribute("aria-disabled") !== "true" && !isStopBtn(btn);
    }, 800);
    if (!clickSendButton() && !isBusyNow()) {
      pressEnter(editor);
    }
  }

  // Click DeepSeek's stop only if it is actually in the stop state (<rect>), so
  // we never accidentally re-trigger a send.
  function stopGeneration() {
    const b = getSendBtn();
    if (isStopBtn(b)) try { b.click(); } catch {}
  }

  // ── Error / limit detection (site chrome only, never model output) ───────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.chatItem)) continue; // inside a chat turn ⇒ model content, not UI
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  // Short SYSTEM-message shapes the site renders as an assistant reply.
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (Studio captures → composer) ────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `robloxscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }

  // Staged composer attachments. DeepSeek's file-list uses fully HASHED classes
  // (validated live 2026-07-21: the old `.ds-file-list`/`[class*=thumbnail]`
  // selectors matched NOTHING), so key off the preview IMAGE itself: a pending
  // upload is an `<img src="blob:...">` that is NOT inside a chat message
  // (history/sent images use CDN urls in `.ds-message` turns). This is the signal
  // the idempotency + paste-vs-fileinput dedup depend on; with the stale selector
  // both were inert and one capture re-attached ~20x (seen live), wedging the
  // uploads and the send.
  const attachThumbs = () => {
    try {
      return [...document.querySelectorAll("img")].filter(
        (im) => !im.closest(S.chatItem) &&
          // blob: = pending local preview; the alt (our "robloxscript_..." filename)
          // survives once the upload replaces the blob src with a CDN url, so the
          // idempotency/presence checks keep matching after upload completes.
          (/^blob:/.test(im.getAttribute("src") || "") || /^robloxscript_/.test(im.getAttribute("alt") || "")));
    } catch { return []; }
  };

  // Remove any pending attachments from the composer (used to clean up a
  // failed upload so the feedback message still sends as clean text).
  function clearAttachments() {
    try {
      document.querySelectorAll(`${S.attachArea} [class*='delete'], ${S.attachArea} [class*='close'], ${S.attachArea} [class*='remove']`)
        .forEach((d) => ["mouseover", "mousedown", "mouseup", "click"]
          .forEach((t) => { try { d.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch {} }));
    } catch {}
  }

  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    // IDEMPOTENCY: submitAndGetBase retries typeAndSend up to 4x, reusing the same
    // images; without this guard each retry re-attached, stacking duplicate
    // thumbnails (the "doublot" - two identical previews - that then wedged the
    // send). If anything is already staged, treat the attach as done.
    if (attachThumbs().length > 0) return true;
    const want = images.length;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    // Use the hidden <input type=file> as the PRIMARY path: it triggers DeepSeek's
    // REAL upload (POST /api/v0/file/upload_file → the thumbnail's spinner clears
    // and the send is allowed). A synthetic PASTE only creates a LOCAL blob preview
    // and NEVER uploads (validated live: no upload_file request, `.ds-loading`
    // spinner stuck forever, DeepSeek refuses the send) - so paste is only a
    // last-resort fallback when no file input exists.
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    } else {
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    // A thumbnail appearing is our success signal.
    return await waitFor(() => attachThumbs().length >= want, 15000);
  }

  // Stable identity of the current conversation (used to persist "started").
  // The root path = a fresh chat with no id yet → "" (transient, never persisted).
  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // ── User-send interception ────────────────────────────────────────────────
  // The core supplies callbacks; this provider wires them to DeepSeek's
  // composer events (Enter key, send-button click, native stop / continue).
  // handlers = {
  //   isBlocked():bool        - agent busy (injecting/running/starting)
  //   isStarted():bool        - a OR session exists in this chat
  //   onBlockedAttempt()      - user tried to send before starting (fresh chat)
  //   onUserMessage(base)     - a genuine user message is being sent
  //   onNativeStop()          - user clicked the site's own stop button
  //   onNativeContinue()      - user clicked the site's truncation Continue
  // }
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        const text = editorText().trim();
        if (text === "") return;

        if (handlers.isBlocked()) return;

        // No session yet → the user must click "Start session" first. ONLY on a
        // blank chat: an existing conversation isn't ours to gate.
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → let the site handle it
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }

        handlers.onUserMessage(assistantCount());
      },
      true
    );

    // Users also send by CLICKING the send button - handle that path too.
    document.addEventListener(
      "click",
      (e) => {
        // Not on a chat page (e.g. login / OAuth page) - never intercept anything.
        if (!getEditor()) return;
        const t = e.target;
        // The native "Continue" button = a clear intent to RESUME after a stop.
        const cont = t && t.closest && t.closest(".ds-button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        // DeepSeek's stop button shares the send button's spot (square = stop).
        if (isStopBtn(btn)) {
          handlers.onNativeStop();
          return;
        }
        if (btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Hide the raw tool call so nothing of it leaks beside the core's chip.
  // DeepSeek markdown often SPLITS a ###LUA### … ###END_LUA### block across
  // several <p> paragraphs, so we hide the whole CONTIGUOUS RUN of block-level
  // children from the start marker through the end marker. Returns where to
  // insert the chip: {parent, ref} - or null if no tool block was found.
  function findToolBlockSpot(item, chip) {
    const P = RSParse;
    const hasStart = (t) => P.LUA_START_RE.test(t) || t.includes("###mcp_tool###");
    const hasEnd = (t) => P.LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
    const isJson = (t) => /\{\s*"(?:command|tool)"\s*:/.test(t);
    // The reply markdown containers (never the reasoning/think area).
    const containers = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    if (!containers.length) return null;
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children].filter((k) => k !== chip && !(chip && k.contains(chip)));
      let i = 0;
      while (i < kids.length) {
        const txt = (kids[i].textContent || "");
        const tLow = txt.toLowerCase();
        const startsBlock = hasStart(tLow);
        if (!startsBlock && !isJson(txt)) { i++; continue; }
        // Found the start of a tool block. Hide this child…
        const runStart = i;
        let runEnd = i;
        if (startsBlock && !hasEnd(tLow)) {
          // multi-element LUA/MCP block → extend until the end marker (or, if the
          // turn is still truncated, to the end of this container).
          let j = i + 1;
          runEnd = kids.length - 1;
          for (; j < kids.length; j++) {
            if (hasEnd((kids[j].textContent || "").toLowerCase())) { runEnd = j; break; }
          }
        }
        for (let k = runStart; k <= runEnd; k++) {
          // Prefer hiding the whole code-block wrapper (language label / Copy bar).
          let hide = kids[k];
          const wrap = hide.closest("[class*='code'], .md-code-block");
          if (wrap && container.contains(wrap) && wrap !== container) hide = wrap;
          hide.classList.add("rs-tool-hide");
          if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
        }
        i = runEnd + 1;
      }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: "deepseek",
    displayName: "DeepSeek",
    // UNCONDITIONAL true. DeepSeek's unified model (2026-09) is multimodal: it
    // reads images - and files - in every chat, with no Vision tab to select.
    // This lets main.js allow screen_capture on DeepSeek and stop turning
    // returned images into errors. (Before the merge this was a getter that read
    // the Instant/Expert/Vision tab; that tab no longer exists.)
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible
    // probes can exclude it: DeepSeek QUOTES the command JSON/###LUA### inside
    // its thinking, which the camouflage never hides (by design) - without
    // this exclusion those quotes read as "raw block still visible" forever
    // (seen live: 60Hz chip rebuild spam + done→run→done chip flapping).
    thinkingSel: S.thinking,
    init({ diag: d } = {}) {
      if (d) diag = d;
      // Version beacon: stamp the loaded build onto <html> so a reload can be
      // confirmed from the page (read document.documentElement.dataset.rsDsVer).
      // BUMP DS_VER on meaningful deepseek.js changes worth verifying live.
      // 2026-09_unified = Instant/Expert/Vision merged + picker removed.
      try { document.documentElement.setAttribute("data-rs-ds-ver", "2026-09_unified"); } catch {}
    },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();



