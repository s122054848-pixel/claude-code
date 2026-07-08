"use strict";

// This is the "import data -> compute tube plan directly" variant: the
// imported CSV's (width, qty) rows are treated AS the tube-segment demand
// directly (no 6600mm slitting/cutting-plan stage in between). See
// ../webapp/ for the full slitting + tube-plan pipeline this was split from.

const SAMPLE_CSV = `寬度,訂量
950,21
1000,11
1050,15
1150,3
1200,58
1250,7
1300,60
1350,57
1400,99
1450,10
1500,32
1550,22
1600,34
1650,49
1700,108
1750,34
1800,63
1850,53
1900,90
1950,62
2000,167
2050,103
2100,149
2150,81
2200,93
2250,62
2300,78
2350,32
2400,96
2450,49
2500,118
2550,18
2600,66
2650,14
2700,51
2750,11
2800,43
2850,17
2900,3
3000,6
3100,3
3150,3`;

const els = {
  fileInput: document.getElementById("fileInput"),
  encodingSelect: document.getElementById("encodingSelect"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  ordersText: document.getElementById("ordersText"),
  runBtn: document.getElementById("runBtn"),
  statusBanner: document.getElementById("statusBanner"),
  statusSpinner: document.getElementById("statusSpinner"),
  statusLine: document.getElementById("statusLine"),
  tubeLen1: document.getElementById("tubeLen1"),
  tubeLen2: document.getElementById("tubeLen2"),
  tubeLen3: document.getElementById("tubeLen3"),
  tubeLen4: document.getElementById("tubeLen4"),
  tubeWasteTol: document.getElementById("tubeWasteTol"),
  tubeStageTimeLimit: document.getElementById("tubeStageTimeLimit"),
  tubeR2Len1: document.getElementById("tubeR2Len1"),
  tubeR2Len2: document.getElementById("tubeR2Len2"),
  tubeR2Len3: document.getElementById("tubeR2Len3"),
  tubeR2Len4: document.getElementById("tubeR2Len4"),
  tubeSummaryPanel: document.getElementById("tubeSummaryPanel"),
  tubeSummaryCards: document.getElementById("tubeSummaryCards"),
  tubeRound1Panel: document.getElementById("tubeRound1Panel"),
  tubeRound1Table: document.getElementById("tubeRound1Table").querySelector("tbody"),
  tubeRound2Panel: document.getElementById("tubeRound2Panel"),
  tubeRound2Table: document.getElementById("tubeRound2Table").querySelector("tbody"),
  tubeRound1Title: document.getElementById("tubeRound1Title"),
  tubeRound2Title: document.getElementById("tubeRound2Title"),
  downloadTube1Btn: document.getElementById("downloadTube1Btn"),
  downloadTube2Btn: document.getElementById("downloadTube2Btn"),
};

els.ordersText.value = SAMPLE_CSV;

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

const autoRun = debounce(() => runPipeline(), 600);

els.loadSampleBtn.addEventListener("click", () => {
  els.ordersText.value = SAMPLE_CSV;
  runPipeline();
});

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const decoder = new TextDecoder(els.encodingSelect.value);
  els.ordersText.value = decoder.decode(buf);
  runPipeline();
});

els.ordersText.addEventListener("input", autoRun);
for (const id of [
  "tubeLen1",
  "tubeLen2",
  "tubeLen3",
  "tubeLen4",
  "tubeWasteTol",
  "tubeStageTimeLimit",
  "tubeR2Len1",
  "tubeR2Len2",
  "tubeR2Len3",
  "tubeR2Len4",
]) {
  els[id].addEventListener("change", autoRun);
}

// A single solve can legitimately take tens of seconds, during which only
// one or two status lines would otherwise change - which can look identical
// to a frozen/broken page. Show a live elapsed-time counter while busy so
// it's visibly still working.
let elapsedTimer = null;
let pipelineStartTime = null;
let lastBusyMsg = "";

function setStatus(msg, state) {
  if (state === "busy") {
    lastBusyMsg = msg;
    if (!pipelineStartTime) pipelineStartTime = Date.now();
    if (!elapsedTimer) {
      elapsedTimer = setInterval(() => {
        const s = Math.round((Date.now() - pipelineStartTime) / 1000);
        els.statusLine.textContent = `${lastBusyMsg}（已運算 ${s} 秒）`;
      }, 1000);
    }
    const s = Math.round((Date.now() - pipelineStartTime) / 1000);
    els.statusLine.textContent = `${msg}（已運算 ${s} 秒）`;
  } else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    pipelineStartTime = null;
    els.statusLine.textContent = msg;
  }
  els.statusBanner.className = "status-banner state-" + (state || "idle");
  els.statusSpinner.hidden = state !== "busy";
}

// ---- parsing: each row is (寬度, 訂量) = a tube-segment width and how many
// segments of it are needed - this IS the tube demand directly, no
// slitting/cutting-plan stage in between. ----
function parseOrders(text) {
  const widths = [];
  const demand = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",").map((s) => s.trim()).filter((s) => s.length);
    if (parts.length < 2) continue;
    const w = Number(parts[0]);
    const q = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(q)) continue; // header or bad row
    if (w <= 0) continue;
    const key = String(w);
    if (!(key in demand)) widths.push(w);
    demand[key] = (demand[key] || 0) + Math.max(0, Math.round(q));
  }
  widths.sort((a, b) => a - b);
  return { widths, demand };
}

function patternToCounts(pattern) {
  const counts = {};
  for (const w of pattern) {
    const key = String(w);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---- LP (CPLEX LP format) construction ----
// opts.minBatch: if set (>1), each pattern must be used 0 times or at least
// minBatch times (modeled with a binary indicator y_i per pattern and a
// tight big-M = the pattern's own per-width demand ceiling). Patterns that
// could never reach minBatch even alone are dropped entirely. Not used by
// the tube plan today (no min-batch requirement there), but buildLP stays
// generic since it's shared with the full slitting+tube webapp.
function buildLP(patterns, patternCounts, widths, demand, opts) {
  const nPat = patterns.length;
  const minBatch = opts.minBatch || 0;
  const lines = [];

  const activeIdx = [];
  const upperBound = new Array(nPat);
  for (let i = 0; i < nPat; i++) {
    if (minBatch > 1) {
      let U = Infinity;
      const counts = patternCounts[i];
      for (const key in counts) {
        U = Math.min(U, Math.floor((demand[key] || 0) / counts[key]));
      }
      upperBound[i] = U;
      if (U < minBatch) continue;
    }
    activeIdx.push(i);
  }

  if (opts.mode === "max_fulfill") {
    lines.push("Maximize");
    lines.push(" obj: " + (activeIdx.length ? activeIdx.map((i) => `${patterns[i].length} x${i}`).join(" + ") : "0"));
  } else {
    lines.push("Minimize");
    lines.push(" obj: " + (activeIdx.length ? activeIdx.map((i) => `x${i}`).join(" + ") : "0"));
  }

  lines.push("Subject To");

  // per-width incidence: width -> array of "count xIdx"
  const widthTerms = new Map();
  for (const w of widths) widthTerms.set(String(w), []);
  for (const i of activeIdx) {
    const counts = patternCounts[i];
    for (const key in counts) {
      if (!widthTerms.has(key)) widthTerms.set(key, []);
      widthTerms.get(key).push(`${counts[key]} x${i}`);
    }
  }

  for (const w of widths) {
    const key = String(w);
    const terms = widthTerms.get(key) || [];
    const expr = terms.length ? terms.join(" + ") : activeIdx.length ? `0 x${activeIdx[0]}` : "0 dummy";
    lines.push(` c${key}: ${expr} <= ${demand[key] || 0}`);
  }

  if (opts.mode === "min_rolls") {
    const fulfillTerms = activeIdx.length ? activeIdx.map((i) => `${patterns[i].length} x${i}`).join(" + ") : "0 dummy";
    lines.push(` c_fulfill: ${fulfillTerms} >= ${opts.fulfillFloor}`);
  }

  if (minBatch > 1) {
    for (const i of activeIdx) {
      lines.push(` cub_${i}: x${i} - ${upperBound[i]} y${i} <= 0`);
      lines.push(` clb_${i}: x${i} - ${minBatch} y${i} >= 0`);
    }
  }

  lines.push("General");
  lines.push(activeIdx.map((i) => `x${i}`).join(" "));

  if (minBatch > 1) {
    lines.push("Binary");
    lines.push(activeIdx.map((i) => `y${i}`).join(" "));
  }

  lines.push("End");

  return lines.join("\n");
}

// ---- paper-tube (紙管) combination plan ----
// Round 1: only stock lengths in `lengths` (e.g. 4600/4400mm), each tube's
// combined segments must use more than (1 - wasteTol) of the stock length.
function generateRound1TubePatterns(widths, lengths, wasteTol) {
  const n = widths.length;
  if (n === 0) return [];
  const maxLen = Math.max(...lengths);
  const maxPieces = Math.floor(maxLen / widths[0]);
  const windows = lengths.map((L) => [L, L * (1 - wasteTol), L]);
  const patterns = [];
  const seen = new Set();
  const combo = [];

  function dfs(startIdx, count, total) {
    if (count >= 1) {
      for (const [L, lo, hi] of windows) {
        if (total >= lo && total <= hi) {
          const items = combo.slice().sort((a, b) => a - b);
          const key = L + ":" + items.join(",");
          if (!seen.has(key)) {
            seen.add(key);
            patterns.push({ items, stockLength: L });
          }
        }
      }
    }
    if (total >= maxLen || count >= maxPieces) return;
    for (let i = startIdx; i < n; i++) {
      const w = widths[i];
      if (total + w > maxLen) break;
      combo.push(w);
      dfs(i, count + 1, total + w);
      combo.pop();
    }
  }

  dfs(0, 0, 0);
  return patterns;
}

// Round 2: any multiset of widths with sum <= one of `lengths`, no lower
// bound (waste doesn't matter for this round). A combo that fits multiple
// lengths gets one pattern entry per satisfying length, since each is a
// distinct physical tube choice for the solver to pick from.
function generateBoundedTubePatterns(widths, lengths) {
  const n = widths.length;
  if (n === 0 || lengths.length === 0) return [];
  const maxLen = Math.max(...lengths);
  const maxPieces = Math.floor(maxLen / widths[0]);
  const patterns = [];
  const seen = new Set();
  const combo = [];

  function dfs(startIdx, count, total) {
    if (count >= 1) {
      for (const L of lengths) {
        if (total > L) continue;
        const items = combo.slice().sort((a, b) => a - b);
        const key = L + ":" + items.join(",");
        if (!seen.has(key)) {
          seen.add(key);
          patterns.push({ items, stockLength: L });
        }
      }
    }
    if (total >= maxLen || count >= maxPieces) return;
    for (let i = startIdx; i < n; i++) {
      const w = widths[i];
      if (total + w > maxLen) break;
      combo.push(w);
      dfs(i, count + 1, total + w);
      combo.pop();
    }
  }

  dfs(0, 0, 0);
  return patterns;
}

// Extract a {...entry, count}[] solution from a solved LP's Columns object,
// keyed against `patternsFull` (array of {items, ...anyMeta}) by index. Also
// returns totalProduced so callers can sanity-check the result: a MIP that
// times out with no incumbent can come back with a *present but empty* (or
// partially empty) Columns object, which is truthy and easy to mistake for
// a valid zero/low solution if only checked for existence.
function extractPatternSolution(sol, patternsFull, widths) {
  const produced = {};
  for (const w of widths) produced[String(w)] = 0;
  const rows = [];
  if (sol && sol.Columns) {
    for (let i = 0; i < patternsFull.length; i++) {
      const col = sol.Columns[`x${i}`];
      if (!col) continue;
      const count = Math.round(col.Primal || 0);
      if (count <= 0) continue;
      const entry = patternsFull[i];
      for (const w of entry.items) produced[String(w)] = (produced[String(w)] || 0) + count;
      rows.push({ ...entry, count });
    }
  }
  const totalProduced = Object.values(produced).reduce((a, b) => a + b, 0);
  return { rows, produced, totalProduced };
}

// Generic two-stage (max fulfillment, then min tube count) solve over an
// arbitrary set of {items, stockLength} patterns - reuses buildLP/solveLP
// since the LP itself only cares about widths, not the actual stock length.
async function solveTubeStage(patternsFull, widths, demand, t1, t2) {
  if (patternsFull.length === 0 || widths.length === 0) {
    return { solution: [], produced: {}, status1: "N/A", status2: "N/A" };
  }
  const itemsList = patternsFull.map((p) => p.items);
  const counts = itemsList.map(patternToCounts);
  const lp1 = buildLP(itemsList, counts, widths, demand, { mode: "max_fulfill" });
  const sol1 = await solveLP(lp1, t1);
  const fulfillFloor = Math.round((sol1 && sol1.ObjectiveValue) || 0);

  const lp2 = buildLP(itemsList, counts, widths, demand, { mode: "min_rolls", fulfillFloor });
  const sol2 = await solveLP(lp2, t2);

  let ext = extractPatternSolution(sol2, patternsFull, widths);
  if (ext.totalProduced < fulfillFloor - 0.5) {
    // stage2 failed to find any solution meeting the fulfillment floor
    // (timed out with no incumbent) - fall back to stage1's own solution,
    // which is already known to achieve fulfillFloor.
    ext = extractPatternSolution(sol1, patternsFull, widths);
  }
  ext.rows.sort((a, b) => b.count - a.count);

  return {
    solution: ext.rows,
    produced: ext.produced,
    status1: sol1 ? sol1.Status : "Failed",
    status2: sol2 ? sol2.Status : "Failed",
  };
}

function readLengthList(ids) {
  return ids
    .map((id) => Math.round(Number(els[id].value)))
    .filter((v) => Number.isFinite(v) && v > 0);
}

// The tube-plan patterns are far fewer/simpler than a full slitting problem
// and consistently solve in a few seconds, so each stage gets its own small
// time budget. Round1 and Round2 each run 2 stages (max-fulfill, then
// min-tubes), so at this per-stage cap the absolute worst case for
// round1+round2 combined is 4 * cap; default 12s keeps that at 48s.
async function runTubePlan(demand, widths) {
  const tubeStageCap = Math.max(1, Math.round(Number(els.tubeStageTimeLimit.value)) || 12);
  const round1Lengths = readLengthList(["tubeLen1", "tubeLen2", "tubeLen3", "tubeLen4"]);
  const round2Lengths = readLengthList(["tubeR2Len1", "tubeR2Len2", "tubeR2Len3", "tubeR2Len4"]);
  const wasteTol = Math.max(0, Number(els.tubeWasteTol.value) || 0) / 100;

  const tubeWidths = widths.filter((w) => (demand[String(w)] || 0) > 0).sort((a, b) => a - b);
  const tubeDemand = {};
  for (const w of tubeWidths) tubeDemand[String(w)] = demand[String(w)];

  const round1Patterns = generateRound1TubePatterns(tubeWidths, round1Lengths, wasteTol);
  const round1 = await solveTubeStage(round1Patterns, tubeWidths, tubeDemand, tubeStageCap, tubeStageCap);

  const remainingWidths = tubeWidths.filter(
    (w) => tubeDemand[String(w)] - (round1.produced[String(w)] || 0) > 0
  );
  const remainingDemand = {};
  for (const w of remainingWidths) {
    remainingDemand[String(w)] = tubeDemand[String(w)] - (round1.produced[String(w)] || 0);
  }

  let round2 = { solution: [], produced: {}, status1: "N/A", status2: "N/A" };
  if (remainingWidths.length > 0 && round2Lengths.length > 0) {
    const round2Patterns = generateBoundedTubePatterns(remainingWidths, round2Lengths);
    round2 = await solveTubeStage(round2Patterns, remainingWidths, remainingDemand, tubeStageCap, tubeStageCap);
  }

  const totalDemand = tubeWidths.reduce((s, w) => s + tubeDemand[String(w)], 0);
  const round1Total = Object.values(round1.produced).reduce((a, b) => a + b, 0);
  const round2Total = Object.values(round2.produced).reduce((a, b) => a + b, 0);
  const round1Tubes = round1.solution.reduce((s, r) => s + r.count, 0);
  const round2Tubes = round2.solution.reduce((s, r) => s + r.count, 0);

  return {
    round1Lengths,
    round2Lengths,
    wasteTol,
    tubeWidths,
    tubeDemand,
    round1,
    round2,
    totalDemand,
    round1Total,
    round2Total,
    round1Tubes,
    round2Tubes,
    shortfall: totalDemand - round1Total - round2Total,
  };
}

// ---- HiGHS wasm solving ----
// Solving runs in a Web Worker so a slow MIP doesn't freeze the page's UI
// thread. Falls back to a synchronous in-page solve if the Worker can't be
// created/used.
let highsWorker = null;
let workerReqId = 0;
const workerPending = new Map();
let workerBroken = false;

function getWorker() {
  if (!highsWorker) {
    // Constructing a Worker from a plain relative/file path (e.g. "worker.js")
    // throws a SecurityError on file:// pages ("cannot be accessed from
    // origin 'null'"), which silently falls back to the main-thread solve
    // and freezes the tab for the whole computation (Chrome then shows its
    // own "page unresponsive" watchdog dialog). A blob: URL is always
    // same-origin to its creator, including from file://, so build the
    // worker from an inlined bundle (vendor/worker-bundle.js, loaded as a
    // normal <script> tag) instead of fetching a separate worker script.
    const blob = new Blob([window.WORKER_BUNDLE_SOURCE], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    highsWorker = new Worker(blobUrl);
    highsWorker.onmessage = (e) => {
      const { id, ok, sol, error } = e.data;
      const pending = workerPending.get(id);
      if (!pending) return;
      workerPending.delete(id);
      if (ok) pending.resolve(sol);
      else pending.reject(new Error(error));
    };
    highsWorker.onerror = (e) => {
      for (const pending of workerPending.values()) pending.reject(new Error(e.message || "worker error"));
      workerPending.clear();
      workerBroken = true;
    };
  }
  return highsWorker;
}

function solveInWorker(lpText, options) {
  return new Promise((resolve, reject) => {
    const id = ++workerReqId;
    workerPending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, lp: lpText, options });
    } catch (err) {
      workerPending.delete(id);
      reject(err);
    }
  });
}

// fallback path: solve directly on the main thread
let highsInstancePromise = null;
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function getHighsInline() {
  if (!highsInstancePromise) {
    const wasmBinary = base64ToUint8Array(window.HIGHS_WASM_BASE64);
    highsInstancePromise = Module({ wasmBinary });
  }
  return highsInstancePromise;
}

// HiGHS will happily burn the entire time_limit trying to *prove*
// optimality even after it already found the true-best incumbent in a
// fraction of that time, whenever the LP-relaxation bound isn't
// integer-achievable. Once the solution is within this relative gap of the
// best proven bound, HiGHS stops early instead of continuing to search for
// no real benefit.
const MIP_REL_GAP = 0.0005;

async function solveLP(lpText, timeLimitSec) {
  const options = { time_limit: timeLimitSec, output_flag: false, mip_rel_gap: MIP_REL_GAP };
  if (!workerBroken && typeof Worker !== "undefined") {
    try {
      return await solveInWorker(lpText, options);
    } catch (err) {
      console.warn("Worker solve failed, falling back to main-thread solve:", err);
      workerBroken = true;
    }
  }
  const highs = await getHighsInline();
  return highs.solve(lpText, options);
}

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- main pipeline: import data -> compute tube plan directly ----
async function runPipeline() {
  els.runBtn.disabled = true;
  els.tubeSummaryPanel.hidden = true;
  els.tubeRound1Panel.hidden = true;
  els.tubeRound2Panel.hidden = true;

  try {
    const { widths, demand } = parseOrders(els.ordersText.value);
    if (widths.length === 0) {
      setStatus("找不到有效的紙管需求資料，請確認格式為「寬度,數量」。", "idle");
      return;
    }

    setStatus("計算紙管組合計畫中...", "busy");
    await yieldToUI();
    const tube = await runTubePlan(demand, widths);
    renderTubePlan(tube);
    window.__lastTube = tube;

    setStatus(
      `完成。共排產 ${tube.round1Total + tube.round2Total}/${tube.totalDemand} 段，缺口 ${tube.shortfall} 段（Round1 ${tube.round1Tubes} 支、Round2 ${tube.round2Tubes} 支）。`,
      tube.shortfall > 0 ? "warn" : "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus("發生錯誤：" + (err && err.message ? err.message : String(err)), "error");
  } finally {
    els.runBtn.disabled = false;
  }
}

function renderTubePlan(tube) {
  els.tubeSummaryPanel.hidden = false;
  const pct = tube.totalDemand > 0 ? (((tube.round1Total + tube.round2Total) / tube.totalDemand) * 100).toFixed(1) : "0.0";
  const cards = [
    { label: "所需紙管段數", value: tube.totalDemand },
    { label: "Round1 滿足段數", value: tube.round1Total },
    { label: "Round2 滿足段數", value: tube.round2Total },
    { label: "總滿足率", value: pct + "%", tone: tube.shortfall === 0 ? "good" : "" },
    { label: "缺口段數", value: tube.shortfall, tone: tube.shortfall > 0 ? "warn" : "good" },
    { label: `Round1 母管數 (${tube.round1Lengths.join("/")}mm)`, value: tube.round1Tubes },
    { label: `Round2 母管數 (${tube.round2Lengths.join("/")}mm)`, value: tube.round2Tubes },
  ];
  els.tubeSummaryCards.innerHTML = "";
  for (const c of cards) {
    const div = document.createElement("div");
    div.className = "card" + (c.tone ? " " + c.tone : "");
    div.innerHTML = `<div class="value">${c.value}</div><div class="label">${c.label}</div>`;
    els.tubeSummaryCards.appendChild(div);
  }

  els.tubeRound1Panel.hidden = tube.round1.solution.length === 0;
  els.tubeRound1Title.textContent = `Round1：${tube.round1Lengths.join("/")}mm 母管（修邊損耗 < ${(tube.wasteTol * 100).toFixed(1)}%）`;
  els.tubeRound1Table.innerHTML = "";
  for (const row of tube.round1.solution) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    const rate = ((waste / row.stockLength) * 100).toFixed(2) + "%";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.stockLength}</td><td>${row.count}</td><td>${row.items.join(" + ")}</td><td>${row.items.length}</td><td>${sum}</td><td>${waste}</td><td>${rate}</td>`;
    els.tubeRound1Table.appendChild(tr);
  }

  els.tubeRound2Panel.hidden = tube.round2.solution.length === 0;
  els.tubeRound2Title.textContent = `Round2：剩餘規格組合（${tube.round2Lengths.join("/")}mm 母管，不限修邊損耗）`;
  els.tubeRound2Table.innerHTML = "";
  for (const row of tube.round2.solution) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.stockLength}</td><td>${row.count}</td><td>${row.items.join(" + ")}</td><td>${row.items.length}</td><td>${sum}</td><td>${waste}</td>`;
    els.tubeRound2Table.appendChild(tr);
  }
}

function downloadCSV(filename, rows) {
  const bom = "﻿";
  const csv = bom + rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

els.downloadTube1Btn.addEventListener("click", () => {
  if (!window.__lastTube) return;
  const rows = [["母管長度(mm)", "母管數量", "組合規格(mm)", "段數", "合計寬度(mm)", "修邊損耗(mm)", "損耗率"]];
  for (const row of window.__lastTube.round1.solution) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    rows.push([row.stockLength, row.count, row.items.join(" + "), row.items.length, sum, waste, ((waste / row.stockLength) * 100).toFixed(2) + "%"]);
  }
  downloadCSV("tube_plan_round1.csv", rows);
});

els.downloadTube2Btn.addEventListener("click", () => {
  if (!window.__lastTube) return;
  const rows = [["母管長度(mm)", "母管數量", "組合規格(mm)", "段數", "合計寬度(mm)", "修邊損耗(mm)"]];
  for (const row of window.__lastTube.round2.solution) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    rows.push([row.stockLength, row.count, row.items.join(" + "), row.items.length, sum, row.stockLength - sum]);
  }
  downloadCSV("tube_plan_round2.csv", rows);
});

els.runBtn.addEventListener("click", runPipeline);

// auto-run once on load with the pre-filled sample data, so results are
// visible immediately without needing to press a button
runPipeline();
