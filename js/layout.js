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
  return best(W, H).cells;
}

export const maxCopiesFor = (w, h) => pack(SHEET_W, SHEET_H, w, h).length;

function newSheet() {
  const c = document.createElement("canvas"); c.width = SHEET_W; c.height = SHEET_H;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, SHEET_W, SHEET_H);
  return { c, g };
}

function place(g, photo, cells, ox, oy, cutLines) {
  const w = photo.width, h = photo.height;
  g.lineWidth = 1; g.strokeStyle = CUT;
  for (const { x, y, rot } of cells) {
    if (rot) {   // head pointing left, like the reference sheets
      g.save(); g.translate(ox + x, oy + y + w); g.rotate(-Math.PI / 2); g.drawImage(photo, 0, 0); g.restore();
    } else g.drawImage(photo, ox + x, oy + y);
    if (cutLines) { const cw = rot ? h : w, ch = rot ? w : h; g.strokeRect(ox + x + 0.5, oy + y + 0.5, cw - 1, ch - 1); }
  }
}

/** photo: canvas at print size. returns {canvas, copies} */
export function maxCopiesSheet(photo, cutLines = true) {
  const cells = pack(SHEET_W, SHEET_H, photo.width, photo.height);
  if (!cells.length) throw new Error("Photo is larger than 4x6 paper.");
  const bw = Math.max(...cells.map((q) => q.x + (q.rot ? photo.height : photo.width)));
  const bh = Math.max(...cells.map((q) => q.y + (q.rot ? photo.width : photo.height)));
  const { c, g } = newSheet();
  place(g, photo, cells, Math.floor((SHEET_W - bw) / 2), Math.floor((SHEET_H - bh) / 2), cutLines);
  return { canvas: c, copies: cells.length };
}

/** 4 copies on top, coupon image (HTMLImageElement/ImageBitmap or null) underneath */
export function couponSheet(photo, coupon, copies = 4, cutLines = true) {
  const w = photo.width, h = photo.height;
  const cols = Math.min(copies, Math.max(1, Math.floor(SHEET_W / w))), rows = Math.ceil(copies / cols);
  if (cols * w > SHEET_W || rows * h > SHEET_H) throw new Error(`${copies} copies of this size do not fit on 4x6 paper.`);
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells.length < copies) cells.push({ x: c * w, y: r * h, rot: false });
  const { c, g } = newSheet();
  const ox = Math.floor((SHEET_W - cols * w) / 2);
  place(g, photo, cells, ox, 0, cutLines);
  if (!coupon) return { canvas: c, copies };
  const top = rows * h + 10, boxW = SHEET_W - 40, boxH = SHEET_H - 20 - top;
  if (boxH < 200) throw new Error("Not enough room for a coupon with this photo size - use the max-copies sheet.");
  let cw = coupon.width, chh = coupon.height, rotate = false;
  if (cw < chh && boxW >= boxH) { rotate = true; [cw, chh] = [chh, cw]; }
  const s = Math.min(boxW / cw, boxH / chh), dw = Math.round(cw * s), dh = Math.round(chh * s);
  const x = Math.round((SHEET_W - dw) / 2), y = Math.round(top + (boxH - dh) / 2);
  g.imageSmoothingQuality = "high";
  if (rotate) { g.save(); g.translate(x, y + dh); g.rotate(-Math.PI / 2); g.drawImage(coupon, 0, 0, dh, dw); g.restore(); }
  else g.drawImage(coupon, x, y, dw, dh);
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
