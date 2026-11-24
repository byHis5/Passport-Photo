// Quick commands - works with no API key, entirely on this computer.
// Understands short typed instructions ("remove jewelry, a bit brighter, move up") and finds jewelry
// automatically: anything on bare neck / earlobe / nose skin that doesn't match the person's skin colour.
import * as P from "./processing.js";

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const INNER = [33, 133, 362, 263, 61, 291, 1, 2, 98, 327, 70, 300, 105, 334];   // eyes, mouth, nose, brows (excluded from skin sample)

// ------------------------------------------------------------------ phrase parsing
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const RULES = [
  // jewelry
  { re: /\b(jewel+e?ry|jewelery|accessor(y|ies)|piercings?)\b/, act: { remove: ["necklace", "earrings", "nose"] } },
  { re: /\b(necklaces?|chains?|pendants?|choker)\b/, act: { remove: ["necklace"] } },
  { re: /\b(ear ?rings?|studs?|hoops?|ear piercings?)\b/, act: { remove: ["earrings"] } },
  { re: /\b(nose ?rings?|nose ?studs?|nose piercings?|septum)\b/, act: { remove: ["nose"] } },
  // tone
  { re: new RegExp(String.raw`\b(brighter|lighter|brighten|lighten)\b(?:\D{0,12}${NUM})?`), act: (m) => ({ add: { brightness: +(m[2] || 10) } }) },
  { re: new RegExp(String.raw`\b(darker|darken)\b(?:\D{0,12}${NUM})?`), act: (m) => ({ add: { brightness: -(m[2] || 10) } }) },
  { re: /\b(more contrast|increase contrast|punchier)\b/, act: { add: { contrast: 10 } } },
  { re: /\b(less contrast|reduce contrast|softer|flatter)\b/, act: { add: { contrast: -10 } } },
  { re: /\b(warmer|warm up|more warm)\b/, act: { add: { warmth: 10 } } },
  { re: /\b(cooler|cool down|less warm|less yellow|less orange)\b/, act: { add: { warmth: -10 } } },
  { re: /\b(more colou?r|more saturat\w*|more vivid)\b/, act: { add: { saturation: 10 } } },
  { re: /\b(less colou?r|less saturat\w*|desaturate|less red)\b/, act: { add: { saturation: -10 } } },
  // retouch
  { re: /\b(smooth(er)?( skin)?|airbrush( more)?|soften skin)\b/, act: { add: { airbrush: 15 } } },
  { re: /\b(less (smooth\w*|airbrush)|no airbrush|more natural)\b/, act: { add: { airbrush: -20 } } },
  { re: /\b(blemish(es)?|spots?|pimples?|acne|marks?)\b/, act: { add: { blemish: 25 } } },
  // geometry
  { re: new RegExp(String.raw`\brotate\b[^,.;]*?\b(left|counter|anti)[^,.;]*?(?:${NUM})?|\b(tilt|turn)\w*\s+left\b(?:\D{0,12}${NUM})?`), act: (m) => ({ add: { rotate: -(m[2] || m[4] || 1) } }) },
  { re: new RegExp(String.raw`\brotate\b[^,.;]*?\b(right|clockwise)[^,.;]*?(?:${NUM})?|\b(tilt|turn)\w*\s+right\b(?:\D{0,12}${NUM})?`), act: (m) => ({ add: { rotate: +(m[2] || m[4] || 1) } }) },
  { re: /\b(straighten|level|straight)\b/, act: { set: { auto_straighten: true } } },
  { re: /\b(bigger|larger|zoom in|closer|head (too )?small|enlarge)\b/, act: { add: { zoom: 0.03 } } },
  { re: /\b(smaller|zoom out|further|head (too )?(big|large))\b/, act: { add: { zoom: -0.03 } } },
  { re: /\bmove (it |him |her |them |the (head|person|face) )?up\b|\bhigher\b/, act: { add: { shift_y: -2 } } },
  { re: /\bmove (it |him |her |them |the (head|person|face) )?down\b|\blower\b/, act: { add: { shift_y: 2 } } },
  { re: /\bmove (it |him |her |them |the (head|person|face) )?left\b/, act: { add: { shift_x: -2 } } },
  { re: /\bmove (it |him |her |them |the (head|person|face) )?right\b/, act: { add: { shift_x: 2 } } },
  { re: /\b(cent(er|re)|centred|centered)\b/, act: { set: { shift_x: 0 } } },
  { re: /\b(reset|start over|undo all)\b/, act: { reset: true } },
];
const CANT = [
  [/\bglasses|spectacles|eyeglasses\b/, "Glasses can't be removed – passports need a photo without glasses (retake)."],
  [/\b(hat|cap|hijab|scarf|head ?wrap|headband|bandana)\b/, "Head coverings can't be removed by editing – retake (religious coverings are allowed if the face is fully visible)."],
  [/\b(smile|smiling|mouth|teeth|eyes? (closed|open)|blink)\b/, "Expressions and eyes can't be changed – retake with a neutral face, eyes open."],
  [/\b(shadow|glare|reflection)\b/, "Shadows and glare across the face can't be removed reliably – retake with even light."],
  [/\b(shirt|clothes|clothing|uniform|jacket|outfit)\b/, "Clothing can't be changed."],
  [/\b(hair|fringe|bangs)\b(?!.*\b(background|stray)\b)/, "Hair can't be moved – ask the customer to clear hair from the eyes and face (retake)."],
];

/** -> {remove:Set, add:{}, set:{}, reset, notes:[], unknown:[]} */
export function parse(text) {
  const out = { remove: new Set(), add: {}, set: {}, reset: false, notes: [], unknown: [] };
  const parts = text.toLowerCase().replace(/[’']/g, "").split(/[,.;\n]+|\band\b|\bthen\b|\balso\b/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    let hit = false;
    for (const [re, msg] of CANT) if (re.test(part)) { if (!out.notes.includes(msg)) out.notes.push(msg); hit = true; }
    if (hit) continue;
    for (const r of RULES) {
      const m = part.match(r.re); if (!m) continue;
      hit = true;
      const a = typeof r.act === "function" ? r.act(m) : r.act;
      (a.remove || []).forEach((x) => out.remove.add(x));
      for (const [k, v] of Object.entries(a.add || {})) out.add[k] = (out.add[k] || 0) + v;
      Object.assign(out.set, a.set || {});
      if (a.reset) out.reset = true;
    }
    if (!hit) out.unknown.push(part);
  }
  return out;
}

export const HELP = "Try: remove jewelry · remove necklace · remove earrings · remove nose ring · brighter / darker · warmer / cooler · smoother skin · remove spots · straighten · rotate left 2 · bigger / smaller · move up / down / left / right · reset";

// ------------------------------------------------------------------ jewelry finder
function skinModel(cv, a, lab) {
  // median + spread of skin colour (Lab) sampled from the face, away from eyes/mouth/brows
  const xs = FACE_OVAL.map((i) => a.lm[i][0]), ys = FACE_OVAL.map((i) => a.lm[i][1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(a.rgb.cols - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(a.rgb.rows - 1, Math.ceil(Math.max(...ys)));
  const poly = FACE_OVAL.map((i) => a.lm[i]);
  const inside = (x, y) => {   // point in polygon
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const avoid = INNER.map((i) => a.lm[i]), r2 = (a.faceW * 0.09) ** 2;
  const L = [], A = [], B = [], D = lab.data, w = lab.cols, step = Math.max(2, Math.round(a.faceW / 120));
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    if (!inside(x, y) || avoid.some((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 < r2)) continue;
    const p = (y * w + x) * 3; L.push(D[p]); A.push(D[p + 1]); B.push(D[p + 2]);
  }
  const med = (v) => { const s = [...v].sort((p, q) => p - q); return s[s.length >> 1] ?? 128; };
  const mad = (v, m) => med(v.map((x) => Math.abs(x - m)));
  const mL = med(L), mA = med(A), mB = med(B);
  return { L: mL, A: mA, B: mB, sL: Math.max(6, mad(L, mL) * 1.5), sC: Math.max(4, Math.hypot(mad(A, mA), mad(B, mB)) * 1.5) };
}

/** find jewelry in source-image space; returns {mask (CV_8UC1, caller deletes) , found:{necklace,earrings,nose}} */
export function findJewelry(a, which) {
  const cv = P.getCv();
  const lab = new cv.Mat(); cv.cvtColor(a.rgb, lab, cv.COLOR_RGB2Lab);
  const sk = skinModel(cv, a, lab);
  const W = a.rgb.cols, H = a.rgb.rows, D = lab.data, AL = a.alpha.data, fw = a.faceW, lm = a.lm;
  const mask = cv.Mat.zeros(H, W, cv.CV_8UC1);
  const found = {};

  const isSkin = (p) => {   // same hue as the face; any darkness counts (shadows under the jaw are skin)
    const dl = D[p] - sk.L, dc = Math.hypot(D[p + 1] - sk.A, D[p + 2] - sk.B);
    return dl < sk.sL * 2.5 + 18 && dc < sk.sC * 3 + 9;
  };
  const shiny = (p) => {   // jewelry colours: silver / white metal & pearls, gold / brass, bright highlights
    const L = D[p], a = D[p + 1] - 128, b = D[p + 2] - 128, chroma = Math.hypot(a, b);
    const silver = L > sk.L + 14 && L > 140 && chroma < 12;
    const gold = L > 95 && b > 22 && b > a * 1.4 && Math.hypot(a - (sk.A - 128), b - (sk.B - 128)) > sk.sC * 3 + 10;
    const glint = L > sk.L + sk.sL * 2.5 + 30;
    return silver || gold || glint;
  };

  // region search: candidate = not skin, inside the person, and (shiny OR enclosed by skin)
  function search(name, x0, y0, x1, y1, closeK, maxFrac, requireShiny) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    const rw = x1 - x0, rh = y1 - y0; if (rw < 4 || rh < 4) return 0;
    const t = []; const T = (m) => (t.push(m), m);
    const skin = T(new cv.Mat(rh, rw, cv.CV_8UC1)), cand = T(new cv.Mat(rh, rw, cv.CV_8UC1));
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = (y + y0) * W + x + x0, p = i * 3, q = y * rw + x;
      const fg = AL[i] > 140;
      skin.data[q] = fg && isSkin(p) ? 255 : 0;
      cand.data[q] = fg && !skin.data[q] && shiny(p) ? 255 : 0;
    }
    // things sitting on skin: close the skin mask; holes it fills are not-skin objects on the skin
    const k = Math.max(5, Math.round(closeK)) | 1;
    const se = T(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    const closed = T(new cv.Mat()); cv.morphologyEx(skin, closed, cv.MORPH_CLOSE, se);
    // background next to the person (dangling earrings hang against it)
    const bg = T(new cv.Mat(rh, rw, cv.CV_8UC1));
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) bg.data[y * rw + x] = AL[(y + y0) * W + x + x0] < 60 ? 255 : 0;
    const kb = Math.max(3, Math.round(fw * 0.03)) | 1;
    const seb = T(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kb, kb))); cv.dilate(bg, bg, seb);
    const hit = T(new cv.Mat(rh, rw, cv.CV_8UC1));
    for (let q = 0; q < rw * rh; q++) {
      const fg = AL[(((q / rw) | 0) + y0) * W + (q % rw) + x0] > 140;
      const onSkin = fg && closed.data[q] && !skin.data[q];
      // necklace: jewelry-coloured things lying on bare skin (never clothing); ears/nose: also hanging by the edge
      hit.data[q] = (requireShiny ? cand.data[q] && (onSkin || bg.data[q]) : cand.data[q] && (onSkin || closed.data[q])) ? 255 : 0;
    }
    // keep reasonable blobs only
    const labs = T(new cv.Mat()), stats = T(new cv.Mat()), cent = T(new cv.Mat());
    const n = cv.connectedComponentsWithStats(hit, labs, stats, cent, 8, cv.CV_32S);
    const minA = Math.max(4, (fw * 0.008) ** 2), maxA = rw * rh * maxFrac;
    const keep = new Uint8Array(n); let total = 0;
    const ringW = Math.max(2, Math.round(fw * 0.015));
    for (let i = 1; i < n; i++) {
      const ar = stats.intAt(i, cv.CC_STAT_AREA); if (ar < minA || ar > maxA) continue;
      // ignore anything touching the photo's own edge (frame artefacts, cut-off clothing)
      if (stats.intAt(i, cv.CC_STAT_TOP) + y0 <= 1 || stats.intAt(i, cv.CC_STAT_TOP) + stats.intAt(i, cv.CC_STAT_HEIGHT) + y0 >= H - 2 ||
          stats.intAt(i, cv.CC_STAT_LEFT) + x0 <= 1 || stats.intAt(i, cv.CC_STAT_LEFT) + stats.intAt(i, cv.CC_STAT_WIDTH) + x0 >= W - 2) continue;
      // jewelry is thin (chains) or small (pendants, studs); collars and clothing are broad shapes
      const longSide = Math.max(stats.intAt(i, cv.CC_STAT_WIDTH), stats.intAt(i, cv.CC_STAT_HEIGHT));
      if (ar / longSide > fw * 0.06) continue;
      // jewelry lies ON the skin: the pixels around it must be mostly skin (rules out collars, shirts, hair)
      const bx = stats.intAt(i, cv.CC_STAT_LEFT), by = stats.intAt(i, cv.CC_STAT_TOP);
      const bw = stats.intAt(i, cv.CC_STAT_WIDTH), bh = stats.intAt(i, cv.CC_STAT_HEIGHT);
      let ringSkin = 0, ringAll = 0;
      for (let y = Math.max(0, by - ringW); y < Math.min(rh, by + bh + ringW); y++) for (let x = Math.max(0, bx - ringW); x < Math.min(rw, bx + bw + ringW); x++) {
        const q = y * rw + x; if (labs.data32S[q] === i) continue;
        // pixel near the blob?
        let near = false;
        for (let dy = -ringW; dy <= ringW && !near; dy += ringW) for (let dx = -ringW; dx <= ringW && !near; dx += ringW) {
          const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < rh && xx >= 0 && xx < rw && labs.data32S[yy * rw + xx] === i) near = true;
        }
        if (!near) continue;
        ringAll++; if (skin.data[q] || (requireShiny && bg.data[q])) ringSkin++;
      }
      if (ringAll && ringSkin / ringAll >= 0.7) { keep[i] = 1; total += ar; }
    }
    if (total) {
      const blob = T(new cv.Mat(rh, rw, cv.CV_8UC1));
      for (let q = 0; q < rw * rh; q++) blob.data[q] = keep[labs.data32S[q]] ? 255 : 0;
      const d = Math.max(3, Math.round(fw * 0.012)) | 1;
      const se2 = T(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(d, d))); cv.dilate(blob, blob, se2);
      const roi = T(mask.roi(new cv.Rect(x0, y0, rw, rh))); cv.bitwise_or(roi, blob, roi);
    }
    t.forEach((m) => m.delete());
    found[name] = (found[name] || 0) + (total > 0 ? 1 : 0);
    return total;
  }

  const chin = lm[152], jawL = lm[172], jawR = lm[397];
  if (which.has("necklace")) {
    // bare neck and upper chest below the chin
    const cx = chin[0], half = fw * 0.6;
    search("necklace", cx - half, Math.min(jawL[1], jawR[1]), cx + half, chin[1] + fw * 0.42, fw * 0.09, 0.25, false);
  }
  if (which.has("earrings")) {
    // earlobe areas, hanging down below the lobe (studs, hoops, drops); require shiny so hair isn't erased
    for (const [ear, dir] of [[lm[234], -1], [lm[454], 1]]) {
      const xa = ear[0] - dir * fw * 0.06, xb = ear[0] + dir * fw * 0.3;
      search("earrings", Math.min(xa, xb), ear[1] - fw * 0.02, Math.max(xa, xb), ear[1] + fw * 0.55, fw * 0.05, 0.3, true);
    }
  }
  if (which.has("nose")) {
    const xs = [98, 327, 48, 278].map((i) => lm[i][0]);
    search("nose", Math.min(...xs) - fw * 0.04, lm[1][1] - fw * 0.06, Math.max(...xs) + fw * 0.04, lm[0][1], fw * 0.04, 0.2, true);
  }
  lab.delete();
  return { mask, found };
}
