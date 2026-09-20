figma.showUI(__html__, { width: 300, height: 260 });

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  const num = parseInt(hex, 16);
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

async function handleCommand(cmd) {
  try {
    const op = cmd.command || cmd.op || cmd.type;
    const a = cmd.args || cmd.arguments || cmd;
    
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
      if (a.cornerRadius) frame.cornerRadius = Number(a.cornerRadius);
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
      figma.currentPage.appendChild(frame);
      figma.currentPage.selection = [frame];
      return { ok: true, id: frame.id, name: frame.name };
    }

    if (op === "figma_create_rect" || op === "create_rectangle") {
      const rect = figma.createRectangle();
      rect.name = a.name || "Rectangle";
      rect.resize(Number(a.width) || 100, Number(a.height) || 100);
      if (a.fill || a.color) {
        rect.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      }
      if (a.cornerRadius) rect.cornerRadius = Number(a.cornerRadius);
      
      const parent = a.parentId ? figma.getNodeById(a.parentId) : figma.currentPage.selection[0] || figma.currentPage;
      if (parent && "appendChild" in parent) parent.appendChild(rect);
      else figma.currentPage.appendChild(rect);
      return { ok: true, id: rect.id, name: rect.name };
    }

    if (op === "figma_add_text" || op === "create_text") {
      const font = { family: a.fontFamily || "Inter", style: a.fontStyle || "Regular" };
      await figma.loadFontAsync(font);
      const text = figma.createText();
      text.fontName = font;
      text.characters = String(a.text || "Hello Figma");
      if (a.fontSize) text.fontSize = Number(a.fontSize);
      if (a.fill || a.color) {
        text.fills = [{ type: "SOLID", color: hexToRgb(a.fill || a.color) }];
      }
      const parent = a.parentId ? figma.getNodeById(a.parentId) : figma.currentPage.selection[0] || figma.currentPage;
      if (parent && "appendChild" in parent) parent.appendChild(text);
      else figma.currentPage.appendChild(text);
      return { ok: true, id: text.id, text: text.characters };
    }

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
