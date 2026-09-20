figma.showUI(__html__, { width: 320, height: 280 });

function hexToRgb(hex) {
  if (!hex) return { r: 1, g: 1, b: 1 };
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  const num = parseInt(hex, 16);
  if (isNaN(num)) return { r: 1, g: 1, b: 1 };
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255
  };
}

function rgbToHex(r, g, b) {
  const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function resolveParent(parentId) {
  if (parentId) {
    const p = figma.getNodeById(parentId);
    if (p && "appendChild" in p) return p;
  }
  const sel = figma.currentPage.selection[0];
  if (sel && "appendChild" in sel) return sel;
  return figma.currentPage;
}

async function handleCommand(cmd) {
  try {
    const op = cmd.command || cmd.op || cmd.type;
    const a = cmd.args || cmd.arguments || cmd;

    // 1. Frame creation
    if (op === "figma_create_frame" || op === "create_frame") {
      const frame = figma.createFrame();
      frame.name = a.name || "Frame";
      frame.resize(Number(a.width) || 400, Number(a.height) || 300);
      if (a.x != null && a.y != null) {
        frame.x = Number(a.x);
        frame.y = Number(a.y);
      } else {
        frame.x = figma.viewport.center.x - frame.width / 2;
        frame.y = figma.viewport.center.y - frame.height / 2;
      }
      if (a.fill || a.color) {
        frame.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      }
      if (a.cornerRadius != null) frame.cornerRadius = Number(a.cornerRadius);
      if (a.layoutMode) {
        frame.layoutMode = a.layoutMode.toUpperCase() === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL";
        if (a.itemSpacing != null) frame.itemSpacing = Number(a.itemSpacing);
        if (a.padding != null) {
          frame.paddingLeft = Number(a.padding);
          frame.paddingRight = Number(a.padding);
          frame.paddingTop = Number(a.padding);
          frame.paddingBottom = Number(a.padding);
        }
      }
      const parent = resolveParent(a.parentId);
      parent.appendChild(frame);
      figma.currentPage.selection = [frame];
      return { ok: true, id: frame.id, name: frame.name };
    }

    // 2. Rectangle creation
    if (op === "figma_create_rect" || op === "create_rectangle") {
      const rect = figma.createRectangle();
      rect.name = a.name || "Rectangle";
      rect.resize(Number(a.width) || 100, Number(a.height) || 100);
      if (a.x != null && a.y != null) { rect.x = Number(a.x); rect.y = Number(a.y); }
      if (a.fill || a.color) {
        rect.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      }
      if (a.cornerRadius != null) rect.cornerRadius = Number(a.cornerRadius);
      const parent = resolveParent(a.parentId);
      parent.appendChild(rect);
      return { ok: true, id: rect.id, name: rect.name };
    }

    // 3. Ellipse / Circle
    if (op === "figma_create_ellipse" || op === "create_circle") {
      const el = figma.createEllipse();
      el.name = a.name || "Circle";
      const s = Number(a.size || a.diameter || a.width) || 64;
      el.resize(s, Number(a.height) || s);
      if (a.x != null && a.y != null) { el.x = Number(a.x); el.y = Number(a.y); }
      if (a.fill || a.color) el.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      const parent = resolveParent(a.parentId);
      parent.appendChild(el);
      return { ok: true, id: el.id, name: el.name };
    }

    // 4. Text creation
    if (op === "figma_add_text" || op === "create_text") {
      const font = { family: a.fontFamily || "Inter", style: a.fontStyle || "Regular" };
      await figma.loadFontAsync(font);
      const text = figma.createText();
      text.fontName = font;
      text.characters = String(a.text != null ? a.text : "Text");
      if (a.fontSize != null) text.fontSize = Number(a.fontSize);
      if (a.fill || a.color) {
        text.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      }
      if (a.x != null && a.y != null) { text.x = Number(a.x); text.y = Number(a.y); }
      const parent = resolveParent(a.parentId);
      parent.appendChild(text);
      return { ok: true, id: text.id, text: text.characters };
    }

    // 5. Button creation
    if (op === "figma_create_button" || op === "create_button") {
      const frame = figma.createFrame();
      frame.name = a.name || "Button";
      frame.layoutMode = "HORIZONTAL";
      frame.primaryAxisAlignItems = "CENTER";
      frame.counterAxisAlignItems = "CENTER";
      frame.paddingLeft = Number(a.paddingX || a.padding || 16);
      frame.paddingRight = Number(a.paddingX || a.padding || 16);
      frame.paddingTop = Number(a.paddingY || a.padding || 10);
      frame.paddingBottom = Number(a.paddingY || a.padding || 10);
      frame.itemSpacing = Number(a.gap || 8);
      frame.cornerRadius = Number(a.cornerRadius != null ? a.cornerRadius : 8);
      frame.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color || "#3b82f6") }];

      const font = { family: "Inter", style: "Bold" };
      await figma.loadFontAsync(font);
      const label = figma.createText();
      label.fontName = font;
      label.characters = String(a.label || a.text || "Click Me");
      label.fontSize = Number(a.fontSize || 13);
      label.fills = [{ type: "SOLID", color: hexToRgb(a.textColor || "#ffffff") }];
      frame.appendChild(label);

      const parent = resolveParent(a.parentId);
      parent.appendChild(frame);
      return { ok: true, id: frame.id, name: frame.name };
    }

    // 6. Stroke / Border setup
    if (op === "figma_set_stroke" || op === "set_stroke") {
      const node = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!node || !("strokes" in node)) return { ok: false, error: "Node not found or does not support stroke" };
      node.strokes = [{ type: "SOLID", color: hexToRgb(a.color || "#ffffff") }];
      if (a.weight != null || a.thickness != null) node.strokeWeight = Number(a.weight || a.thickness);
      return { ok: true, id: node.id };
    }

    // 7. Auto-layout config
    if (op === "figma_set_autolayout" || op === "set_autolayout") {
      const node = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!node || !("layoutMode" in node)) return { ok: false, error: "Node does not support auto-layout" };
      node.layoutMode = (a.mode || a.direction || "VERTICAL").toUpperCase() === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL";
      if (a.spacing != null || a.itemSpacing != null) node.itemSpacing = Number(a.spacing != null ? a.spacing : a.itemSpacing);
      if (a.padding != null) {
        node.paddingLeft = Number(a.padding);
        node.paddingRight = Number(a.padding);
        node.paddingTop = Number(a.padding);
        node.paddingBottom = Number(a.padding);
      }
      return { ok: true, id: node.id };
    }

    // 8. Corner radius setup
    if (op === "figma_set_corner" || op === "set_corner") {
      const node = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!node || !("cornerRadius" in node)) return { ok: false, error: "Node does not support corner radius" };
      node.cornerRadius = Number(a.radius != null ? a.radius : a.cornerRadius || 0);
      return { ok: true, id: node.id };
    }

    // 9. Position / Sizing
    if (op === "figma_set_bounds" || op === "set_bounds") {
      const node = a.id ? figma.getNodeById(a.id) : figma.currentPage.selection[0];
      if (!node || !("resize" in node)) return { ok: false, error: "Node does not support resizing" };
      if (a.width != null && a.height != null) node.resize(Number(a.width), Number(a.height));
      if (a.x != null) node.x = Number(a.x);
      if (a.y != null) node.y = Number(a.y);
      return { ok: true, id: node.id };
    }

    // 10. Selection and Inspection
    if (op === "figma_get_selection" || op === "inspect_selection") {
      const sel = figma.currentPage.selection;
      return {
        ok: true,
        count: sel.length,
        items: sel.map(n => ({ id: n.id, name: n.name, type: n.type, width: n.width, height: n.height }))
      };
    }

    // 11. Full Tree Export
    if (op === "figma_export_tree" || op === "export_selection") {
      const sel = figma.currentPage.selection[0] || figma.currentPage;
      function dumpNode(node) {
        const item = {
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height,
          x: node.x,
          y: node.y
        };
        if ("cornerRadius" in node) item.cornerRadius = node.cornerRadius;
        if ("fills" in node && Array.isArray(node.fills) && node.fills[0] && node.fills[0].color) {
          const c = node.fills[0].color;
          item.fill = rgbToHex(c.r, c.g, c.b);
        }
        if ("strokes" in node && Array.isArray(node.strokes) && node.strokes[0] && node.strokes[0].color) {
          const c = node.strokes[0].color;
          item.stroke = rgbToHex(c.r, c.g, c.b);
          item.strokeWeight = node.strokeWeight;
        }
        if ("characters" in node) {
          item.text = node.characters;
          item.fontSize = node.fontSize;
        }
        if ("layoutMode" in node && node.layoutMode !== "NONE") {
          item.layoutMode = node.layoutMode;
          item.itemSpacing = node.itemSpacing;
          item.paddingLeft = node.paddingLeft;
          item.paddingTop = node.paddingTop;
        }
        if ("children" in node) {
          item.children = node.children.map(dumpNode);
        }
        return item;
      }
      return { ok: true, tree: dumpNode(sel) };
    }

    return { ok: false, error: "Unknown figma command: " + op };
  } catch(err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "execute_cmd") {
    const res = await handleCommand(msg.payload);
    figma.ui.postMessage({ type: "cmd_result", result: Object.assign({ id: msg.payload.id }, res) });
  } else if (msg.type === "export_selection") {
    const res = await handleCommand({ op: "figma_export_tree" });
    figma.ui.postMessage({ type: "cmd_result", result: res });
    figma.notify("Exported Figma tree for Roblox Studio!");
  }
};
