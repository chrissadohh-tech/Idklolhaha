// SPDX-License-Identifier: GPL-3.0-or-later
// providers/ollama.js — Ollama (open-source Claude Code alternative) provider.
// Covers Open WebUI (http://localhost:3000, http://localhost:8080) and
// Ollama's own web chat (http://localhost:11434) + https://ollama.com.
// Everything Open WebUI / Ollama DOM-specific lives here; core only talks to RSProvider.
//
// Validated against Open WebUI 0.5.x (Svelte) — structure is similar to ChatGPT's:
// - Composer: <textarea id="chat-input" placeholder="Send a message…"> or
//   <textarea placeholder="Ask anything"> inside <form>
// - Messages: [data-message-id] or .message or [class*="chat-message"] with
//   markdown inside .markdown, [class*="prose"], or [class*="markdown"]
// - Send: button[type="submit"] with aria-label Send, Stop during generation
// eslint-disable-next-line no-unused-vars
const RSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    editor: [
      'textarea#chat-input',
      'textarea[placeholder*="Send a message"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="Message Ollama"]',
      'form textarea',
      '[data-testid="chat-input"]',
      'textarea',
      '[contenteditable="true"]',
    ].join(", "),
    composerFrame: [
      'form',
      '[class*="chat-input"]',
      '[class*="composer"]',
      '[data-testid="composer"]',
    ].join(", "),
    sendBtn: [
      'button[type="submit"]',
      'button[aria-label*="Send"]',
      'button[data-testid="send-button"]',
      'form button:not([aria-label*="Stop"])',
    ].join(", "),
    stopBtn: [
      'button[aria-label*="Stop"]',
      'button[data-testid="stop-button"]',
      'form button[aria-label*="Stop generating"]',
    ].join(", "),
    chatItem: [
      '[data-message-id]',
      '[data-testid="message"]',
      '[class*="chat-message"]',
      '[class*="message-"]',
      '.message',
      '[class*="conversation"] > div',
      'div[class*="group"]',
    ].join(", "),
    markdown: [
      '.markdown',
      '[class*="markdown"]',
      '[class*="prose"]',
      '.message-content',
      '[data-message-content]',
    ].join(", "),
    generating: [
      '[aria-busy="true"]',
      '[data-generating="true"]',
      '.generating',
      '[class*="typing"]',
      '[class*="loading"]',
    ].join(", "),
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"]',
  };

  const RE = {
    contextLimit: /(context|token).{0,10}limit|conversation.*too long/i,
    tooLong: /too long/i,
    busy: /busy|rate limit|overloaded/i,
    continueBtn: /^(continue|resume|keep going)$/i,
    stopped: /(stopped|halted|interrupted)/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function visible(el) {
    if (!el) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      return true;
    } catch { return !!el; }
  }
  function isVisibleForClick(el) {
    if (!el) return false;
    if (el.disabled || el.getAttribute("aria-disabled")==="true") return false;
    try { const r=el.getBoundingClientRect(); return r.width>2 && r.height>2; } catch { return el.offsetParent!==null; }
  }

  function isUserItem(item) {
    if (!item) return false;
    const role = item.getAttribute && (item.getAttribute("data-role") || item.getAttribute("data-message-author-role") || item.getAttribute("data-testid"));
    if (role && /user/i.test(role)) return true;
    if (item.dataset && item.dataset.role==="user") return true;
    if (item.classList && item.classList.contains("user")) return true;
    // Open WebUI marks user messages with different bg
    if (item.querySelector && item.querySelector('[class*="user"]')) return false; // not reliable
    return false;
  }
  function isAssistantItem(item) { return !!item && !isUserItem(item); }

  function itemText(item) {
    if (!item) return "";
    const mds = item.querySelectorAll(S.markdown);
    if (mds.length) return [...mds].map(m=>m.textContent).join("\n").trim();
    return (item.textContent||"").trim();
  }
  function classifyText(item, excludeSel) {
    if (!item) return "";
    const mds = [...item.querySelectorAll(S.markdown)];
    if (mds.length) return mds.filter(m=> !(excludeSel && m.closest(excludeSel))).map(m=>m.textContent).join("\n");
    let t="";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType===1 && n.matches && n.matches(excludeSel)) continue;
      t+= n.textContent||"";
    }
    return t;
  }

  function allItems() {
    let items=[...document.querySelectorAll(S.chatItem)];
    items=items.filter(el=> !el.closest("#rs-root") && (el.textContent||"").trim().length>0);
    if (items.length>1) {
      const filtered=[];
      for (const el of items) if (!filtered.some(p=>p.contains(el))) filtered.push(el);
      items=filtered;
    }
    if (items.length===0) {
      const heu=[...document.querySelectorAll('[class*="prose"]')].map(el=> el.closest('[class*="message"]')||el).filter(el=> el && !el.closest("#rs-root"));
      if (heu.length) items=heu;
    }
    return items;
  }
  const assistantItems = ()=> allItems().filter(isAssistantItem);
  const assistantCount = ()=> assistantItems().length;
  const userCount = ()=> allItems().filter(isUserItem).length;

  function getEditor() {
    for (const sel of S.editor.split(", ")) {
      try { for (const e of document.querySelectorAll(sel)) if (!e.closest("#rs-root")) return e; } catch {}
    }
    for (const e of document.querySelectorAll('textarea, [contenteditable="true"]')) if (!e.closest("#rs-root")) return e;
    return null;
  }
  const editorText = ()=> {
    const e=getEditor(); if(!e) return "";
    if (e.value!=null) return e.value;
    return e.textContent||"";
  };
  function setInputLock(on) {
    const ed=getEditor(); if(!ed) return;
    if(on){ if(!ed.dataset.rsPlaceholder) ed.dataset.rsPlaceholder = ed.getAttribute("placeholder")||""; ed.setAttribute("readonly",""); ed.setAttribute("placeholder","⏳ Agent working…"); }
    else { ed.removeAttribute("readonly"); if(ed.dataset.rsPlaceholder!=null) ed.setAttribute("placeholder", ed.dataset.rsPlaceholder); }
  }
  const lastAssistant = ()=> { const it=assistantItems(); return it.length?it[it.length-1]:null; };
  const _idMap=new WeakMap(); let _idSeq=0;
  function itemKey(item){ if(!item) return null; const did=item.getAttribute && (item.getAttribute("data-message-id")||item.getAttribute("id")); if(did) return did; let id=_idMap.get(item); if(!id){id="rs-"+(++_idSeq); _idMap.set(item,id);} return id; }
  function lastAssistantId(){ return itemKey(lastAssistant()); }
  const chatIsEmpty = ()=> allItems().length===0;
  const isFreshChat = ()=> chatIsEmpty() && !!getEditor();

  function composerFrame(){
    const ta=getEditor(); if(!ta) return null;
    for(const sel of S.composerFrame.split(", ")){ try{ const f=ta.closest(sel); if(f) return f; }catch{} }
    let n=ta; for(let i=0;i<10&&n&&n.parentElement;i++){ if(n.tagName==="FORM") return n; n=n.parentElement; }
    let f=ta; for(let i=0;i<6&&f.parentElement;i++) f=f.parentElement; return f;
  }
  function barAnchor(){
    const ta=getEditor(); if(!ta) return null;
    // Open WebUI's composer is inside a form; use its container
    return ta.closest('form') || ta.closest('[class*="input"]') || ta.parentElement;
  }

  function enforceComposer(reason){ return { ready: true }; }
  async function ensureComposerReady(reason){
    diag("ollama.mode_ready", {reason, hasEditor: !!getEditor()});
    return { ready: !!getEditor() };
  }

  function streamText(item){
    if(!item) return "";
    const mds=item.querySelectorAll(S.markdown);
    if(mds.length) return [...mds].map(m=>{ let t=""; const walk=n=>{ if(n.nodeType===3) t+=n.nodeValue; else if(n.nodeType===1 && !n.matches(".rs-chip")) for(const c of n.childNodes) walk(c); }; walk(m); return t; }).join("\n");
    return item.textContent||"";
  }
  const streamLen = (item)=> streamText(item===undefined?lastAssistant():item).length;
  let _streamMax=-1,_streamAt=0,_streamItem=null;
  function sampleStream(){
    const item=lastAssistant(); const len=streamText(item).length; const now=Date.now();
    if(item!==_streamItem || len < _streamMax-400){ _streamItem=item; _streamMax=len; _streamAt=now; return; }
    if(len>_streamMax){ _streamMax=len; _streamAt=now; }
  }
  const grewWithin=(ms)=> _streamMax>1 && Date.now()-_streamAt < ms;

  function hasStopButton(){
    for(const sel of S.stopBtn.split(", ")){ try{ const b=document.querySelector(sel); if(b && visible(b)) return true; }catch{} }
    return false;
  }
  function hasGeneratingIndicator(){
    for(const sel of S.generating.split(", ")){ try{ const el=document.querySelector(sel); if(el && el.offsetParent!==null) return true; }catch{} }
    return false;
  }
  function pageBusy(){ try { return !!(window.__ollamaBusy && window.__ollamaBusy()); } catch { return false; } }
  function isGenerating(){
    if(pageBusy()) return true;
    if(hasStopButton()) return true;
    if(hasGeneratingIndicator()) return true;
    sampleStream(); return grewWithin(timings.GEN_IDLE_MS);
  }
  function isBusyNow(){ if(pageBusy()) return true; if(hasStopButton()) return true; if(hasGeneratingIndicator()) return true; sampleStream(); return grewWithin(timings.GEN_IDLE_MS); }
  function isHardGenerating(){ if(pageBusy()) return true; return hasStopButton(); }
  function snapshot(){
    try{ const it=lastAssistant(); if(!it) return {th:0,rp:0}; const md=[...it.querySelectorAll(S.markdown)]; return {th:0, rp: md.reduce((n,m)=>n+(m.textContent||"").length,0)}; }catch{ return {}; }
  }
  function readAssistant(){
    const item=lastAssistant(); if(!item) return {present:false, reply:"", thinking:"", item:null};
    const mds=item.querySelectorAll(S.markdown);
    let reply="";
    if(mds.length) reply=[...mds].map(m=>{ let t=""; const walk=n=>{ if(n.nodeType===3) t+=n.nodeValue; else if(n.nodeType===1 && !n.matches(".rs-chip")) for(const c of n.childNodes) walk(c); }; walk(m); return t; }).join("\n").trim();
    if(!reply){
      let t=""; const walk=n=>{ if(n.nodeType===3) t+=n.nodeValue; else if(n.nodeType===1 && !n.matches(".rs-chip")) for(const c of n.childNodes) walk(c); }; walk(item); reply=t.trim();
    }
    return {present:true, reply, thinking:"", item};
  }
  function findContinueBtn(){ for(const b of document.querySelectorAll("button")) if(b.offsetParent!==null && RE.continueBtn.test((b.innerText||"").trim())) return b; return null; }
  function clickContinueBtn(){ const b=findContinueBtn(); if(!b) return false; try{ b.click(); return true; }catch{return false;} }
  const turnHalted=()=>false;

  async function waitFor(pred, timeout){ const t0=Date.now(); while(Date.now()-t0<timeout){ if(pred()) return true; await sleep(120);} return false; }

  function setTextareaValue(el, v){
    if(el.tagName==="TEXTAREA"||el.tagName==="INPUT"){
      const proto=el.tagName==="TEXTAREA"?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      const setter=proto && Object.getOwnPropertyDescriptor(proto,"value");
      if(setter && setter.set) setter.set.call(el,v); else el.value=v;
      el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
    } else if(el.isContentEditable){
      el.focus(); try{ const sel=window.getSelection(); const range=document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);}catch{}
      document.execCommand("selectAll",false,null); document.execCommand("insertText",false,v); el.dispatchEvent(new Event("input",{bubbles:true}));
    }
  }
  function pressEnter(editor){
    const o={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true};
    editor.dispatchEvent(new KeyboardEvent("keydown",o)); editor.dispatchEvent(new KeyboardEvent("keypress",o)); editor.dispatchEvent(new KeyboardEvent("keyup",o));
  }
  function clickSendButton(){
    if(isBusyNow()) return false;
    for(const sel of S.sendBtn.split(", ")){
      try{ const btn=document.querySelector(sel); if(btn && isVisibleForClick(btn)){ btn.click(); return true; }}catch{}
    }
    const ed=getEditor(); if(ed){ const frame=composerFrame(); if(frame){ for(const b of frame.querySelectorAll("button")) if(isVisibleForClick(b)){ const l=(b.getAttribute("aria-label")||b.textContent||"").toLowerCase(); if(/send|submit/.test(l) && !/stop/.test(l)){ try{b.click(); return true;}catch{}} }}}
    return false;
  }
  const SEND_MAX=120000;
  function truncateForSend(text){
    if(!text||text.length<=SEND_MAX) return text;
    const omitted=text.length-SEND_MAX;
    const marker=`\n\n[…OR: truncated - ${omitted} chars omitted…]\n\n`;
    const budget=SEND_MAX-marker.length; const h=Math.floor(budget*0.85); return text.slice(0,h)+marker+text.slice(text.length-(budget-h));
  }
  async function typeAndSend(text, images){
    const editor=getEditor(); if(!editor) throw new Error("Ollama input not found");
    for(let i=0;i<10&&!editor.isConnected;i++) await sleep(100);
    editor.focus(); await sleep(80); try{editor.click();}catch{} await sleep(50);
    text=truncateForSend(text); setTextareaValue(editor, text); await sleep(150);
    if(editorText().trim().length===0 && text.trim().length>0){
      if(editor.isContentEditable){ editor.focus(); document.execCommand("selectAll",false,null); document.execCommand("insertText",false,text); }
      else { editor.value=text; editor.dispatchEvent(new Event("input",{bubbles:true})); }
      await sleep(200);
    }
    if(images && images.length){ try{ await attachImages(images); }catch{} }
    await sleep(250);
    if(!isBusyNow()){ pressEnter(editor); if(await waitFor(()=> editorText().trim()==="" || isHardGenerating(), 1800)) return; }
    await waitFor(()=>{ for(const sel of S.sendBtn.split(", ")){ try{ const b=document.querySelector(sel); if(b && isVisibleForClick(b)) return true; }catch{} } return false; },2500);
    if(!isBusyNow() && clickSendButton()){ await waitFor(()=> editorText().trim()==="" || isHardGenerating(),2000); return; }
    if(!isBusyNow()){ pressEnter(editor); await sleep(200); }
    await waitFor(()=> editorText().trim()==="" || isHardGenerating(),2500);
  }
  function stopGeneration(){
    for(const sel of S.stopBtn.split(", ")){ try{ const b=document.querySelector(sel); if(b && visible(b)){ try{b.click();}catch{} return; }}catch{} }
  }
  function scanError(){
    try{
      for(const el of document.querySelectorAll(S.errorSurfaces)){
        if(el.offsetParent===null) continue;
        const t=(el.innerText||"").trim();
        if(t.length>8 && t.length<600 && RE.contextLimit.test(t)) return t.slice(0,240);
      }
    }catch{}
    if(!getEditor()) return "Input box disappeared";
    return null;
  }
  const isTooLongMsg=(t)=> RE.tooLong.test(t);
  const isBusyMsg=(t)=> RE.busy.test(t);
  function fileFromImage(img,i){
    const mime=img.mimeType||"image/jpeg"; const bin=atob(img.data); const arr=new Uint8Array(bin.length); for(let j=0;j<bin.length;j++) arr[j]=bin.charCodeAt(j);
    const ext=mime.includes("png")?"png":"jpg"; return new File([arr],`robloxscript_${Date.now()}_${i}.${ext}`,{type:mime});
  }
  async function attachImages(images){
    const editor=getEditor(); if(!editor||!images||!images.length) return false;
    const dt=new DataTransfer(); images.forEach((img,i)=>{ try{ dt.items.add(fileFromImage(img,i)); }catch{}});
    if(!dt.items.length) return false; editor.focus();
    const fileInput=document.querySelector('input[type="file"]');
    if(fileInput){ try{ fileInput.files=dt.files; fileInput.dispatchEvent(new Event("change",{bubbles:true})); }catch{} return await waitFor(()=> composerFrame() && composerFrame().querySelector("img"),12000); }
    try{ editor.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true})); }catch{}
    return await waitFor(()=> composerFrame() && composerFrame().querySelector("img"),8000);
  }
  function clearAttachments(){}
  const conversationKey=()=> location.pathname + location.search;
  function installSendHooks(handlers){
    document.addEventListener("keydown",e=>{
      if(e.key!=="Enter"||e.shiftKey||e.isComposing) return;
      const editor=getEditor(); if(!editor||!editor.contains(e.target)) return;
      if((editorText()||"").trim()==="") return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted() && !chatIsEmpty()) return;
      if(!handlers.isStarted() && chatIsEmpty()){ handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    },true);
    document.addEventListener("click",e=>{
      if(!getEditor()) return;
      const t=e.target; if(!t||!t.closest) return;
      const stopSel=S.stopBtn.split(", "); for(const sel of stopSel){ try{ const s=t.closest(sel); if(s){ handlers.onNativeStop(); return; }}catch{}}
      const cont=t.closest("button"); if(cont && RE.continueBtn.test((cont.innerText||"").trim())){ handlers.onNativeContinue(); return; }
      let isSend=false; for(const sel of S.sendBtn.split(", ")){ try{ if(t.closest(sel)) isSend=true; }catch{} }
      if(!isSend && t.closest("button") && t.closest("form")){ const b=t.closest("button"); if(b && isVisibleForClick(b)) isSend=true; }
      if(!isSend) return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted() && !chatIsEmpty()) return;
      if(!handlers.isStarted() && chatIsEmpty()){ handlers.onBlockedAttempt(); return; }
      handlers.onUserMessage(assistantCount());
    },true);
  }
  const CMD_SHAPE=/"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item, chip){
    if(!item) return null; let parent=null,ref=null;
    const containers=item.querySelectorAll(S.markdown);
    const roots=containers.length?[...containers]:[item];
    for(const container of roots){
      if(chip && container.contains(chip)) continue;
      for(const cw of container.querySelectorAll("pre, code, [class*='code']")){
        if(cw.closest && cw.closest(".rs-chip")) continue;
        if(CMD_SHAPE.test(cw.textContent||"")){ cw.classList.add("rs-tool-hide"); if(!ref && cw.parentElement){ parent=cw.parentElement; ref=cw; }}
      }
      for(const kid of [...container.children]){
        if(kid===chip||(chip&&kid.contains(chip))) continue;
        if(CMD_SHAPE.test(kid.textContent||"")){ kid.classList.add("rs-tool-hide"); if(!ref && kid.parentElement){ parent=kid.parentElement; ref=kid; }}
      }
    }
    return ref?{parent,ref}:null;
  }

  return {
    id: "ollama",
    displayName: "Ollama",
    supportsVision: false,
    timings,
    init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-rs-ollama-ver","2026-09")}catch{} },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();