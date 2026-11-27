// UI controller - everything runs locally in the browser.
import * as P from "./processing.js";
import * as L from "./layout.js";
import * as AI from "./ai.js";
import * as Q from "./commands.js";

const $ = (id) => document.getElementById(id);
const MM = P.DPI / 25.4;
const ADJ = ["rotate", "zoom", "shift_x", "shift_y", "brightness", "contrast", "saturation", "warmth"];
const ADJ_DEFAULT = { rotate: 0, zoom: 1, shift_x: 0, shift_y: 0, brightness: 0, contrast: 0, saturation: 0, warmth: 0 };

const state = {
  ready: false, file: null, a: null, prep: null, prepKey: null, heal: [], alphaEdits: [], history: [], countries: [], spec: null,
  last: null,               // {canvas (print-size), M, W, H, meas, warnings}
  coupons: [],
};

// ---------------------------------------------------------------- helpers
function toast(msg, err = false, ms = 3500) {
  const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
let busyN = 0;
function busy(on) { busyN += on ? 1 : -1; $("busy").hidden = busyN <= 0; }
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // let "working…" paint
async function work(fn) { busy(true); await nextFrame(); try { return await fn(); } finally { busy(false); } }

function fmt(id, v) {
  v = Number(v);
  if (id === "zoom") return Math.round(v * 100) + "%";
  if (id === "rotate") return v.toFixed(1) + "°";
  if (id.startsWith("shift")) return v.toFixed(1) + "%";
  return String(Math.round(v));
}
function syncOutputs() {
  document.querySelectorAll(".slider input[type=range]").forEach((el) => {
    const o = document.querySelector(`output[for=${el.id}]`); if (o) o.textContent = fmt(el.id, el.value);
  });
}

// ---------------------------------------------------------------- params
function currentSpec() {
  const s = state.spec;
  if (s && s.id === "custom") {
    let hmin = +$("cHmin").value, hmax = +$("cHmax").value; if (hmin > hmax) [hmin, hmax] = [hmax, hmin];
    return { ...s, width_mm: +$("cW").value || 35, height_mm: +$("cH").value || 45, head_min_mm: hmin || 32, head_max_mm: hmax || 36, eye_min_mm: null, eye_max_mm: null };
  }
  return s;
}
function adjust() { const a = { auto_straighten: $("autoStraighten").checked }; ADJ.forEach((k) => (a[k] = +$(k).value)); return a; }
function retouch() { return { removeBg: $("removeBg").checked, airbrush: +$("airbrush").value / 100, blemish: +$("blemish").value / 100, darkSkin: $("darkSkin").value }; }

// ---------------------------------------------------------------- countries
async function loadCountries() {
  state.countries = await (await fetch("data/countries.json")).json();
  state.countries.push({ id: "custom", country: "Custom size…", document: "", width_mm: 35, height_mm: 45, head_min_mm: 32, head_max_mm: 36, confidence: "custom" });
  renderCountryList("");
  selectCountry(state.countries[0].id);
}
const label = (c) => (c.id === "custom" ? c.country : `${c.country} – ${c.document}`);
function renderCountryList(q) {
  const sel = $("country"), cur = state.spec && state.spec.id; q = q.trim().toLowerCase(); sel.innerHTML = "";
  state.countries.filter((c) => !q || label(c).toLowerCase().includes(q)).forEach((c) => {
    const o = document.createElement("option"); o.value = c.id; o.textContent = label(c); if (c.id === cur) o.selected = true; sel.appendChild(o);
  });
}
function selectCountry(id) {
  const c = state.countries.find((x) => x.id === id); if (!c) return;
  state.spec = c; $("country").value = id; $("customSpec").hidden = id !== "custom";
  const inch = (mm) => (mm / 25.4).toFixed(2).replace(/\.?0+$/, "");
  const size = Math.abs(c.width_mm - 50.8) < 0.1 && Math.abs(c.height_mm - 50.8) < 0.1 ? "2 × 2 in" : `${c.width_mm} × ${c.height_mm} mm (${inch(c.width_mm)} × ${inch(c.height_mm)} in)`;
  let txt = `<b>${size}</b> · head ${c.head_min_mm.toFixed(1)}–${c.head_max_mm.toFixed(1)} mm`;
  if (c.eye_min_mm != null) txt += ` · eyes ${c.eye_min_mm.toFixed(1)}–${c.eye_max_mm.toFixed(1)} mm from bottom`;
  if (c.confidence === "high") txt += `<span class="badge high">official spec</span>`;
  else if (c.confidence === "check") txt += `<span class="badge check">verify with consulate</span>`;
  $("specInfo").innerHTML = id === "custom" ? "Enter the size required by the document." : txt;
  scheduleRender(0);
}

// ---------------------------------------------------------------- photo pipeline
function clearPhoto() {
  P.freePrepared(state.prep); state.prep = null; state.prepKey = null;
  state.heal.forEach((m) => m.delete()); state.heal = [];
  state.alphaEdits.forEach((e) => e.mask.delete()); state.alphaEdits = []; state.history = [];
  P.freeAnalysis(state.a); state.a = null;
}

async function loadPhoto(file, quarterTurns = null) {
  if (!file || !state.ready) return;
  $("fileName").textContent = file.name || "pasted image";
  try {
    const a = await work(() => P.analyze(file, quarterTurns));
    clearPhoto(); state.a = a; state.file = file;
    if (quarterTurns === null) resetAdjust(false);
    $("turnRow").hidden = false; $("aiResult").hidden = true; $("sheetPreview").hidden = true;
    await renderNow();
  } catch (e) { toast(e.message, true, 6000); if (!(e instanceof P.PhotoError)) console.error(e); }
}

function healUnion() {
  if (!state.heal.length) return null;
  const cv = P.getCv(), m = state.heal[0].clone();
  for (let i = 1; i < state.heal.length; i++) cv.bitwise_or(m, state.heal[i], m);
  return m;
}

function ensurePrepared() {
  const r = retouch();
  const key = JSON.stringify([r.removeBg, Math.round(r.airbrush * 100), Math.round(r.blemish * 100), r.darkSkin, state.heal.length, state.alphaEdits.length]);
  if (state.prepKey === key && state.prep) return;
  if (state.alphaKey !== state.alphaEdits.length) { P.applyAlphaEdits(state.a, state.alphaEdits); state.alphaKey = state.alphaEdits.length; }
  P.freePrepared(state.prep);
  const hm = healUnion();
  state.prep = P.prepare(state.a, r, hm);
  if (hm) hm.delete();
  state.prepKey = key;
}

function computeRender() {
  ensurePrepared();
  const spec = currentSpec(), adj = adjust();
  const r = P.render(state.a, state.prep, spec, adj);
  const canvas = P.matToCanvas(r.img); r.img.delete();
  const warnings = [...state.a.warnings];
  const m = r.meas;
  if (!m.head_ok) warnings.push(`Head height ${m.head_mm} mm is outside ${spec.head_min_mm.toFixed(0)}–${spec.head_max_mm.toFixed(0)} mm – adjust Head size.`);
  if (m.eye_ok === false) warnings.push(`Eye height ${m.eye_mm} mm is outside the allowed range – adjust Up / down.`);
  if (Math.abs(m.head_turn) > 0.08) warnings.push("Head looks turned to one side – the customer should face the camera squarely (retake).");
  if (m.crown_cut) warnings.push("Top of the head is cut off in the original photo – retake with more space above the head.");
  if (Math.abs(m.auto_rotation) > 12) warnings.push(`Head was tilted ${Math.round(m.auto_rotation)}° – check the result looks natural.`);
  state.last = { canvas, M: r.M, W: r.W, H: r.H, meas: m, warnings, notes: state.prep.notes, spec };
  return state.last;
}

let renderTimer = null, rendering = false, again = false;
function scheduleRender(delay = 60) {
  if (!state.a) return;
  clearTimeout(renderTimer); renderTimer = setTimeout(renderNow, delay);
}
async function renderNow() {
  if (!state.a) return;
  if (rendering) { again = true; return; }
  rendering = true;
  try { await work(() => show(computeRender())); }
  catch (e) { toast(e.message || String(e), true, 6000); console.error(e); }
  finally { rendering = false; if (again) { again = false; scheduleRender(0); } }
}

function show(r) {
  $("placeholder").hidden = true; $("frame").hidden = false;
  const c = $("photo"); c.width = r.W; c.height = r.H; c.getContext("2d").drawImage(r.canvas, 0, 0);
  $("frame").style.setProperty("--ar", (r.W / r.H).toFixed(4));
  drawOverlay();
  ["dlSingle", "dlMax", "dlCoupon", "dlCombo"].forEach((b) => ($(b).disabled = false));
  $("dlMax").textContent = `🖨 4×6 sheet – max copies (${L.maxCopiesFor(r.W, r.H)})`;
  $("healUndo").disabled = !state.history.length;
  const m = r.meas, ok = (b) => (b ? "ok" : "bad");
  let html = `<span class="${ok(m.head_ok)}">Head ${m.head_mm} mm ${m.head_ok ? "✓" : "✗"}</span>`;
  if (m.eye_ok !== null) html += `<span class="${ok(m.eye_ok)}">Eyes ${m.eye_mm} mm from bottom ${m.eye_ok ? "✓" : "✗"}</span>`;
  html += `<span>Auto-straightened ${m.auto_rotation}°</span><span>${r.W}×${r.H}px @300dpi</span>`;
  $("meas").innerHTML = html;
  const w = $("warnings"); w.innerHTML = "";
  r.warnings.forEach((t) => { const li = document.createElement("li"); li.textContent = "⚠ " + t; w.appendChild(li); });
  r.notes.forEach((t) => { const li = document.createElement("li"); li.className = "info"; li.textContent = t; w.appendChild(li); });
}

// ---------------------------------------------------------------- overlay: guides + brushes
let stroke = null;
function drawOverlay() {
  const r = state.last, cv = $("overlay"); if (!r) return;
  cv.width = r.W; cv.height = r.H;
  const g = cv.getContext("2d"); g.clearRect(0, 0, cv.width, cv.height);
  if (stroke) drawStroke(g, stroke);
  if (!$("guides").checked) return;
  const s = r.spec, m = r.meas, W = r.W, H = r.H;
  g.lineWidth = Math.max(1, W / 300);
  g.setLineDash([6, 6]); g.strokeStyle = "rgba(31,111,235,.55)";
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
  g.setLineDash([]); g.strokeStyle = m.head_ok ? "rgba(26,127,55,.9)" : "rgba(192,54,44,.9)";
  [m.crown_px, m.chin_px].forEach((y) => { g.beginPath(); g.moveTo(W * 0.18, y); g.lineTo(W * 0.82, y); g.stroke(); });
  g.fillStyle = "rgba(26,127,55,.12)";
  g.fillRect(W * 0.18, m.crown_px + s.head_min_mm * MM, W * 0.64, (s.head_max_mm - s.head_min_mm) * MM);
  if (s.eye_min_mm != null) { g.fillStyle = "rgba(31,111,235,.12)"; g.fillRect(0, H - s.eye_max_mm * MM, W, (s.eye_max_mm - s.eye_min_mm) * MM); }
  g.font = `${Math.round(W / 40)}px system-ui`; g.fillStyle = "rgba(0,0,0,.55)";
  g.fillText("top of head", W * 0.83 + 4, m.crown_px + 4); g.fillText("chin", W * 0.83 + 4, m.chin_px + 4);
}
function drawStroke(g, st) {
  const W = g.canvas.width, H = g.canvas.height;
  g.strokeStyle = "rgba(255,0,90,.45)"; g.lineCap = g.lineJoin = "round"; g.lineWidth = st.radius * 2 * W; g.setLineDash([]);
  g.beginPath(); st.points.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
  if (st.points.length === 1) g.lineTo(st.points[0][0] * W + 0.1, st.points[0][1] * H);
  g.stroke();
}
const pt = (ev) => { const b = $("overlay").getBoundingClientRect(); return [(ev.clientX - b.left) / b.width, (ev.clientY - b.top) / b.height]; };

function pushHeal(mask) { state.heal.push(mask); state.history.push("heal"); }
function addHeal(strokes) {
  const r = state.last; if (!r) return;
  const mask = P.strokesToMask(state.a, r.M, r.W, r.H, strokes);
  if (P.getCv().countNonZero(mask)) pushHeal(mask); else mask.delete();
}
function addAlphaEdit(strokes, mode) {
  const r = state.last; if (!r) return;
  const mask = P.strokesToMask(state.a, r.M, r.W, r.H, strokes);
  if (P.getCv().countNonZero(mask)) { state.alphaEdits.push({ mask, mode }); state.history.push("alpha"); } else mask.delete();
}
function undoBrush() {
  const last = state.history.pop();
  if (last === "heal") { const m = state.heal.pop(); if (m) m.delete(); }
  else if (last === "alpha") { const e = state.alphaEdits.pop(); if (e) e.mask.delete(); }
  renderNow();
}
function setupBrush() {
  const cv = $("overlay");
  cv.addEventListener("pointerdown", (e) => {
    if (!$("brushMode").value || !state.a) return;
    cv.setPointerCapture(e.pointerId); stroke = { points: [pt(e)], radius: +$("brushSize").value }; drawOverlay();
  });
  cv.addEventListener("pointermove", (e) => { if (stroke) { stroke.points.push(pt(e)); drawOverlay(); } });
  cv.addEventListener("pointerup", async () => {
    if (!stroke) return; const st = stroke; stroke = null;
    const mode = $("brushMode").value;
    if (mode === "heal") addHeal([st]); else addAlphaEdit([st], mode);
    await renderNow();
  });
  cv.addEventListener("pointercancel", () => { stroke = null; drawOverlay(); });
  $("brushMode").addEventListener("change", () => {
    const m = $("brushMode").value, f = $("frame");
    f.classList.toggle("brush", !!m); f.classList.toggle("erase", m === "erase"); f.classList.toggle("restore", m === "restore");
    $("brushSizeWrap").hidden = !m;
    if (m === "erase" || m === "restore") toast(m === "erase" ? "Paint over leftover background to turn it white." : "Paint over parts of the person that were removed by mistake.");
  });
  $("healUndo").addEventListener("click", undoBrush);
}

// ---------------------------------------------------------------- adjust
function resetAdjust(render = true) { ADJ.forEach((k) => ($(k).value = ADJ_DEFAULT[k])); syncOutputs(); if (render) scheduleRender(0); }

// ---------------------------------------------------------------- AI instructions
async function runAI(check) {
  if (!state.last) return toast("Upload a photo first", true);
  const instr = check ? "" : $("instruction").value;
  if (!check && !instr.trim()) return toast("Type an instruction first", true);
  if (!AI.getKey()) return runLocal(check, instr);
  const box = $("aiResult"); box.hidden = false; box.className = "ai-result"; box.textContent = "Claude is looking at the photo…";
  $("aiApply").disabled = $("aiCheck").disabled = true; busy(true);
  try {
    const r = state.last;
    const current = { ...adjust(), airbrush: +$("airbrush").value, blemish: +$("blemish").value }; delete current.auto_straighten;
    const jpeg = await P.canvasToJpeg(r.canvas, 0.92);
    const p = await AI.planEdits(jpeg, instr, current, r.spec, r.meas);
    if (p.remove_regions.length) addHeal(p.remove_regions.map((b) => ({ type: "box", ...b })));
    ADJ.forEach((k) => ($(k).value = p[k])); $("airbrush").value = p.airbrush; $("blemish").value = p.blemish; syncOutputs();
    await renderNow();
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    let html = `<div>${esc(p.summary)}</div>`;
    if (p.remove_regions.length) html += `<div class="small muted">Removed: ${p.remove_regions.map((x) => esc(x.label)).join(", ")} (Undo brush reverts; Brush › Heal touches up)</div>`;
    if (p.cannot_do.length) html += `<b>Can't do automatically:</b><ul>${p.cannot_do.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (p.compliance_notes.length) html += `<b>Passport check:</b><ul>${p.compliance_notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    else if (check) html += `<div class="small" style="color:var(--ok)">No compliance problems spotted.</div>`;
    box.innerHTML = html;
  } catch (e) {
    box.className = "ai-result err"; box.textContent = e.message || String(e); if (!(e instanceof AI.AIError)) console.error(e);
  } finally { $("aiApply").disabled = $("aiCheck").disabled = false; busy(false); }
}

// ---------------------------------------------------------------- quick commands (no API key)
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const LIM = { rotate: [-15, 15], zoom: [0.85, 1.15], shift_x: [-15, 15], shift_y: [-15, 15], brightness: [-50, 50],
  contrast: [-50, 50], saturation: [-50, 50], warmth: [-50, 50], airbrush: [0, 100], blemish: [0, 100] };
const NAMES = { necklace: "necklace", earrings: "earrings", nose: "nose jewelry" };

async function runLocal(check, instr) {
  const box = $("aiResult"); box.hidden = false; box.className = "ai-result";
  if (check) {
    const r = state.last, m = r.meas, probs = [...r.warnings];
    let html = `<div>Automatic check: head ${m.head_mm} mm ${m.head_ok ? "✓" : "✗"}` + (m.eye_ok === null ? "" : `, eyes ${m.eye_mm} mm ${m.eye_ok ? "✓" : "✗"}`) + `.</div>`;
    html += probs.length ? `<ul>${probs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="small" style="color:var(--ok)">No problems found by the automatic checks.</div>`;
    html += `<div class="small muted">Also check by eye: no glasses, neutral expression, eyes open, no shadows, nothing covering the face. (Add a Claude API key in ⚙ Settings for an AI review.)</div>`;
    box.innerHTML = html; return;
  }
  const cmd = Q.parse(instr);
  const done = [];
  if (cmd.reset) { resetAdjust(false); $("airbrush").value = 35; $("blemish").value = 50; done.push("Reset position and tone"); }
  for (const [k, v] of Object.entries(cmd.add)) {
    const el = $(k); if (!el) continue;
    const [lo, hi] = LIM[k]; el.value = Math.min(hi, Math.max(lo, +el.value + v));
  }
  if ("auto_straighten" in cmd.set) { $("autoStraighten").checked = true; $("rotate").value = 0; }
  if ("shift_x" in cmd.set) $("shift_x").value = 0;
  syncOutputs();
  const adjusted = Object.keys(cmd.add).length || Object.keys(cmd.set).length;
  if (adjusted) done.push("Adjusted: " + [...Object.keys(cmd.add), ...Object.keys(cmd.set)].map((k) => k.replace("_", " ").replace("auto straighten", "straightened")).join(", "));
  const notFound = [];
  if (cmd.remove.size) {
    busy(true); await nextFrame();
    try {
      const { mask, found } = Q.findJewelry(state.a, cmd.remove);
      const cv = P.getCv();
      if (cv.countNonZero(mask)) pushHeal(mask); else mask.delete();
      const got = [...cmd.remove].filter((k) => found[k]);
      if (got.length) done.push("Removed " + got.map((k) => NAMES[k]).join(", "));
      [...cmd.remove].filter((k) => !found[k]).forEach((k) => notFound.push(k));
    } finally { busy(false); }
  }
  await renderNow();
  let html = done.length ? `<div>${done.map(esc).join(". ")}.</div>` : "";
  if (cmd.remove.size && done.some((d) => d.startsWith("Removed"))) html += `<div class="small muted">Check the result. Undo brush reverts it; Brush › Heal cleans up anything left.</div>`;
  if (notFound.length) html += `<div class="small">No ${notFound.map((k) => NAMES[k]).join(" or ")} found on bare skin – if there is some, paint over it with <b>Brush › Heal spots / jewelry</b>.</div>`;
  if (cmd.notes.length) html += `<b>Can't do by editing:</b><ul>${cmd.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  if (cmd.unknown.length) html += `<div class="small">Didn't understand: “${cmd.unknown.map(esc).join("”, “")}”.</div><div class="small muted">${esc(Q.HELP)}</div>`;
  if (!html) html = `<div class="small muted">${esc(Q.HELP)}</div>`;
  box.innerHTML = html;
}

// ---------------------------------------------------------------- downloads
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`; };
const safe = (s) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_|_$/g, "") || "photo";
function save(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`Saved ${name}`);
}
async function downloadSingle() {
  const r = state.last; if (!r) return;
  save(await P.canvasToJpeg(r.canvas), `passport_${safe(r.spec.country)}_${stamp()}.jpg`);
}
// the same photo rendered at another document size (same retouch and adjustments)
function renderAt(spec) {
  ensurePrepared();
  const r = P.render(state.a, state.prep, spec, adjust());
  const canvas = P.matToCanvas(r.img); r.img.delete();
  return canvas;
}
const sizeIs = (s, w, h) => Math.abs(s.width_mm - w) < 0.3 && Math.abs(s.height_mm - h) < 0.3;

async function downloadSheet(mode) {
  const r = state.last; if (!r) return;
  try {
    let res, couponName = null;
    if (mode === "combo") {
      // use the selected document when it already is that size, otherwise US passport / ICAO 35x45 standard
      const cur = r.spec;
      const us = sizeIs(cur, 50.8, 50.8) ? cur : state.countries[0];
      const eu = sizeIs(cur, 35, 45) ? cur : state.countries.find((c) => c.id === "schengen-area-visa") ||
        { id: "icao", country: "Standard", document: "35x45", width_mm: 35, height_mm: 45, head_min_mm: 32, head_max_mm: 36, eye_min_mm: null, eye_max_mm: null };
      res = await work(() => L.comboSheet(us === cur ? r.canvas : renderAt(us), eu === cur ? r.canvas : renderAt(eu), $("cutLines").checked, $("cutMarks").checked));
      const blob = await P.canvasToJpeg(res.canvas);
      save(blob, `print4x6_3x2in_4x35x45_${stamp()}.jpg`);
      $("sheetPreview").hidden = false; $("sheetImg").src = URL.createObjectURL(blob);
      $("sheetInfo").textContent = `3 × 2×2 in (${us.country}) + 4 × 35×45 mm (${eu.country})`; $("reshuffle").hidden = true;
      return;
    }
    if (mode === "coupon") {
      const c = await L.pickCoupon(state.coupons);
      res = L.couponSheet(r.canvas, c && c.img, 4, $("cutLines").checked, $("cutMarks").checked); couponName = c && c.name;
    } else res = L.maxCopiesSheet(r.canvas, $("cutLines").checked, $("cutMarks").checked);
    const blob = await P.canvasToJpeg(res.canvas);
    save(blob, `print4x6_${safe(r.spec.country)}_${res.copies}x_${stamp()}.jpg`);
    $("sheetPreview").hidden = false; $("sheetImg").src = URL.createObjectURL(blob);
    $("sheetInfo").textContent = `${res.copies} copies` + (couponName ? ` · coupon: ${couponName}` : mode === "coupon" ? " · no coupons added yet" : "");
    $("reshuffle").hidden = mode !== "coupon";
  } catch (e) { toast(e.message, true, 6000); }
}

// ---------------------------------------------------------------- coupons
async function loadCoupons() {
  state.coupons = await L.listCoupons();
  $("couponCount").textContent = `(${state.coupons.length})`;
  const box = $("coupons"); box.innerHTML = "";
  state.coupons.forEach((c) => {
    const d = document.createElement("div"); d.className = "coupon";
    const img = document.createElement("img"); img.loading = "lazy"; img.src = c.url; img.alt = c.name;
    const b = document.createElement("button"); b.className = "btn sm"; b.title = "Remove"; b.textContent = "✕";
    b.onclick = async () => { if (!confirm(`Remove coupon "${c.name}"?`)) return; await L.deleteCoupon(c); loadCoupons(); };
    d.append(img, b); box.appendChild(d);
  });
  if (!state.coupons.length) $("couponCard").open = true;
}

// ---------------------------------------------------------------- AI status / settings
function updateAiChip() {
  const has = !!AI.getKey(), c = $("aiStatus");
  c.textContent = has ? "AI instructions: on" : "Quick commands (no AI key)"; c.className = "chip " + (has ? "ok" : "");
}

// ---------------------------------------------------------------- wiring
function init() {
  syncOutputs(); updateAiChip();
  const drop = $("drop"); drop.classList.add("disabled");
  $("file").addEventListener("change", (e) => { loadPhoto(e.target.files[0]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => loadPhoto(e.dataTransfer.files[0]));
  document.addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) loadPhoto(f); });
  document.querySelectorAll("[data-turn]").forEach((b) => b.addEventListener("click", () => loadPhoto(state.file, (state.a ? state.a.quarterTurns : 0) + +b.dataset.turn)));

  $("countrySearch").addEventListener("input", (e) => { renderCountryList(e.target.value); const f = $("country").options[0]; if (f && e.target.value) selectCountry(f.value); });
  $("country").addEventListener("change", (e) => selectCountry(e.target.value));
  ["cW", "cH", "cHmin", "cHmax"].forEach((id) => $(id).addEventListener("input", () => scheduleRender()));
  document.querySelectorAll(".slider input[type=range]").forEach((el) => el.addEventListener("input", () => { syncOutputs(); if (el.id !== "brushSize") scheduleRender(); }));
  ["removeBg", "darkSkin", "autoStraighten"].forEach((id) => $(id).addEventListener("change", () => scheduleRender(0)));
  $("guides").addEventListener("change", drawOverlay);
  $("resetAdj").addEventListener("click", () => resetAdjust());

  $("aiApply").addEventListener("click", () => runAI(false));
  document.querySelectorAll(".cmd").forEach((b) => b.addEventListener("click", async () => {
    if (!state.last) return toast("Upload a photo first", true);
    document.querySelectorAll(".cmd").forEach((x) => (x.disabled = true));
    try { await runLocal(false, b.dataset.cmd); b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1500); }
    finally { document.querySelectorAll(".cmd").forEach((x) => (x.disabled = false)); }
  }));
  $("aiCheck").addEventListener("click", () => runAI(true));
  $("instruction").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runAI(false); });

  $("dlSingle").addEventListener("click", downloadSingle);
  $("dlMax").addEventListener("click", () => downloadSheet("max"));
  $("dlCoupon").addEventListener("click", () => downloadSheet("coupon"));
  $("reshuffle").addEventListener("click", () => downloadSheet("coupon"));
  $("dlCombo").addEventListener("click", () => downloadSheet("combo"));
  $("couponFiles").addEventListener("change", async (e) => {
    try { const n = await L.addCoupons([...e.target.files]); toast(`Added ${n} coupon(s)`); loadCoupons(); } catch (err) { toast(err.message, true); }
    e.target.value = "";
  });

  $("settingsBtn").addEventListener("click", () => { $("apiKey").value = AI.getKey(); $("settings").showModal(); });
  $("settings").addEventListener("close", () => { if ($("settings").returnValue === "save") { AI.setKey($("apiKey").value); updateAiChip(); toast("Settings saved"); } });

  setupBrush();
  loadCountries();
  loadCoupons();

  const status = $("loadStatus");
  P.loadModels((msg) => { if (msg) status.textContent = msg; })
    .then(() => {
      state.ready = true; status.textContent = "Ready – works offline"; status.className = "chip ok";
      drop.classList.remove("disabled"); $("file").disabled = false;
    })
    .catch((e) => { status.textContent = "Failed to load – reload page"; status.className = "chip bad"; toast(e.message || String(e), true, 10000); console.error(e); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then(() => {
      // first visit: reload once under the service worker so multi-threaded processing is enabled
      if (!self.crossOriginIsolated && !navigator.serviceWorker.controller && !sessionStorage.getItem("ppg.reloaded")) {
        navigator.serviceWorker.ready.then(() => { sessionStorage.setItem("ppg.reloaded", "1"); if (!state.a) location.reload(); });
      }
    }).catch(() => {});
  }
}
init();
