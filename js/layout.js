// 4x6 print sheets (300 dpi, portrait 1200 x 1800) and coupon storage.
import { DPI } from "./processing.js";

export const SHEET_W = 4 * DPI, SHEET_H = 6 * DPI;
const CUT = "rgb(200,200,200)";

/** guillotine packing: max number of w x h photos (upright or sideways) in W x H; returns [{x,y,rot}] */
export function pack(W, H, w, h) {
  const memo = new Map();
  function best(rw, rh) {
    const key = rw + "x" + rh;
    if (memo.has(key)) return memo.get(key);
    let res = { n: 0, cells: [] };
    for (const [pw, ph, rot] of [[w, h, false], [h, w, true]]) {
      if (pw > rw || ph > rh) continue;
      const rows = Math.floor(rh / ph);
      for (let k = 1; k <= Math.floor(rw / pw); k++) {
        const rest = best(rw - k * pw, rh), n = k * rows + rest.n;
        if (n > res.n) {
          const cells = [];
          for (let c = 0; c < k; c++) for (let r = 0; r < rows; r++) cells.push({ x: c * pw, y: r * ph, rot });
          rest.cells.forEach((q) => cells.push({ x: q.x + k * pw, y: q.y, rot: q.rot }));
          res = { n, cells };
        }
      }
      const cols = Math.floor(rw / pw);
      for (let k = 1; k <= Math.floor(rh / ph); k++) {
        const rest = best(rw, rh - k * ph), n = k * cols + rest.n;
        if (n > res.n) {
          const cells = [];
          for (let r = 0; r < k; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * pw, y: r * ph, rot });
          rest.cells.forEach((q) => cells.push({ x: q.x, y: q.y + k * ph, rot: q.rot }));
          res = { n, cells };
        }
      }
    }
    memo.set(key, res);
    return res;
  }
  // Several layouts can fit the same number of photos. Prefer the one that is quickest to cut:
  // fewest distinct cut positions, i.e. a plain grid whose cuts run straight across the sheet.
  const grid = (pw, ph, rot) => {
    const cells = []; for (let y = 0; y + ph <= H; y += ph) for (let x = 0; x + pw <= W; x += pw) cells.push({ x, y, rot });
    return cells;
  };
  const cands = [best(W, H).cells, grid(w, h, false), grid(h, w, true)];
  const n = Math.max(...cands.map((c) => c.length));
  return cands.filter((c) => c.length === n).sort((a, b) => cutCount(a, w, h, W, H) - cutCount(b, w, h, W, H))[0];
}

/** number of distinct straight cuts needed (paper edges are free) */
export function cutCount(cells, w, h, W = SHEET_W, H = SHEET_H) {
  const xs = new Set(), ys = new Set();
  for (const { x, y, rot } of cells) {
    const cw = rot ? h : w, ch = rot ? w : h;
    [x, x + cw].forEach((v) => { if (v > 0 && v < W) xs.add(v); });
    [y, y + ch].forEach((v) => { if (v > 0 && v < H) ys.add(v); });
  }
  return xs.size + ys.size;
}

export const maxCopiesFor = (w, h) => pack(SHEET_W, SHEET_H, w, h).length;

function newSheet() {
  const c = document.createElement("canvas"); c.width = SHEET_W; c.height = SHEET_H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, SHEET_W, SHEET_H);
  return { c, g };
}

/** draws the photos; returns their rectangles [{x,y,w,h}] on the sheet */
function place(g, photo, cells, ox, oy, cutLines) {
  const w = photo.width, h = photo.height, rects = [];
  g.lineWidth = 1; g.strokeStyle = CUT;
  for (const { x, y, rot } of cells) {
    if (rot) {   // head pointing left, like the reference sheets
      g.save(); g.translate(ox + x, oy + y + w); g.rotate(-Math.PI / 2); g.drawImage(photo, 0, 0); g.restore();
    } else g.drawImage(photo, ox + x, oy + y);
    const cw = rot ? h : w, ch = rot ? w : h;
    if (cutLines) g.strokeRect(ox + x + 0.5, oy + y + 0.5, cw - 1, ch - 1);
    rects.push({ x: ox + x, y: oy + y, w: cw, h: ch });
  }
  return rects;
}

// Cut marks for lining the sheet up on a cutting board: every cut line gets a short tick at both paper
// edges, and faint dashes wherever it runs through blank paper (never over the photos).
const MARK = "rgb(205,205,205)", TICK = 40, DASH = [14, 10];
function cutMarks(g, photoRects, otherRects = []) {
  const xs = new Set(), ys = new Set();
  for (const r of photoRects) {
    [r.x, r.x + r.w].forEach((v) => { if (v > 0 && v < SHEET_W) xs.add(v); });
    [r.y, r.y + r.h].forEach((v) => { if (v > 0 && v < SHEET_H) ys.add(v); });
  }
  const all = [...photoRects, ...otherRects];
  // is this point on a photo (or on the seam between two photos)?
  const covered = (x, y) => all.some((r) => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2);
  g.save(); g.strokeStyle = MARK; g.lineWidth = 2; g.lineCap = "butt";
  const seg = (x0, y0, x1, y1) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  for (const x of xs) {
    seg(x, 0, x, TICK); seg(x, SHEET_H - TICK, x, SHEET_H);                       // edge ticks
    for (let y = TICK + 6; y < SHEET_H - TICK - 6; y += DASH[0] + DASH[1]) {        // dashes on blank paper
      const y1 = Math.min(y + DASH[0], SHEET_H - TICK - 6);
      if (!covered(x, y) && !covered(x, y1)) seg(x, y, x, y1);
    }
  }
  for (const y of ys) {
    seg(0, y, TICK, y); seg(SHEET_W - TICK, y, SHEET_W, y);
    for (let x = TICK + 6; x < SHEET_W - TICK - 6; x += DASH[0] + DASH[1]) {
      const x1 = Math.min(x + DASH[0], SHEET_W - TICK - 6);
      if (!covered(x, y) && !covered(x1, y)) seg(x, y, x1, y);
    }
  }
  g.restore();
}

/** photo: canvas at print size. returns {canvas, copies} */
export function maxCopiesSheet(photo, cutLines = true, marks = true) {
  const cells = pack(SHEET_W, SHEET_H, photo.width, photo.height);
  if (!cells.length) throw new Error("Photo is larger than 4x6 paper.");
  // photos touch each other and the top-left corner: straight cuts right across the sheet,
  // paper edges count as cuts, and all waste is one strip on the right / bottom
  const { c, g } = newSheet();
  const rects = place(g, photo, cells, 0, 0, cutLines);
  if (marks) cutMarks(g, rects);
  return { canvas: c, copies: cells.length };
}

/** Mixed sheet like the reference: 3 x 2x2 in down the left, 4 x 35x45 mm sideways down the right */
export function comboSheet(usPhoto, euPhoto, cutLines = true, marks = true) {
  const { c, g } = newSheet();
  const leftW = usPhoto.width;
  const usCells = [0, 1, 2].map((r) => ({ x: 0, y: r * usPhoto.height, rot: false }));
  if (leftW + euPhoto.height > SHEET_W || 3 * usPhoto.height > SHEET_H || 4 * euPhoto.width > SHEET_H)
    throw new Error("These sizes don't fit together on 4x6 paper.");
  const r1 = place(g, usPhoto, usCells, 0, 0, cutLines);
  const euCells = [0, 1, 2, 3].map((r) => ({ x: 0, y: r * euPhoto.width, rot: true }));
  const r2 = place(g, euPhoto, euCells, leftW, 0, cutLines);  // right column touches the left one, from the top
  if (marks) cutMarks(g, [...r1, ...r2]);
  return { canvas: c, copies: 7 };
}

/** 4 copies on top, coupon image (HTMLImageElement/ImageBitmap or null) underneath */
export function couponSheet(photo, coupon, copies = 4, cutLines = true, marks = true) {
  const w = photo.width, h = photo.height;
  const cols = Math.min(copies, Math.max(1, Math.floor(SHEET_W / w))), rows = Math.ceil(copies / cols);
  if (cols * w > SHEET_W || rows * h > SHEET_H) throw new Error(`${copies} copies of this size do not fit on 4x6 paper.`);
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells.length < copies) cells.push({ x: c * w, y: r * h, rot: false });
  const { c, g } = newSheet();
  const rects = place(g, photo, cells, 0, 0, cutLines);       // block in the top-left corner
  if (!coupon) { if (marks) cutMarks(g, rects); return { canvas: c, copies }; }
  const top = rows * h, boxW = SHEET_W, boxH = SHEET_H - top;   // coupon right under the photos: one cut separates them
  if (boxH < 200) throw new Error("Not enough room for a coupon with this photo size - use the max-copies sheet.");
  let cw = coupon.width, chh = coupon.height, rotate = false;
  if (cw < chh && boxW >= boxH) { rotate = true; [cw, chh] = [chh, cw]; }
  const s = Math.min(boxW / cw, boxH / chh), dw = Math.round(cw * s), dh = Math.round(chh * s);
  const x = 0, y = top;
  g.imageSmoothingQuality = "high";
  if (rotate) { g.save(); g.translate(x, y + dh); g.rotate(-Math.PI / 2); g.drawImage(coupon, 0, 0, dh, dw); g.restore(); }
  else g.drawImage(coupon, x, y, dw, dh);
  if (marks) cutMarks(g, rects, [{ x, y, w: rotate ? dh : dw, h: rotate ? dw : dh }]);
  return { canvas: c, copies };
}

// ------------------------------------------------------------------ coupon store
// Built-in coupons come from coupons/manifest.json; ones added in the app live in this browser (IndexedDB).
const DB = "ppg", STORE = "coupons", HIDDEN = "ppg.hiddenCoupons";

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
    t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error);
  });
}
const hidden = () => { try { return JSON.parse(localStorage.getItem(HIDDEN) || "[]"); } catch { return []; } };
const setHidden = (v) => { try { localStorage.setItem(HIDDEN, JSON.stringify(v)); } catch { /* private mode */ } };

export async function listCoupons() {
  const out = [];
  try {
    const m = await (await fetch("coupons/manifest.json", { cache: "no-cache" })).json();
    const hid = hidden();
    m.filter((n) => !hid.includes(n)).forEach((n) => out.push({ name: n, url: "coupons/" + encodeURIComponent(n), builtin: true }));
  } catch { /* no manifest */ }
  try {
    const keys = await tx("readonly", (s) => s.getAllKeys());
    for (const k of keys) {
      const blob = await tx("readonly", (s) => s.get(k));
      out.push({ name: k, url: URL.createObjectURL(blob), builtin: false });
    }
  } catch { /* IndexedDB unavailable */ }
  return out;
}

export async function addCoupons(files) {
  let n = 0;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    await tx("readwrite", (s) => s.put(f, f.name)); n++;
  }
  return n;
}

export async function deleteCoupon(c) {
  if (c.builtin) setHidden([...new Set([...hidden(), c.name])]);
  else await tx("readwrite", (s) => s.delete(c.name));
}

let lastCoupon = null;
export async function pickCoupon(list) {
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((c) => c.name !== lastCoupon) : list;
  const c = pool[Math.floor(Math.random() * pool.length)];
  lastCoupon = c.name;
  const img = new Image(); img.src = c.url; await img.decode();
  return { img, name: c.name };
}
