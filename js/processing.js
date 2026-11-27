// Image pipeline - runs entirely in the browser (OpenCV.js + MediaPipe + ONNX Runtime Web).
//   analyze()  : load photo, person mask (background model), face landmarks, auto-orient
//   prepare()  : blemish fix, airbrush, dark-skin exposure, white background, heal/inpaint
//   render()   : straighten, scale + crop to the selected document spec, tone adjustments
import { FaceLandmarker, FilesetResolver } from "../vendor/mediapipe/vision_bundle.mjs";
import * as ort from "../vendor/ort/ort.wasm.min.mjs";

export const DPI = 300;
const MAX_SIDE = 2000;
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_B = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const BROW_A = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
const BROW_B = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const NOSTRILS = [48, 64, 98, 97, 2, 326, 327, 294, 278, 219, 439];
const CHIN = 152, FOREHEAD = 10, NOSE_TIP = 1;
const IRIS_A = [468, 469, 470, 471, 472], IRIS_B = [473, 474, 475, 476, 477];

export class PhotoError extends Error {}

// ------------------------------------------------------------------ model loading
let cv = null, landmarker = null, segSession = null;
const base = new URL("../", import.meta.url).href;

// NB: the OpenCV.js module object is "thenable" - never return/await it directly or the promise
// machinery keeps re-resolving it forever. Assign it to the module variable instead.
async function waitForCv() {
  for (let i = 0; i < 900; i++) {
    const c = window.cv;
    if (c && c.Mat && c.inpaint) { cv = c; return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new PhotoError("Image library failed to load - reload the page.");
}

export async function loadModels(progress = () => {}) {
  if (cv && landmarker && segSession) return;
  progress("Loading image tools…");
  await waitForCv();
  progress("Loading face model…");
  const fileset = await FilesetResolver.forVisionTasks(base + "vendor/mediapipe/wasm");
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + "models/face_landmarker.task", delegate: "CPU" },
    runningMode: "IMAGE", numFaces: 2, minFaceDetectionConfidence: 0.4,
  });
  progress("Loading background model…");
  ort.env.wasm.wasmPaths = base + "vendor/ort/";
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  // the model is stored in 3 parts (< 25 MB each, so it can be uploaded through GitHub's website)
  const parts = await Promise.all([0, 1, 2].map(async (i) => {
    const r = await fetch(base + `models/u2net_human_seg_q8.onnx.part${i}`);
    if (!r.ok) throw new PhotoError("Background model file missing - check the models folder was uploaded.");
    return new Uint8Array(await r.arrayBuffer());
  }));
  const model = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((off, p) => { model.set(p, off); return off + p.length; }, 0);
  segSession = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  progress("");
}

// ------------------------------------------------------------------ small helpers
function tracker() {
  const list = [];
  const t = (m) => { list.push(m); return m; };
  t.free = () => { for (const m of list) { try { m.delete(); } catch { /* already freed */ } } list.length = 0; };
  return t;
}
const oddK = (v, lo = 3, hi = 255) => { let k = Math.max(lo, Math.min(hi, Math.round(v))); return k % 2 ? k : k + 1; };

export function matToCanvas(mat, canvas = document.createElement("canvas")) { cv.imshow(canvas, mat); return canvas; }

function canvasToRgbMat(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const rgb = new cv.Mat(); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB); rgba.delete();
  return rgb;
}

async function fileToCanvas(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
  catch { throw new PhotoError("Could not read this image. Use JPG or PNG (iPhone HEIC: export as JPG)."); }
  const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return c;
}

// ------------------------------------------------------------------ segmentation (u2net_human_seg)
async function personMask(rgb) {
  const t = tracker();
  const S = 320;
  const small = t(new cv.Mat()); cv.resize(rgb, small, new cv.Size(S, S), 0, 0, cv.INTER_AREA);
  const d = small.data; let mx = 0; for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i];
  mx = mx || 1;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const x = new Float32Array(3 * S * S);
  for (let i = 0, p = 0; i < S * S; i++, p += 3)
    for (let c = 0; c < 3; c++) x[c * S * S + i] = (d[p + c] / mx - mean[c]) / std[c];
  const feeds = { [segSession.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, S, S]) };
  const out = await segSession.run(feeds);
  const pred = out[segSession.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S * S; i++) { if (pred[i] < lo) lo = pred[i]; if (pred[i] > hi) hi = pred[i]; }
  const m = t(new cv.Mat(S, S, cv.CV_8UC1));
  for (let i = 0; i < S * S; i++) m.data[i] = Math.round(((pred[i] - lo) / (hi - lo || 1)) * 255);
  const alpha = new cv.Mat(); cv.resize(m, alpha, new cv.Size(rgb.cols, rgb.rows), 0, 0, cv.INTER_LANCZOS4);
  t.free();
  return cleanAlpha(alpha);
}

function cleanAlpha(a) {
  // keep the largest blob (the person), drop stray specks
  const t = tracker();
  const bin = t(new cv.Mat()); cv.threshold(a, bin, 127, 255, cv.THRESH_BINARY);
  const lab = t(new cv.Mat()), stats = t(new cv.Mat()), cent = t(new cv.Mat());
  const n = cv.connectedComponentsWithStats(bin, lab, stats, cent, 8, cv.CV_32S);
  if (n > 2) {
    let keep = 1, best = 0;
    for (let i = 1; i < n; i++) { const ar = stats.intAt(i, cv.CC_STAT_AREA); if (ar > best) { best = ar; keep = i; } }
    const blob = t(new cv.Mat(a.rows, a.cols, cv.CV_8UC1));
    const L = lab.data32S; for (let i = 0; i < L.length; i++) blob.data[i] = L[i] === keep ? 255 : 0;
    const k = t(cv.Mat.ones(15, 15, cv.CV_8U)); cv.dilate(blob, blob, k);
    for (let i = 0; i < a.data.length; i++) if (!blob.data[i]) a.data[i] = 0;
  }
  t.free();
  return a;
}

// Run the model again on a crop around the head and shoulders: ~3x more detail where it matters
// (hair, ears, face edge), then blend it into the full mask with a soft border.
async function headPass(rgb, alpha, lm, faceW) {
  const ys = lm.map((p) => p[1]), xs = lm.map((p) => p[0]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const x0 = Math.max(0, Math.round(cx - faceW * 1.1)), x1 = Math.min(rgb.cols, Math.round(cx + faceW * 1.1));
  const y0 = Math.max(0, Math.round(Math.min(...ys) - faceW * 0.9)), y1 = Math.min(rgb.rows, Math.round(Math.max(...ys) + faceW * 0.7));
  const w = x1 - x0, h = y1 - y0;
  if (w < 64 || h < 64 || w * h > rgb.cols * rgb.rows * 0.8) return;   // crop would not add detail
  const crop = rgb.roi(new cv.Rect(x0, y0, w, h)).clone();
  const m = await personMask(crop); crop.delete();
  // blend weight: 1 inside, fading to 0 over the last 12% of the crop (unless the crop touches the photo edge)
  const fx = w * 0.12, fy = h * 0.12, A = alpha.data, M = m.data, W = alpha.cols;
  for (let y = 0; y < h; y++) {
    const wy = Math.min(1, (y0 === 0 ? 1e9 : y) / fy, (y1 === rgb.rows ? 1e9 : h - 1 - y) / fy);
    for (let x = 0; x < w; x++) {
      const wt = Math.min(wy, (x0 === 0 ? 1e9 : x) / fx, (x1 === rgb.cols ? 1e9 : w - 1 - x) / fx);
      if (wt <= 0) continue;
      const i = (y + y0) * W + x + x0;
      A[i] = Math.round(A[i] * (1 - wt) + M[y * w + x] * wt);
    }
  }
  m.delete();
}

/** manual background brush: edits = [{mask (source space), mode: "erase"|"restore"}] applied over the auto mask */
export function applyAlphaEdits(a, edits) {
  a.alpha0.copyTo(a.alpha);
  const A = a.alpha.data;
  for (const { mask, mode } of edits) {
    const soft = new cv.Mat(); cv.GaussianBlur(mask, soft, new cv.Size(0, 0), 1.2);
    const S = soft.data;
    for (let i = 0; i < A.length; i++) {
      const w = S[i] / 255; if (!w) continue;
      A[i] = Math.round(mode === "erase" ? A[i] * (1 - w) : A[i] + (255 - A[i]) * w);
    }
    soft.delete();
  }
  a.crownCache.clear();
}

// Snap the (low-res, blurry) model mask to real edges in the full photo with a fast guided filter,
// then make it fully solid inside the person and fully clear well outside.
function refineAlpha(rgb, alpha) {
  const t = tracker();
  const W = rgb.cols, H = rgb.rows, s = Math.min(1, 900 / Math.max(W, H));
  const sw = Math.max(1, Math.round(W * s)), sh = Math.max(1, Math.round(H * s));
  const grayF = t(new cv.Mat()); { const g = t(new cv.Mat()); cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY); g.convertTo(grayF, cv.CV_32F, 1 / 255); }
  const aF = t(new cv.Mat()); alpha.convertTo(aF, cv.CV_32F, 1 / 255);
  const I = t(new cv.Mat()), Pm = t(new cv.Mat());
  cv.resize(grayF, I, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA); cv.resize(aF, Pm, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const r = Math.max(3, Math.round(Math.max(sw, sh) * 0.008)), ks = new cv.Size(2 * r + 1, 2 * r + 1), eps = 1e-3;
  const box = (src) => { const d = t(new cv.Mat()); cv.boxFilter(src, d, -1, ks); return d; };
  const mul = (x, y) => { const d = t(new cv.Mat()); cv.multiply(x, y, d); return d; };
  const mI = box(I), mP = box(Pm), mIP = box(mul(I, Pm)), mII = box(mul(I, I));
  const A = t(new cv.Mat(sh, sw, cv.CV_32F)), Bm = t(new cv.Mat(sh, sw, cv.CV_32F));
  for (let i = 0; i < sw * sh; i++) {
    const mi = mI.data32F[i], varI = mII.data32F[i] - mi * mi, cov = mIP.data32F[i] - mi * mP.data32F[i];
    const a = cov / (varI + eps); A.data32F[i] = a; Bm.data32F[i] = mP.data32F[i] - a * mi;
  }
  const mA = box(A), mB = box(Bm);
  const fA = t(new cv.Mat()), fB = t(new cv.Mat());
  cv.resize(mA, fA, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); cv.resize(mB, fB, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  // solid core / clear outside, from the model mask
  const bin = t(new cv.Mat()); cv.threshold(alpha, bin, 127, 255, cv.THRESH_BINARY);
  const kk = Math.max(5, Math.round(Math.max(W, H) * 0.02)) | 1;
  const se = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kk, kk)));
  const core = t(new cv.Mat()), reach = t(new cv.Mat()); cv.erode(bin, core, se); cv.dilate(bin, reach, se);
  const out = new cv.Mat(H, W, cv.CV_8UC1);
  for (let i = 0; i < W * H; i++) {
    let q = fA.data32F[i] * grayF.data32F[i] + fB.data32F[i];
    q = (q - 0.1) / 0.8;                              // stretch: faint haze -> 0, near-solid -> 1
    if (core.data[i]) q = 1; else if (!reach.data[i]) q = 0;
    out.data[i] = q <= 0 ? 0 : q >= 1 ? 255 : Math.round(q * 255);
  }
  alpha.delete(); t.free();
  return out;
}

// Smooth estimate of what the background looked like behind every pixel (from nearby background pixels)
function estimateBackground(rgb, alpha, coarseOnly = false) {
  const t = tracker();
  const W = rgb.cols, H = rgb.rows, s = Math.min(1, 360 / Math.max(W, H));
  const sw = Math.max(1, Math.round(W * s)), sh = Math.max(1, Math.round(H * s));
  const small = t(new cv.Mat()), as = t(new cv.Mat());
  cv.resize(rgb, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA); cv.resize(alpha, as, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const num = t(new cv.Mat(sh, sw, cv.CV_32FC3)), den = t(new cv.Mat(sh, sw, cv.CV_32F));
  let gr = 0, gg = 0, gb = 0, gn = 0;
  for (let i = 0, p = 0; i < sw * sh; i++, p += 3) {
    const u = 1 - as.data[i] / 255, w = u * u * u * u;          // only trust clear background
    den.data32F[i] = w;
    for (let c = 0; c < 3; c++) num.data32F[p + c] = small.data[p + c] * w;
    if (w > 0.9) { gr += small.data[p]; gg += small.data[p + 1]; gb += small.data[p + 2]; gn++; }
  }
  // two scales: a close-range estimate (follows shadows on the wall right up to the outline) wherever enough
  // wall is nearby, and a wide one elsewhere; average background far inside the person.
  const blur = (sig) => { const nB = t(new cv.Mat()), dB = t(new cv.Mat());
    cv.GaussianBlur(num, nB, new cv.Size(0, 0), sig); cv.GaussianBlur(den, dB, new cv.Size(0, 0), sig); return [nB, dB]; };
  const [nF, dF] = blur(Math.max(1.5, Math.max(sw, sh) * 0.012));
  const [nC, dC] = blur(Math.max(3, Math.max(sw, sh) * 0.05));
  const g = gn ? [gr / gn, gg / gn, gb / gn] : [255, 255, 255];
  const est = t(new cv.Mat(sh, sw, cv.CV_8UC3));
  for (let i = 0, p = 0; i < sw * sh; i++, p += 3) {
    const df = dF.data32F[i], dc = dC.data32F[i];
    const kf = coarseOnly ? 0 : Math.min(1, df / 0.08), kc = Math.min(1, dc / 0.02);
    for (let c = 0; c < 3; c++) {
      const coarse = dc > 1e-6 ? (nC.data32F[p + c] / dc) * kc + g[c] * (1 - kc) : g[c];
      const fine = df > 1e-6 ? nF.data32F[p + c] / df : coarse;
      est.data[p + c] = Math.round(fine * kf + coarse * (1 - kf));
    }
  }
  const full = new cv.Mat(); cv.resize(est, full, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  t.free();
  return full;
}

// Pixels near the outline whose colour matches the background behind them are background: clear them.
// Covers soft edges and pockets of wall showing between curls / under clips that the model counted as person.
function cleanEdgeAlpha(rgb, alpha, bgEst) {
  const t = tracker();
  const W = rgb.cols, H = rgb.rows;
  const bin = t(new cv.Mat()); cv.threshold(alpha, bin, 127, 255, cv.THRESH_BINARY);
  const k = Math.max(7, Math.round(Math.max(W, H) * 0.06)) | 1;
  const se = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const deep = t(new cv.Mat()); cv.erode(bin, deep, se);
  const D = rgb.data, B = bgEst.data, A = alpha.data, DP = deep.data;
  for (let i = 0, p = 0; i < A.length; i++, p += 3) {
    const a = A[i]; if (a === 0 || DP[i]) continue;
    const d = Math.hypot(D[p] - B[p], D[p + 1] - B[p + 1], D[p + 2] - B[p + 2]);
    if (d < 34) A[i] = Math.round(a * Math.max(0, (d - 10) / 24));
  }
  // choke: pull the outline in ~1-2 px so no rim of the old background survives
  const iters = Math.max(1, Math.round(Math.max(W, H) / 1000));
  const k3 = t(cv.Mat.ones(3, 3, cv.CV_8U));
  cv.erode(alpha, alpha, k3, new cv.Point(-1, -1), iters);
  // tidy: drop specks left floating in the background
  const cleaned = cleanAlpha(alpha);
  t.free();
  return cleaned;
}

// Shadows cast on the wall next to the person: same colour as the wall, just darker, smooth (no texture),
// and they fade SOFTLY into the lit wall. Hair has texture; shoulders, clothes and hair edges meet the wall
// with a SHARP edge. Only patches that pass all of these tests are cleared - never the face.
function removeShadows(rgb, alpha, bgEst, lm, faceW) {
  const t = tracker();
  const W = rgb.cols, H = rgb.rows, N = W * H, D = rgb.data, B = bgEst.data, A = alpha.data;
  // luminance, its local texture and edge strength
  const Y = t(new cv.Mat(H, W, cv.CV_32F)), Yb = t(new cv.Mat(H, W, cv.CV_32F));
  for (let i = 0, p = 0; i < N; i++, p += 3) { Y.data32F[i] = 0.299 * D[p] + 0.587 * D[p + 1] + 0.114 * D[p + 2]; Yb.data32F[i] = 0.299 * B[p] + 0.587 * B[p + 1] + 0.114 * B[p + 2]; }
  const Ys = t(new cv.Mat()); cv.GaussianBlur(Y, Ys, new cv.Size(0, 0), 1.2);
  const k = 7, ks = new cv.Size(k, k);
  const m1 = t(new cv.Mat()), m2 = t(new cv.Mat()), Y2 = t(new cv.Mat()); cv.multiply(Y, Y, Y2);
  cv.boxFilter(Y, m1, -1, ks); cv.boxFilter(Y2, m2, -1, ks);
  const gx = t(new cv.Mat()), gy = t(new cv.Mat()); cv.Sobel(Ys, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(Ys, gy, cv.CV_32F, 0, 1, 3);
  // protect the face (and a margin around it)
  const face = t(cv.Mat.zeros(H, W, cv.CV_8UC1));
  fillPolys(face, [FACE_OVAL.map((i) => lm[i])], 255);
  const kd = Math.max(5, Math.round(faceW * 0.25)) | 1;
  const sef = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kd, kd))); cv.dilate(face, face, sef);
  // shadow candidates
  const cand = t(cv.Mat.zeros(H, W, cv.CV_8UC1)), C = cand.data;
  for (let i = 0, p = 0; i < N; i++, p += 3) {
    if (A[i] === 0 || face.data[i]) continue;
    const y = Y.data32F[i], yb = Yb.data32F[i]; if (yb < 40) continue;
    const ratio = y / yb; if (ratio < 0.35 || ratio > 0.97) continue;              // darker than the wall, not black
    const s1 = D[p] + D[p + 1] + D[p + 2] + 1, s2 = B[p] + B[p + 1] + B[p + 2] + 1;
    const dc = Math.abs(D[p] / s1 - B[p] / s2) + Math.abs(D[p + 1] / s1 - B[p + 1] / s2) + Math.abs(D[p + 2] / s1 - B[p + 2] / s2);
    if (dc > 0.06) continue;                                                       // same colour as the wall
    const mu = m1.data32F[i], sd = Math.sqrt(Math.max(0, m2.data32F[i] - mu * mu));
    if (sd > 10) continue;                                                         // smooth (hair is textured)
    C[i] = 255;
  }
  const labs = t(new cv.Mat()), stats = t(new cv.Mat()), cent = t(new cv.Mat());
  const n = cv.connectedComponentsWithStats(cand, labs, stats, cent, 8, cv.CV_32S);
  if (n > 1) {
    // per patch: how much of its outline touches clear background, and how sharp that boundary is
    const touch = new Float64Array(n), gsum = new Float64Array(n), border = new Float64Array(n);
    const L = labs.data32S;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, l = L[i]; if (!l) continue;
      let edge = false, bgN = false;
      for (const j of [i - 1, i + 1, i - W, i + W]) if (L[j] !== l) { edge = true; if (A[j] < 30) bgN = true; }
      if (!edge) continue;
      border[l]++;
      if (bgN) { touch[l]++; gsum[l] += Math.hypot(gx.data32F[i], gy.data32F[i]); }
    }
    const minA = Math.max(20, (faceW * 0.02) ** 2), keep = new Uint8Array(n);
    for (let l = 1; l < n; l++) {
      if (stats.intAt(l, cv.CC_STAT_AREA) < minA || touch[l] < 8) continue;
      const frac = touch[l] / border[l], g = gsum[l] / touch[l];
      if (frac >= 0.12 && g < 18) keep[l] = 1;                                     // attached to the wall, soft edge
    }
    let any = false;
    const sh = t(cv.Mat.zeros(H, W, cv.CV_8UC1));
    for (let i = 0; i < N; i++) if (keep[L[i]]) { sh.data[i] = 255; any = true; }
    if (any) {
      cv.GaussianBlur(sh, sh, new cv.Size(0, 0), 1.5);
      for (let i = 0; i < N; i++) if (sh.data[i]) A[i] = Math.round(A[i] * (1 - sh.data[i] / 255));
      // bgEst under a removed shadow: use the shadowed wall itself so the white fill is clean
    }
  }
  t.free();
  return alpha;
}

// The last few pixels of the outline: anything that is the wall's colour but darker than the lit wall is
// shadow on the wall (skin has a different colour; dark hair/beard is far darker than a shadow) -> clear it.
function shadowRim(rgb, alpha) {
  const t = tracker();
  const W = rgb.cols, H = rgb.rows, N = W * H, D = rgb.data, A = alpha.data;
  const lit = t(estimateBackground(rgb, alpha, true)), L = lit.data;            // the wall as if fully lit
  const bg = t(new cv.Mat(H, W, cv.CV_8UC1));
  for (let i = 0; i < N; i++) bg.data[i] = A[i] < 30 ? 255 : 0;
  const R = Math.max(3, Math.round(Math.max(W, H) * 0.005)) * 2 + 1;
  const se = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(R, R)));
  const near = t(new cv.Mat()); cv.dilate(bg, near, se);
  for (let i = 0, p = 0; i < N; i++, p += 3) {
    if (!A[i] || !near.data[i]) continue;
    const y = 0.299 * D[p] + 0.587 * D[p + 1] + 0.114 * D[p + 2], yl = 0.299 * L[p] + 0.587 * L[p + 1] + 0.114 * L[p + 2];
    if (yl < 60) continue;
    const ratio = y / yl; if (ratio < 0.45 || ratio > 1.02) continue;
    const s1 = D[p] + D[p + 1] + D[p + 2] + 1, s2 = L[p] + L[p + 1] + L[p + 2] + 1;
    const dc = Math.abs(D[p] / s1 - L[p] / s2) + Math.abs(D[p + 1] / s1 - L[p + 1] / s2) + Math.abs(D[p + 2] / s1 - L[p + 2] / s2);
    if (dc >= 0.06) continue;
    A[i] = Math.round(A[i] * Math.min(1, Math.max(0, (dc - 0.02) / 0.04)));   // wall-coloured -> background
  }
  t.free();
  return cleanAlpha(alpha);
}

function bodyEdge(alpha) {
  // number of 90deg clockwise turns so the shoulders (widest mask part) sit at the bottom
  const h = alpha.rows, w = alpha.cols, A = alpha.data, bh = Math.max(1, h >> 3), bw = Math.max(1, w >> 3);
  const cov = (y0, y1, x0, x1) => { let c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c += A[y * w + x] > 127; return c / ((y1 - y0) * (x1 - x0)); };
  const c = { 0: cov(h - bh, h, 0, w), 2: cov(0, bh, 0, w), 1: cov(0, h, 0, bw), 3: cov(0, h, w - bw, w) };
  let best = 0; for (const k of [1, 2, 3]) if (c[k] > c[best]) best = k;
  return best !== 0 && c[best] > c[0] + 0.25 ? best : 0;
}

function rotateQuarter(mat, k) {
  if (!k) return mat;
  const out = new cv.Mat();
  cv.rotate(mat, out, k === 1 ? cv.ROTATE_90_CLOCKWISE : k === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE);
  mat.delete(); return out;
}

function detectLandmarks(rgb) {
  const canvas = matToCanvas(rgb);
  const res = landmarker.detect(canvas);
  if (!res.faceLandmarks || !res.faceLandmarks.length) throw new PhotoError("No face detected. Use a clear, front-facing photo.");
  const faces = res.faceLandmarks.map((f) => f.map((p) => [p.x * rgb.cols, p.y * rgb.rows]));
  const span = (f) => { const xs = f.map((p) => p[0]), ys = f.map((p) => p[1]); return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); };
  faces.sort((a, b) => span(b) - span(a));
  return { lm: faces[0], n: faces.length };
}

// ------------------------------------------------------------------ stage 1
export async function analyze(blob, quarterTurns = null) {
  const canvas = await fileToCanvas(blob);
  let rgb = canvasToRgbMat(canvas);
  let alpha = await personMask(rgb);
  const k = quarterTurns === null ? bodyEdge(alpha) : ((quarterTurns % 4) + 4) % 4;
  rgb = rotateQuarter(rgb, k); alpha = rotateQuarter(alpha, k);
  let found;
  try { found = detectLandmarks(rgb); } catch (e) { rgb.delete(); alpha.delete(); throw e; }
  const { lm, n } = found;
  const xs = FACE_OVAL.map((i) => lm[i][0]);
  const faceW = Math.max(...xs) - Math.min(...xs);
  await headPass(rgb, alpha, lm, faceW);          // second, close-up pass for hair and head edges
  alpha = refineAlpha(rgb, alpha);
  const bgEst = estimateBackground(rgb, alpha);
  alpha = cleanEdgeAlpha(rgb, alpha, bgEst);
  alpha = removeShadows(rgb, alpha, bgEst, lm, faceW);
  alpha = shadowRim(rgb, alpha);
  const warnings = [];
  if (k && quarterTurns === null) warnings.push(`Photo was sideways/upside-down - auto-rotated ${k * 90}°.`);
  if (n > 1) warnings.push("More than one face found - using the largest one.");
  if (faceW < 180) warnings.push("Face is small in this photo; print quality may be low. Move the camera closer.");
  return { rgb, alpha, alpha0: alpha.clone(), bgEst, lm, faceW, warnings, quarterTurns: k, crownCache: new Map() };
}

export function freeAnalysis(a) {
  if (!a) return;
  a.rgb.delete(); a.alpha.delete(); a.alpha0.delete(); a.bgEst.delete(); if (a.skin) a.skin.delete();
  if (a.blemishBase) Object.values(a.blemishBase).forEach((m) => m.delete());
}

// ------------------------------------------------------------------ stage 2: retouch
function faceRoi(a) {
  const xs = a.lm.map((p) => p[0]), ys = a.lm.map((p) => p[1]);
  const pad = a.faceW * 0.15;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(a.rgb.cols, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(a.rgb.rows, Math.ceil(Math.max(...ys) + pad));
  return new cv.Rect(x0, y0, x1 - x0, y1 - y0);
}

function polyMat(points) { return cv.matFromArray(points.length, 1, cv.CV_32SC2, points.flatMap((p) => [Math.round(p[0]), Math.round(p[1])])); }

function fillPolys(mask, polys, val) {
  const mv = new cv.MatVector(); const mats = polys.map(polyMat); mats.forEach((m) => mv.push_back(m));
  cv.fillPoly(mask, mv, new cv.Scalar(val)); mats.forEach((m) => m.delete()); mv.delete();
}

function hull(points) {
  const m = polyMat(points), h = new cv.Mat(); cv.convexHull(m, h, false, true);
  const pts = []; for (let i = 0; i < h.rows; i++) pts.push([h.data32S[i * 2], h.data32S[i * 2 + 1]]);
  m.delete(); h.delete(); return pts;
}

// skin mask for the face ROI (ROI coordinates); texture gate keeps beards and hair out
function skinMask(a, roi, roiRgb) {
  const t = tracker();
  const off = (idx) => idx.map((i) => [a.lm[i][0] - roi.x, a.lm[i][1] - roi.y]);
  const m = cv.Mat.zeros(roi.height, roi.width, cv.CV_8UC1);
  fillPolys(m, [off(FACE_OVAL)], 255);
  const holes = t(cv.Mat.zeros(roi.height, roi.width, cv.CV_8UC1));
  fillPolys(holes, [EYE_A, EYE_B, BROW_A, BROW_B, LIPS, NOSTRILS].map((g) => hull(off(g))), 255);
  const k = oddK(a.faceW * 0.035);
  const se = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  cv.dilate(holes, holes, se);
  for (let i = 0; i < m.data.length; i++) if (holes.data[i]) m.data[i] = 0;
  cv.erode(m, m, se);
  // texture gate (computed at reduced resolution - it is a smooth map anyway)
  const sc = Math.min(1, 300 / a.faceW);
  const sw = Math.max(1, Math.round(roi.width * sc)), shh = Math.max(1, Math.round(roi.height * sc));
  const small = t(new cv.Mat()); cv.resize(roiRgb, small, new cv.Size(sw, shh), 0, 0, cv.INTER_AREA);
  const gray = t(new cv.Mat()); cv.cvtColor(small, gray, cv.COLOR_RGB2GRAY);
  const L = t(new cv.Mat()); gray.convertTo(L, cv.CV_32F);
  const Lb = t(new cv.Mat()); cv.GaussianBlur(L, Lb, new cv.Size(0, 0), Math.max(1, 2.0 * sc));
  const hp2 = t(new cv.Mat(L.rows, L.cols, cv.CV_32F));
  for (let i = 0; i < hp2.data32F.length; i++) { const v = L.data32F[i] - Lb.data32F[i]; hp2.data32F[i] = v * v; }
  const texS = t(new cv.Mat()); cv.GaussianBlur(hp2, texS, new cv.Size(0, 0), Math.max(1.5, (a.faceW / 40) * sc));
  const tex = t(new cv.Mat()); cv.resize(texS, tex, new cv.Size(roi.width, roi.height), 0, 0, cv.INTER_LINEAR);
  const inside = []; for (let i = 0; i < m.data.length; i += 7) if (m.data[i]) inside.push(Math.sqrt(tex.data32F[i]));
  if (inside.length) {
    inside.sort((x, y) => x - y);
    const ref = inside[Math.floor(inside.length * 0.3)], hi = ref * 2.4, span = Math.max(ref * 1.2, 1e-3);
    const T = tex.data32F, D = m.data;
    for (let i = 0; i < D.length; i++) {
      if (!D[i]) continue;
      const g = (hi - Math.sqrt(T[i])) / span;
      D[i] = g >= 1 ? D[i] : g <= 0 ? 0 : Math.round(D[i] * g);
    }
  }
  cv.GaussianBlur(m, m, new cv.Size(0, 0), Math.max(1.5, a.faceW * 0.02));
  t.free();
  return m;
}

// local "background" of L (lightness) and A (redness) - median at reduced resolution, cached per photo
function blemishBase(a, img) {
  if (a.blemishBase) return a.blemishBase;
  const t = tracker();
  const lab = t(new cv.Mat()); cv.cvtColor(img, lab, cv.COLOR_RGB2Lab);
  const ch = t(new cv.MatVector()); cv.split(lab, ch);
  const L = ch.get(0), A = ch.get(1); t(ch.get(2));
  const sc = Math.min(1, 300 / a.faceW), size = new cv.Size(Math.max(1, Math.round(img.cols * sc)), Math.max(1, Math.round(img.rows * sc)));
  const k = oddK((a.faceW / 14) * sc, 5, 41);
  const med = (src) => {
    const sm = t(new cv.Mat()), md = t(new cv.Mat()), up = new cv.Mat();
    cv.resize(src, sm, size, 0, 0, cv.INTER_AREA); cv.medianBlur(sm, md, k);
    cv.resize(md, up, new cv.Size(img.cols, img.rows), 0, 0, cv.INTER_LINEAR); return up;
  };
  a.blemishBase = { L, A, Lm: med(L), Am: med(A) };
  t.free();
  return a.blemishBase;
}

function fixBlemishes(a, img, smask, strength) {
  if (strength <= 0) return;
  const faceW = a.faceW;
  const t = tracker();
  const { L, A, Lm, Am } = blemishBase(a, img);
  const thrD = 22 - 12 * strength, thrR = 12 - 6 * strength;
  const cand = t(new cv.Mat(L.rows, L.cols, cv.CV_8UC1));
  for (let i = 0; i < cand.data.length; i++)
    cand.data[i] = smask.data[i] > 160 && ((Lm.data[i] - L.data[i] > thrD) || (A.data[i] - Am.data[i] > thrR)) ? 255 : 0;
  const lab2 = t(new cv.Mat()), stats = t(new cv.Mat()), cent = t(new cv.Mat());
  const n = cv.connectedComponentsWithStats(cand, lab2, stats, cent, 8, cv.CV_32S);
  const maxArea = (faceW * (0.02 + 0.02 * strength)) ** 2;
  const keep = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const ar = stats.intAt(i, cv.CC_STAT_AREA), bw = stats.intAt(i, cv.CC_STAT_WIDTH), bh = stats.intAt(i, cv.CC_STAT_HEIGHT);
    keep[i] = ar >= 2 && ar <= maxArea && Math.max(bw, bh) < 3.5 * Math.max(1, Math.min(bw, bh)) ? 1 : 0;
  }
  const spots = t(new cv.Mat(L.rows, L.cols, cv.CV_8UC1)); let any = false;
  const lb = lab2.data32S; for (let i = 0; i < lb.length; i++) { const v = keep[lb[i]] ? 255 : 0; spots.data[i] = v; if (v) any = true; }
  if (any) {
    const se = t(cv.Mat.ones(5, 5, cv.CV_8U)); cv.dilate(spots, spots, se);
    const out = t(new cv.Mat()); cv.inpaint(img, spots, out, 5, cv.INPAINT_TELEA); out.copyTo(img);
  }
  t.free();
}

function airbrush(img, smask, faceW, strength) {
  if (strength <= 0) return;
  const t = tracker();
  // smooth at reduced resolution (fast in the browser); fine texture is added back from the original below
  const sc = Math.min(1, 320 / faceW);
  const sigmaS = Math.max(2, (faceW / 45) * sc);
  const small = t(new cv.Mat()); cv.resize(img, small, new cv.Size(Math.max(1, Math.round(img.cols * sc)), Math.max(1, Math.round(img.rows * sc))), 0, 0, cv.INTER_AREA);
  const sm2 = t(new cv.Mat()); cv.bilateralFilter(small, sm2, oddK(sigmaS * 2, 5, 15), 18 + 22 * strength, sigmaS, cv.BORDER_DEFAULT);
  const smooth = t(new cv.Mat()); cv.resize(sm2, smooth, new cv.Size(img.cols, img.rows), 0, 0, cv.INTER_LINEAR);
  const blur = t(new cv.Mat()); cv.GaussianBlur(img, blur, new cv.Size(0, 0), 0.8);
  const a = Math.min(1, strength * 1.4), D = img.data, S = smooth.data, B = blur.data, M = smask.data;
  for (let i = 0, p = 0; i < M.length; i++, p += 3) {
    const w = (M[i] / 255) * a; if (!w) continue;
    for (let c = 0; c < 3; c++) {
      const skin = S[p + c] + 0.6 * (D[p + c] - B[p + c]);        // keep fine grain so skin isn't plastic
      D[p + c] = Math.max(0, Math.min(255, Math.round(D[p + c] * (1 - w) + skin * w)));
    }
  }
  t.free();
}

function skinExposure(img, roi, smaskRoi, alpha, mode) {
  // gentle lift for darker skin so features read clearly, without washing out the tone.
  // Works on luma and scales R,G,B by the same gain, so hue and skin tone are preserved.
  if (mode === "off") return null;
  const t = tracker();
  const D = img.data, n = img.rows * img.cols, cols = img.cols;
  const Y = t(new cv.Mat(img.rows, cols, cv.CV_8UC1)), Yd = Y.data;
  for (let i = 0, p = 0; i < n; i++, p += 3) Yd[i] = (D[p] * 77 + D[p + 1] * 150 + D[p + 2] * 29) >> 8;
  const vals = [];
  for (let y = 0; y < roi.height; y += 2) for (let x = 0; x < roi.width; x += 2)
    if (smaskRoi.data[y * roi.width + x] > 128) vals.push(Yd[(y + roi.y) * cols + x + roi.x]);
  if (!vals.length) { t.free(); return null; }
  vals.sort((p, q) => p - q);
  const med = vals[vals.length >> 1];
  // thresholds in luma terms (dark-skin faces typically measure below ~105)
  if (mode === "auto" && med >= 105) { t.free(); return null; }
  const target = med < 120 ? med + Math.max(0, 120 - med) * 0.45 : med + 6;
  let gamma = Math.log(Math.max(target, 1) / 255) / Math.log(Math.max(med, 1) / 255);
  gamma = Math.min(1, Math.max(0.72, gamma));
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma) * 255;
  const Yg = t(new cv.Mat(img.rows, cols, cv.CV_8UC1));
  for (let i = 0; i < n; i++) Yg.data[i] = Math.min(255, Math.round(lut[Yd[i]]));
  const clahe = new cv.CLAHE(1.6, new cv.Size(8, 8)); const Yc = t(new cv.Mat()); clahe.apply(Yg, Yc); clahe.delete();
  const W = alpha.data;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const w = W[i] / 255; if (!w) continue;
    const y0 = Math.max(1, Yd[i]), ny = Yg.data[i] * 0.7 + Yc.data[i] * 0.3;
    const gain = 1 + (Math.min(3, ny / y0) - 1) * w;
    D[p] = Math.min(255, D[p] * gain); D[p + 1] = Math.min(255, D[p + 1] * gain); D[p + 2] = Math.min(255, D[p + 2] * gain);
  }
  t.free();
  return `Skin exposure lifted (face brightness ${Math.round(med)} → ~${Math.round(target)}).`;
}

/** returns {img (RGB mat, white bg), ext (extended img), extAlpha, notes}. Caller frees with freePrepared. */
const DEBUG = (() => { try { return localStorage.getItem("ppg.debug") === "1"; } catch { return false; } })();
let _t0 = 0; const lap = (n) => { if (!DEBUG) return; const t1 = performance.now(); if (n) console.log(`[ppg] ${n} ${Math.round(t1 - _t0)}ms`); _t0 = t1; };

export function prepare(a, s, healMask) {
  const t = tracker();
  const notes = []; lap();
  const img = a.rgb.clone();
  const roi = faceRoi(a);
  const roiImg = t(img.roi(roi));
  if (!a.skin) a.skin = skinMask(a, roi, roiImg);          // depends only on the photo: cache it
  const sm = a.skin; lap("skinMask");
  const work = t(roiImg.clone());
  fixBlemishes(a, work, sm, s.blemish); lap("blemish");
  airbrush(work, sm, a.faceW, s.airbrush); lap("airbrush");
  work.copyTo(roiImg);
  const note = skinExposure(img, roi, sm, a.alpha, s.darkSkin); lap("exposure");
  if (note) notes.push(note);
  if (s.removeBg) {
    // matting equation: pixel = a*person + (1-a)*background  ->  swap the background part for pure white.
    // This also removes the old background's colour from hair and edge pixels (no blue/green fringe).
    const D = img.data, A = a.alpha.data, B = a.bgEst.data;
    for (let i = 0, p = 0; i < A.length; i++, p += 3) {
      const al = A[i]; if (al === 255) continue;
      if (al === 0) { D[p] = D[p + 1] = D[p + 2] = 255; continue; }
      const u = 1 - al / 255;
      for (let c = 0; c < 3; c++) D[p + c] = Math.max(0, Math.min(255, D[p + c] + u * (255 - B[p + c])));
    }
  }
  if (healMask) {
    const out = t(new cv.Mat()); cv.inpaint(img, healMask, out, Math.max(3, Math.round(a.faceW / 60)), cv.INPAINT_TELEA); out.copyTo(img);
  }
  t.free(); lap("composite+heal");
  const { ext, extAlpha } = extendBody(img, a.alpha); lap("extendBody");
  return { img, ext, extAlpha, notes, removeBg: s.removeBg };
}
export function freePrepared(p) { if (!p) return; p.img.delete(); p.ext.delete(); p.extAlpha.delete(); }

function extendBody(img, alpha) {
  // pad below the image; each column whose clothing reaches the lower part of the frame is continued
  // straight down from its lowest person pixel (also handles tilted photos)
  const h = alpha.rows, w = alpha.cols, H2 = h * 2;
  const ext = new cv.Mat(H2, w, cv.CV_8UC3, new cv.Scalar(255, 255, 255));
  const extA = cv.Mat.zeros(H2, w, cv.CV_8UC1);
  img.copyTo(ext.roi(new cv.Rect(0, 0, w, h)));
  alpha.copyTo(extA.roi(new cv.Rect(0, 0, w, h)));
  const A = alpha.data, I = img.data, E = ext.data, EA = extA.data;
  const last = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (A[y * w + x] > 127) last[x] = y;
  const cols = []; for (let x = 0; x < w; x++) if (last[x] >= h * 0.8) cols.push(x);
  if (cols.length) {
    const colour = new Float32Array(w * 3), wt = new Float32Array(w);
    for (const x of cols) {
      const s = [[], [], []];
      for (let d = 4; d < 16; d += 2) { const y = Math.max(0, last[x] - d); for (let c = 0; c < 3; c++) s[c].push(I[(y * w + x) * 3 + c]); }
      for (let c = 0; c < 3; c++) { s[c].sort((p, q) => p - q); colour[x * 3 + c] = s[c][s[c].length >> 1]; }
      wt[x] = 1;
    }
    // smooth across columns
    const k = Math.max(3, Math.round(w * 0.02)) | 1, r = k >> 1;
    const sm = new Float32Array(w * 3), sw = new Float32Array(w);
    for (let x = 0; x < w; x++) for (let j = -r; j <= r; j++) {
      const xx = x + j; if (xx < 0 || xx >= w || !wt[xx]) continue;
      sw[x] += 1; for (let c = 0; c < 3; c++) sm[x * 3 + c] += colour[xx * 3 + c];
    }
    for (const x of cols) {
      const c0 = sm[x * 3] / sw[x], c1 = sm[x * 3 + 1] / sw[x], c2 = sm[x * 3 + 2] / sw[x];
      for (let y = Math.max(0, last[x] - 3); y < H2; y++) { const p = (y * w + x) * 3; E[p] = c0; E[p + 1] = c1; E[p + 2] = c2; EA[y * w + x] = 255; }
    }
  }
  return { ext, extAlpha: extA };
}

// ------------------------------------------------------------------ stage 3: geometry + crop
export const mm2px = (mm) => (mm / 25.4) * DPI;

function rotMatrix(cx, cy, angleDeg) {   // same as cv2.getRotationMatrix2D(center, angle, 1)
  const a = (angleDeg * Math.PI) / 180, al = Math.cos(a), be = Math.sin(a);
  return [[al, be, (1 - al) * cx - be * cy], [-be, al, be * cx + (1 - al) * cy]];
}
const apply = (M, p) => [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2]];
const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

function crownY(a, R, angle, cx, halfBand, foreheadY) {
  const key = angle.toFixed(2) + ":" + Math.round(cx);
  if (a.crownCache.has(key)) return a.crownCache.get(key);
  const t = tracker();
  const Rm = t(cv.matFromArray(2, 3, cv.CV_64F, R.flat()));
  const ar = t(new cv.Mat());
  cv.warpAffine(a.alpha, ar, Rm, new cv.Size(a.alpha.cols, a.alpha.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const w = ar.cols, x0 = Math.max(0, Math.floor(cx - halfBand)), x1 = Math.min(w, Math.floor(cx + halfBand));
  let row = -1;
  outer: for (let y = 0; y < ar.rows; y++) for (let x = x0; x < x1; x++) if (ar.data[y * w + x] > 127) { row = y; break outer; }
  t.free();
  const v = row >= 0 && row < foreheadY ? row : null;
  a.crownCache.set(key, v);
  return v;
}

export function computeTransform(a, spec, adj) {
  const W = Math.round(mm2px(spec.width_mm)), H = Math.round(mm2px(spec.height_mm));
  const el = mean(IRIS_A.map((i) => a.lm[i])), er = mean(IRIS_B.map((i) => a.lm[i]));
  const roll = adj.auto_straighten ? (Math.atan2(er[1] - el[1], er[0] - el[0]) * 180) / Math.PI : 0;
  const angle = roll - adj.rotate;
  const R = rotMatrix((el[0] + er[0]) / 2, (el[1] + er[1]) / 2, angle);
  const lmR = a.lm.map((p) => apply(R, p));
  const chinY = lmR[CHIN][1];
  const ovalX = FACE_OVAL.map((i) => lmR[i][0]); const xl = Math.min(...ovalX), xr = Math.max(...ovalX), cx = (xl + xr) / 2;
  const foreheadY = lmR[FOREHEAD][1];
  const est = foreheadY - 0.28 * (chinY - foreheadY);
  let crown = crownY(a, R, angle, cx, (xr - xl) * 0.3, foreheadY);
  if (crown === null) crown = est;
  const crownCut = crown <= 1;
  if (crownCut) crown = Math.min(crown, est);
  const headSrc = chinY - crown;
  const headTarget = (spec.head_min_mm + spec.head_max_mm) / 2;
  const s = (mm2px(headTarget) / headSrc) * adj.zoom;
  const eyeSrcY = (mean(IRIS_A.map((i) => lmR[i]))[1] + mean(IRIS_B.map((i) => lmR[i]))[1]) / 2;
  let ty;
  if (spec.eye_min_mm != null) ty = H - mm2px((spec.eye_min_mm + spec.eye_max_mm) / 2) - s * eyeSrcY;
  else ty = (H - s * headSrc) * 0.42 - s * crown;     // a little more room under the chin than above the hair
  let tx = W / 2 - s * cx;
  tx += (adj.shift_x / 100) * W; ty += (adj.shift_y / 100) * H;
  const M = [[s * R[0][0], s * R[0][1], s * R[0][2] + tx], [s * R[1][0], s * R[1][1], s * R[1][2] + ty]];
  const px2mm = 25.4 / DPI;
  const crownO = s * crown + ty, chinO = s * chinY + ty, eyeO = s * eyeSrcY + ty;
  const headMm = (chinO - crownO) * px2mm, eyeMm = (H - eyeO) * px2mm;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    M, W, H,
    meas: {
      head_mm: r1(headMm), eye_mm: r1(eyeMm),
      head_ok: spec.head_min_mm - 0.3 <= headMm && headMm <= spec.head_max_mm + 0.3,
      eye_ok: spec.eye_min_mm == null ? null : spec.eye_min_mm - 0.3 <= eyeMm && eyeMm <= spec.eye_max_mm + 0.3,
      crown_px: crownO, chin_px: chinO, eye_px: eyeO,
      auto_rotation: r1(roll), head_turn: (lmR[NOSE_TIP][0] - cx) / Math.max(1, xr - xl), crown_cut: crownCut,
    },
  };
}

function tone(img, mask, adj) {
  const { brightness: b, contrast: c, saturation: sa, warmth: wa } = adj;
  if (!b && !c && !sa && !wa) return;
  const D = img.data, M = mask ? mask.data : null, k = 1 + c / 100, ks = 1 + sa / 100;
  for (let i = 0, p = 0; i < img.rows * img.cols; i++, p += 3) {
    const w = M ? M[i] / 255 : 1; if (!w) continue;
    let r = D[p], g = D[p + 1], bl = D[p + 2];
    r += b * 1.2; g += b * 1.2; bl += b * 1.2;
    r = (r - 128) * k + 128; g = (g - 128) * k + 128; bl = (bl - 128) * k + 128;
    if (sa) { const gr = (r + g + bl) / 3; r = gr + (r - gr) * ks; g = gr + (g - gr) * ks; bl = gr + (bl - gr) * ks; }
    r += wa * 0.35; bl -= wa * 0.35;
    const cl = (v) => Math.max(0, Math.min(255, v));
    D[p] = D[p] * (1 - w) + cl(r) * w; D[p + 1] = D[p + 1] * (1 - w) + cl(g) * w; D[p + 2] = D[p + 2] * (1 - w) + cl(bl) * w;
  }
}

/** returns {img: RGB mat (caller deletes), M, W, H, meas} */
export function render(a, prep, spec, adj) {
  const t = tracker();
  const { M, W, H, meas } = computeTransform(a, spec, adj);
  const Mm = t(cv.matFromArray(2, 3, cv.CV_64F, M.flat()));
  const out = new cv.Mat();
  let am = null;
  if (prep.removeBg) {
    cv.warpAffine(prep.ext, out, Mm, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    am = t(new cv.Mat()); cv.warpAffine(prep.extAlpha, am, Mm, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
  } else {
    cv.warpAffine(prep.img, out, Mm, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  }
  tone(out, am, adj);
  t.free();
  return { img: out, M, W, H, meas };
}

function invert(M) {
  const [[a, b, c], [d, e, f]] = M, det = a * e - b * d;
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}

/** brush strokes / boxes drawn on the output photo (0..1 coords) -> mask in source image space */
export function strokesToMask(a, M, W, H, strokes) {
  const Mi = invert(M), scale = Math.sqrt(Math.abs(Mi[0][0] * Mi[1][1] - Mi[0][1] * Mi[1][0]));
  const mask = cv.Mat.zeros(a.alpha.rows, a.alpha.cols, cv.CV_8UC1);
  const white = new cv.Scalar(255);
  for (const st of strokes) {
    if (st.type === "box") {
      const c = [[st.x0 * W, st.y0 * H], [st.x1 * W, st.y0 * H], [st.x1 * W, st.y1 * H], [st.x0 * W, st.y1 * H]].map((p) => apply(Mi, p));
      const ctr = mean(c);
      const ax = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) / 2, ay = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]) / 2;
      const ang = (Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI;
      cv.ellipse(mask, new cv.Point(Math.round(ctr[0]), Math.round(ctr[1])), new cv.Size(Math.max(1, Math.round(ax * 1.1)), Math.max(1, Math.round(ay * 1.1))), ang, 0, 360, white, -1);
    } else {
      const pts = st.points.map((p) => apply(Mi, [p[0] * W, p[1] * H]));
      const r = Math.max(1, Math.round((st.radius || 0.02) * W * scale));
      for (let i = 0; i < pts.length; i++) {
        const p = new cv.Point(Math.round(pts[i][0]), Math.round(pts[i][1]));
        cv.circle(mask, p, r, white, -1);
        if (i) cv.line(mask, new cv.Point(Math.round(pts[i - 1][0]), Math.round(pts[i - 1][1])), p, white, 2 * r, cv.LINE_AA);
      }
    }
  }
  return mask;
}

// ------------------------------------------------------------------ output helpers
export function setJpegDpi(buf, dpi = DPI) {
  // canvas JPEGs carry a JFIF header with 1:1 aspect only; write 300 dpi so printers use actual size
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255;
  }
  return b;
}

export async function canvasToJpeg(canvas, quality = 0.95) {
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  return new Blob([setJpegDpi(await blob.arrayBuffer())], { type: "image/jpeg" });
}

export function getCv() { return cv; }
