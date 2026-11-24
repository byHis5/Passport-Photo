// "Special instructions": Claude looks at the current passport photo and returns a structured edit plan.
// The API key is entered once in Settings and stays in this browser (localStorage) on this computer.
import Anthropic from "../vendor/anthropic.mjs";

export const MODEL = "claude-opus-5-5";
const KEY = "ppg.anthropicKey";

export const getKey = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
export const setKey = (k) => { try { k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences: what you changed, for the operator." },
    rotate: { type: "number", description: "Extra rotation in degrees, positive = clockwise. Total, not a delta." },
    zoom: { type: "number", description: "Head size multiplier, 1.0 = spec midpoint. Usually 0.9-1.1." },
    shift_x: { type: "number", description: "Horizontal offset, % of photo width, + = move person right." },
    shift_y: { type: "number", description: "Vertical offset, % of photo height, + = move person down." },
    brightness: { type: "number" }, contrast: { type: "number" }, saturation: { type: "number" }, warmth: { type: "number" },
    airbrush: { type: "number", description: "0-100" },
    blemish: { type: "number", description: "0-100" },
    remove_regions: {
      type: "array",
      description: "Things to erase (jewelry, stray hairs, spots, pen marks). Tight boxes, coordinates 0-1 relative to the image.",
      items: {
        type: "object",
        properties: { label: { type: "string" }, x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" } },
        required: ["label", "x0", "y0", "x1", "y1"], additionalProperties: false,
      },
    },
    cannot_do: { type: "array", items: { type: "string" }, description: "Requested changes this tool cannot make (remove glasses, open eyes, change clothes) - tell the operator to retake or edit manually." },
    compliance_notes: { type: "array", items: { type: "string" }, description: "Passport-rule problems you notice (head turned, shadows, glasses, smiling, hair over eyes, hat). Empty if none." },
  },
  required: ["summary", "rotate", "zoom", "shift_x", "shift_y", "brightness", "contrast", "saturation", "warmth",
    "airbrush", "blemish", "remove_regions", "cannot_do", "compliance_notes"],
  additionalProperties: false,
};

const SYSTEM = `You are the photo technician inside a passport-photo app used at a print shop.
You see the current, already-cropped passport photo (white background already applied) and the
operator's instruction. Return the full set of control values that carries out the instruction.

Rules:
- Start from the CURRENT values you are given and only change what the instruction asks for
  (or what is clearly needed to satisfy it). Return every field.
- Ranges: rotate -15..15, zoom 0.85..1.15, shift_x/shift_y -15..15, brightness/contrast/saturation/warmth -50..50,
  airbrush/blemish 0..100. Keep edits subtle and natural; passport photos must look like the person.
- The app already auto-levels the eyes. "Straighten the head" means fixing remaining tilt: look at the line
  through the pupils and the vertical axis of the face; positive rotate turns the image clockwise.
- Never change skin tone or facial features. Do not lighten dark skin beyond making features clearly visible.
- remove_regions: tight boxes around each item to erase (earrings, nose rings, necklaces visible above the
  collar, stray hairs on the background, spots). Coordinates are fractions 0-1 of THIS image (x right, y down).
  Removal is done by inpainting from surrounding pixels, so keep boxes tight around the object.
- You cannot remove glasses, hats, headphones, shadows across the face, change expression, open eyes,
  or change clothing. Put those in cannot_do.
- compliance_notes: briefly list visible passport-rule problems for the selected document, if any.`;

export class AIError extends Error {}

async function blobToB64(blob) {
  const b = new Uint8Array(await blob.arrayBuffer()); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function planEdits(jpegBlob, instruction, current, spec, meas) {
  const apiKey = getKey();
  if (!apiKey) throw new AIError("Add your Claude API key in Settings (⚙ top right) to use special instructions.");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let specTxt = `${spec.country} - ${spec.document}: ${spec.width_mm}x${spec.height_mm} mm, head (chin to top of hair) ${spec.head_min_mm}-${spec.head_max_mm} mm`;
  if (spec.eye_min_mm != null) specTxt += `, eyes ${spec.eye_min_mm}-${spec.eye_max_mm} mm above the bottom edge`;
  const text = `Document: ${specTxt}\nMeasured now: head ${meas.head_mm} mm, eyes ${meas.eye_mm} mm from bottom, auto-rotation already applied ${meas.auto_rotation} deg.\n` +
    `CURRENT values: ${JSON.stringify(current)}\n\nOperator instruction: ${instruction.trim() || "(none - just check the photo for compliance and leave values unchanged)"}`;
  let resp;
  try {
    resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await blobToB64(jpegBlob) } },
        { type: "text", text },
      ] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError("Claude API key was rejected - check it in Settings.");
    if (e instanceof Anthropic.RateLimitError) throw new AIError("Claude is rate-limited right now - try again in a minute.");
    if (e instanceof Anthropic.APIConnectionError) throw new AIError("Could not reach Claude - check the internet connection.");
    if (e instanceof Anthropic.APIError) throw new AIError(`Claude API error (${e.status}): ${e.message}`);
    throw e;
  }
  if (resp.stop_reason === "refusal") throw new AIError("Claude declined this request. Use the sliders and heal brush instead.");
  const block = resp.content.find((b) => b.type === "text");
  if (!block) throw new AIError("Claude returned no result - try again.");
  return clamp(JSON.parse(block.text));
}

export function clamp(p) {
  const lim = { rotate: [-15, 15], zoom: [0.85, 1.15], shift_x: [-15, 15], shift_y: [-15, 15], brightness: [-50, 50],
    contrast: [-50, 50], saturation: [-50, 50], warmth: [-50, 50], airbrush: [0, 100], blemish: [0, 100] };
  for (const [k, [lo, hi]] of Object.entries(lim)) p[k] = Math.min(hi, Math.max(lo, Number(p[k] ?? (k === "zoom" ? 1 : 0))));
  const c01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  p.remove_regions = (p.remove_regions || []).map((r) => {
    const [x0, x1] = [c01(r.x0), c01(r.x1)].sort((a, b) => a - b), [y0, y1] = [c01(r.y0), c01(r.y1)].sort((a, b) => a - b);
    return { label: r.label || "", x0, y0, x1, y1 };
  }).filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) < 0.08);   // never inpaint a huge area
  p.cannot_do = p.cannot_do || []; p.compliance_notes = p.compliance_notes || [];
  return p;
}
