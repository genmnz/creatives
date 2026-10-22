// Edit operations shared by the CLI (amx apply) and the MCP server.
// Each op is a plain JSON object, so an AI can send a list of them.

import { kid, kids } from "./xml.mjs";

export const OPS_HELP = `Operations (JSON objects, applied in order):
  {"op":"scene", "title"?, "width"?, "height"?, "duration"? (s), "fps"?, "background"?}
  {"op":"add", "layer": {<layer spec>}}                       add a layer on top
  {"op":"effect", "layer": <id|label>, "effect": <id|name>, "params"?: {...}}
  {"op":"set", "layer": <id|label>, "prop": <name>, "value": <value or keyframes>}
      prop: position, scale, rotation, opacity, pivot, skew, fill, text,
            a shape parameter (size, cornerRadius, pointCount, ...),
            or "fx:<effect>.<param>" for an effect parameter
  {"op":"timing", "layer": <id|label>, "start"?: s, "end"?: s}
  {"op":"order", "layer": <id|label>, "where": "front"|"back"|<index>}
  {"op":"remove", "layer": <id|label>}
  {"op":"remove-effect", "layer": <id|label>, "effect": <id|name|index>}
Keyframes: [{"at": seconds-from-layer-start, "v": value, "ease"?: "linear|easeIn|easeOut|easeInOut|hold|[x1,y1,x2,y2]"}]`;

/** Apply all ops, or none: on an error the project is restored and the error rethrown. */
export function applyOps(scene, ops) {
  const backup = JSON.stringify(scene.node);
  try {
    return run(scene, ops);
  } catch (e) {
    const saved = JSON.parse(backup);
    scene.node.attrs = saved.attrs;
    scene.node.children = saved.children;
    throw new Error(`${e.message}\n(no changes were applied)`);
  }
}

function run(scene, ops) {
  const log = [];
  for (const op of Array.isArray(ops) ? ops : [ops]) {
    switch (op.op) {
      case "scene": scene.setScene(op); log.push("scene updated"); break;
      case "add": {
        const n = scene.add(op.layer);
        log.push(`added ${n.tag}#${n.attrs.id} "${n.attrs.label}"`);
        break;
      }
      case "effect": {
        const fx = scene.addEffect(op.layer, { effect: op.effect, params: op.params, hidden: op.hidden });
        log.push(`added effect ${fx.attrs.id} to ${op.layer}`);
        break;
      }
      case "set": scene.set(op.layer, op.prop, op.value); log.push(`set ${op.prop} on ${op.layer}`); break;
      case "timing": scene.setTiming(op.layer, op); log.push(`timing of ${op.layer}`); break;
      case "order": scene.reorder(op.layer, op.where); log.push(`moved ${op.layer} to ${op.where}`); break;
      case "remove": scene.remove(op.layer); log.push(`removed ${op.layer}`); break;
      case "remove-effect": scene.removeEffect(op.layer, String(op.effect)); log.push(`removed effect ${op.effect}`); break;
      default: throw new Error(`unknown op "${op.op}"\n${OPS_HELP}`);
    }
  }
  return log;
}

export function mediaSummary(scene) {
  return kids(scene.node, "media").map((m) => ({ uri: m.attrs.uri, title: m.attrs.title, file: scene.mediaFiles.get(m.attrs.uri) ?? null }));
}

export { kid };
