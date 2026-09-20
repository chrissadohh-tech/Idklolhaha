figma.showUI(__html__, { width: 320, height: 280 });
function hexToRgb(h) {
  if (!h) return { r: 1, g: 1, b: 1 };
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h, 16);
  return isNaN(n) ? { r: 1, g: 1, b: 1 } : { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function rgbToHex(r, g, b) {
  const h = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function resolveParent(pid) {
  if (pid) { const p = figma.getNodeById(pid); if (p && "appendChild" in p) return p; }
  const s = figma.currentPage.selection[0];
  return (s && "appendChild" in s) ? s : figma.currentPage;
}
async function handleCommand(cmd) {
  try {
    const op = cmd.command || cmd.op || cmd.type;
    const a = cmd.args || cmd.arguments || cmd;
    if (op === "figma_create_frame" || op === "create_frame") {
      const f = figma.createFrame();
      f.name = a.name || "Frame";
      f.resize(Number(a.width) || 400, Number(a.height) || 300);
      if (a.x != null && a.y != null) { f.x = Number(a.x); f.y = Number(a.y); }
      else { f.x = figma.viewport.center.x - f.width / 2; f.y = figma.viewport.center.y - f.height / 2; }
      if (a.fill || a.color) f.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      if (a.cornerRadius != null) f.cornerRadius = Number(a.cornerRadius);
      if (a.layoutMode) {
        f.layoutMode = a.layoutMode.toUpperCase() === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL";
        if (a.itemSpacing != null) f.itemSpacing = Number(a.itemSpacing);
        if (a.padding != null) { f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = Number(a.padding); }
      }
      resolveParent(a.parentId).appendChild(f);
      figma.currentPage.selection = [f];
      return { ok: true, id: f.id, name: f.name };
    }
    if (op === "figma_create_rect" || op === "create_rectangle") {
      const r = figma.createRectangle();
      r.name = a.name || "Rectangle";
      r.resize(Number(a.width) || 100, Number(a.height) || 100);
      if (a.x != null && a.y != null) { r.x = Number(a.x); r.y = Number(a.y); }
      if (a.fill || a.color) r.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      if (a.cornerRadius != null) r.cornerRadius = Number(a.cornerRadius);
      resolveParent(a.parentId).appendChild(r);
      return { ok: true, id: r.id, name: r.name };
    }
    if (op === "figma_create_ellipse" || op === "create_circle") {
      const el = figma.createEllipse();
      el.name = a.name || "Circle";
      const s = Number(a.size || a.diameter || a.width) || 64;
      el.resize(s, Number(a.height) || s);
      if (a.x != null && a.y != null) { el.x = Number(a.x); el.y = Number(a.y); }
      if (a.fill || a.color) el.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      resolveParent(a.parentId).appendChild(el);
      return { ok: true, id: el.id, name: el.name };
    }
    if (op === "figma_add_text" || op === "create_text") {
      const font = { family: a.fontFamily || "Inter", style: a.fontStyle || "Regular" };
      await figma.loadFontAsync(font);
      const t = figma.createText();
      t.fontName = font;
      t.characters = String(a.text != null ? a.text : "Text");
      if (a.fontSize != null) t.fontSize = Number(a.fontSize);
      if (a.fill || a.color) t.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      if (a.x != null && a.y != null) { t.x = Number(a.x); t.y = Number(a.y); }
      resolveParent(a.parentId).appendChild(t);
      return { ok: true, id: t.id, text: t.characters };
    }
    if (op === "figma_create_button" || op === "create_button") {
      const f = figma.createFrame();
      f.name = a.name || "Button";
      f.layoutMode = "HORIZONTAL";
      f.primaryAxisAlignItems = f.counterAxisAlignItems = "CENTER";
      const px = Number(a.paddingX || a.padding || 16), py = Number(a.paddingY || a.padding || 10);
      f.paddingLeft = f.paddingRight = px; f.paddingTop = f.paddingBottom = py;
      f.itemSpacing = Number(a.gap || 8);
      f.cornerRadius = Number(a.cornerRadius != null ? a.cornerRadius : 8);
      f.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color || "#0284c7") }];
      const font = { family: "Inter", style: "Bold" };
      await figma.loadFontAsync(font);
      const lbl = figma.createText();
      lbl.fontName = font;
      lbl.characters = String(a.label || a.text || "Button");
      lbl.fontSize = Number(a.fontSize || 13);
      lbl.fills = [{ type: "SOLID", color: hexToRgb(a.textColor || "#ffffff") }];
      f.appendChild(lbl);
      resolveParent(a.parentId).appendChild(f);
      return { ok: true, id: f.id, name: f.name };
    }
    if (op === "figma_set_stroke" || op === "set_stroke") {
      const n = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!n || !("strokes" in n)) return { ok: false, error: "Node not found or no stroke support" };
      n.strokes = [{ type: "SOLID", color: hexToRgb(a.color || "#ffffff") }];
      if (a.weight != null || a.thickness != null) n.strokeWeight = Number(a.weight || a.thickness);
      return { ok: true, id: n.id };
    }
    if (op === "figma_set_autolayout" || op === "set_autolayout") {
      const n = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!n || !("layoutMode" in n)) return { ok: false, error: "Node does not support auto-layout" };
      n.layoutMode = (a.mode || a.direction || "VERTICAL").toUpperCase() === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL";
      if (a.spacing != null) n.itemSpacing = Number(a.spacing);
      if (a.padding != null) n.paddingLeft = n.paddingRight = n.paddingTop = n.paddingBottom = Number(a.padding);
      return { ok: true, id: n.id };
    }
    if (op === "figma_set_corner" || op === "set_corner") {
      const n = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!n || !("cornerRadius" in n)) return { ok: false, error: "Node does not support corner radius" };
      n.cornerRadius = Number(a.radius != null ? a.radius : a.cornerRadius || 0);
      return { ok: true, id: n.id };
    }
    if (op === "figma_set_bounds" || op === "set_bounds") {
      const n = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!n || !("resize" in n)) return { ok: false, error: "Node does not support resize" };
      if (a.width != null && a.height != null) n.resize(Number(a.width), Number(a.height));
      if (a.x != null) n.x = Number(a.x);
      if (a.y != null) n.y = Number(a.y);
      return { ok: true, id: n.id };
    }
    if (op === "figma_get_selection" || op === "inspect_selection") {
      const s = figma.currentPage.selection;
      return { ok: true, count: s.length, items: s.map(x => ({ id: x.id, name: x.name, type: x.type, width: x.width, height: x.height })) };
    }
    if (op === "figma_export_tree" || op === "export_selection") {
      const sel = figma.currentPage.selection[0] || figma.currentPage;
      function dumpNode(node) {
        const item = { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height, x: node.x, y: node.y };
        if ("cornerRadius" in node) item.cornerRadius = node.cornerRadius;
        if ("fills" in node && Array.isArray(node.fills) && node.fills[0] && node.fills[0].color) {
          const c = node.fills[0].color; item.fill = rgbToHex(c.r, c.g, c.b);
        }
        if ("strokes" in node && Array.isArray(node.strokes) && node.strokes[0] && node.strokes[0].color) {
          const c = node.strokes[0].color; item.stroke = rgbToHex(c.r, c.g, c.b); item.strokeWeight = node.strokeWeight;
        }
        if ("characters" in node) { item.text = node.characters; item.fontSize = node.fontSize; }
        if ("layoutMode" in node && node.layoutMode !== "NONE") {
          item.layoutMode = node.layoutMode; item.itemSpacing = node.itemSpacing;
          item.paddingLeft = node.paddingLeft; item.paddingTop = node.paddingTop;
        }
        if ("children" in node) item.children = node.children.map(dumpNode);
        return item;
      }
      return { ok: true, tree: dumpNode(sel) };
    }
    return { ok: false, error: "Unknown command: " + op };
  } catch(e) { return { ok: false, error: String(e && e.message || e) }; }
}
figma.ui.onmessage = async (msg) => {
  if (msg.type === "execute_cmd") {
    const res = await handleCommand(msg.payload);
    figma.ui.postMessage({ type: "cmd_result", result: Object.assign({ id: msg.payload.id }, res) });
  } else if (msg.type === "export_selection") {
    const res = await handleCommand({ op: "figma_export_tree" });
    figma.ui.postMessage({ type: "cmd_result", result: res });
    figma.notify("Exported Figma tree for Studio!");
  }
};
