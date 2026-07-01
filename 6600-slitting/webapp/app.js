"use strict";

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
  motherWidth: document.getElementById("motherWidth"),
  minPieces: document.getElementById("minPieces"),
  timeLimit1: document.getElementById("timeLimit1"),
  timeLimit2: document.getElementById("timeLimit2"),
  runBtn: document.getElementById("runBtn"),
  statusBanner: document.getElementById("statusBanner"),
  statusSpinner: document.getElementById("statusSpinner"),
  statusLine: document.getElementById("statusLine"),
  warningsPanel: document.getElementById("warningsPanel"),
  warningsList: document.getElementById("warningsList"),
  summaryPanel: document.getElementById("summaryPanel"),
  summaryCards: document.getElementById("summaryCards"),
  planPanel: document.getElementById("planPanel"),
  planTable: document.getElementById("planTable").querySelector("tbody"),
  fulfillPanel: document.getElementById("fulfillPanel"),
  fulfillTable: document.getElementById("fulfillTable").querySelector("tbody"),
  downloadPlanBtn: document.getElementById("downloadPlanBtn"),
  downloadFulfillBtn: document.getElementById("downloadFulfillBtn"),
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
for (const id of ["motherWidth", "minPieces", "timeLimit1", "timeLimit2"]) {
  els[id].addEventListener("change", autoRun);
}

function setStatus(msg, state) {
  els.statusLine.textContent = msg;
  els.statusBanner.className = "status-banner state-" + (state || "idle");
  els.statusSpinner.hidden = state !== "busy";
}

// ---- parsing ----
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

// ---- pattern generation: all multisets of widths (count >= minPieces)
// summing to exactly motherWidth ----
function generatePatterns(widths, motherWidth, minPieces) {
  const n = widths.length;
  if (n === 0) return [];
  const maxPieces = Math.floor(motherWidth / widths[0]);
  const patterns = [];
  const combo = [];

  function dfs(startIdx, count, total) {
    if (total === motherWidth && count >= minPieces) {
      patterns.push(combo.slice());
      return;
    }
    if (total > motherWidth || count >= maxPieces) return;
    for (let i = startIdx; i < n; i++) {
      const w = widths[i];
      if (total + w > motherWidth) break; // sorted ascending, no smaller options later
      combo.push(w);
      dfs(i, count + 1, total + w);
      combo.pop();
    }
  }

  dfs(0, 0, 0);
  return patterns;
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
function buildLP(patterns, patternCounts, widths, demand, opts) {
  const nPat = patterns.length;
  const lines = [];

  if (opts.mode === "max_fulfill") {
    lines.push("Maximize");
    lines.push(" obj: " + patterns.map((p, i) => `${p.length} x${i}`).join(" + "));
  } else {
    lines.push("Minimize");
    lines.push(" obj: " + patterns.map((_p, i) => `x${i}`).join(" + "));
  }

  lines.push("Subject To");

  // per-width incidence: width -> array of "count xIdx"
  const widthTerms = new Map();
  for (const w of widths) widthTerms.set(String(w), []);
  for (let i = 0; i < nPat; i++) {
    const counts = patternCounts[i];
    for (const key in counts) {
      if (!widthTerms.has(key)) widthTerms.set(key, []);
      widthTerms.get(key).push(`${counts[key]} x${i}`);
    }
  }

  for (const w of widths) {
    const key = String(w);
    const terms = widthTerms.get(key) || [];
    const expr = terms.length ? terms.join(" + ") : `0 x0`;
    lines.push(` c${key}: ${expr} <= ${demand[key] || 0}`);
  }

  if (opts.mode === "min_rolls") {
    const fulfillTerms = patterns.map((p, i) => `${p.length} x${i}`).join(" + ");
    lines.push(` c_fulfill: ${fulfillTerms} >= ${opts.fulfillFloor}`);
  }

  lines.push("General");
  lines.push(patterns.map((_p, i) => `x${i}`).join(" "));
  lines.push("End");

  return lines.join("\n");
}

// ---- stage 3: sequence patterns to minimize total knife movement ----
// Knife positions of a pattern are its cumulative cut points, excluding the
// final roll edge, e.g. widths [2100,2100,2400] -> cut points [2100, 4200].
// Moving from pattern A to pattern B, the cheapest way to realign the knives
// is the 1-D optimal assignment: sort both position lists (padding the
// shorter one with 0s, representing knives parked at the start), then sum
// |a_i - b_i| pairwise - this pairing is provably optimal for 1-D assignment.
function knifePositions(items) {
  const sorted = items.slice().sort((a, b) => a - b);
  const positions = [];
  let cum = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    cum += sorted[i];
    positions.push(cum);
  }
  return positions;
}

function transitionCost(posA, posB) {
  const n = Math.max(posA.length, posB.length);
  const a = posA.slice().sort((x, y) => x - y);
  const b = posB.slice().sort((x, y) => x - y);
  while (a.length < n) a.push(0);
  while (b.length < n) b.push(0);
  a.sort((x, y) => x - y);
  b.sort((x, y) => x - y);
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.abs(a[i] - b[i]);
  return total;
}

// Nearest-neighbor construction (tried from every start) + 2-opt improvement.
// Good enough for the tens-of-patterns scale seen here; not an exact TSP solve.
function sequencePatterns(entries) {
  const n = entries.length;
  if (n <= 1) return { order: entries.map((_, i) => i), totalCost: 0 };

  const positions = entries.map((e) => knifePositions(e.items));
  const dist = [];
  for (let i = 0; i < n; i++) {
    dist.push([]);
    for (let j = 0; j < n; j++) dist[i].push(transitionCost(positions[i], positions[j]));
  }

  function pathCost(order) {
    let c = 0;
    for (let i = 0; i < order.length - 1; i++) c += dist[order[i]][order[i + 1]];
    return c;
  }

  let bestOrder = null;
  let bestCost = Infinity;
  for (let start = 0; start < n; start++) {
    const visited = new Array(n).fill(false);
    const order = [start];
    visited[start] = true;
    let cur = start;
    for (let step = 0; step < n - 1; step++) {
      let next = -1;
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && dist[cur][j] < best) {
          best = dist[cur][j];
          next = j;
        }
      }
      order.push(next);
      visited[next] = true;
      cur = next;
    }
    const cost = pathCost(order);
    if (cost < bestCost) {
      bestCost = cost;
      bestOrder = order;
    }
  }

  let order = bestOrder;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const newOrder = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        const newCost = pathCost(newOrder);
        if (newCost < bestCost - 1e-9) {
          order = newOrder;
          bestCost = newCost;
          improved = true;
        }
      }
    }
  }

  return { order, totalCost: bestCost, dist };
}

// ---- HiGHS wasm loading ----
let highsInstancePromise = null;
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getHighs() {
  if (!highsInstancePromise) {
    const wasmBinary = base64ToUint8Array(window.HIGHS_WASM_BASE64);
    highsInstancePromise = Module({ wasmBinary });
  }
  return highsInstancePromise;
}

async function solveLP(lpText, timeLimitSec) {
  const highs = await getHighs();
  return highs.solve(lpText, { time_limit: timeLimitSec, output_flag: false });
}

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- main pipeline ----
async function runPipeline() {
  els.runBtn.disabled = true;
  els.warningsPanel.hidden = true;
  els.warningsList.innerHTML = "";
  els.summaryPanel.hidden = true;
  els.planPanel.hidden = true;
  els.fulfillPanel.hidden = true;

  try {
    const { widths, demand } = parseOrders(els.ordersText.value);
    if (widths.length === 0) {
      setStatus("找不到有效的訂單資料，請確認格式為「寬度,數量」。", "idle");
      return;
    }

    const motherWidth = Math.round(Number(els.motherWidth.value));
    const minPieces = Math.max(1, Math.round(Number(els.minPieces.value)));
    const t1 = Math.max(1, Number(els.timeLimit1.value) || 15);
    const t2 = Math.max(1, Number(els.timeLimit2.value) || 15);

    if (!Number.isFinite(motherWidth) || motherWidth <= 0) {
      setStatus("母卷寬度必須是正整數。", "error");
      return;
    }

    setStatus("產生所有可行刀路組合中...", "busy");
    await yieldToUI();
    const patterns = generatePatterns(widths, motherWidth, minPieces);

    if (patterns.length === 0) {
      setStatus(
        `在母卷寬度 ${motherWidth}mm、每卷至少 ${minPieces} 刀的限制下，找不到任何「零修邊損耗」的組合，請調整參數。`,
        "error"
      );
      return;
    }

    const patternCounts = patterns.map(patternToCounts);

    // widths that cannot appear in ANY feasible pattern -> guaranteed 0 production
    const coveredWidths = new Set();
    for (const counts of patternCounts) {
      for (const key in counts) coveredWidths.add(key);
    }
    const uncovered = widths.filter((w) => !coveredWidths.has(String(w)) && (demand[String(w)] || 0) > 0);
    if (uncovered.length) {
      els.warningsPanel.hidden = false;
      for (const w of uncovered) {
        const li = document.createElement("li");
        li.textContent = `規格 ${w}mm（訂量 ${demand[String(w)]}）無法組成任何零修邊損耗且刀數 >= ${minPieces} 的刀路，將完全無法排產。`;
        els.warningsList.appendChild(li);
      }
    }

    setStatus(`共產生 ${patterns.length} 種可行刀路，求解最大排產量中（最多 ${t1} 秒）...`, "busy");
    await yieldToUI();
    const lp1 = buildLP(patterns, patternCounts, widths, demand, { mode: "max_fulfill" });
    const sol1 = await solveLP(lp1, t1);

    if (!sol1 || !sol1.Columns || !Number.isFinite(sol1.ObjectiveValue)) {
      setStatus("Stage1 求解失敗，請調整時間上限或參數後再試一次。", "error");
      return;
    }

    const fulfillFloor = Math.round(sol1.ObjectiveValue);

    setStatus(
      `最大可排產量為 ${fulfillFloor} 件（狀態：${sol1.Status}）。求解最少母卷數中（最多 ${t2} 秒）...`,
      "busy"
    );
    await yieldToUI();
    const lp2 = buildLP(patterns, patternCounts, widths, demand, {
      mode: "min_rolls",
      fulfillFloor,
    });
    const sol2 = await solveLP(lp2, t2);

    if (!sol2 || !sol2.Columns) {
      setStatus("Stage2 求解失敗，請調整時間上限或參數後再試一次。", "error");
      return;
    }

    // ---- extract solution ----
    const solutionRows = [];
    let totalRolls = 0;
    const produced = {};
    for (const w of widths) produced[String(w)] = 0;

    for (let i = 0; i < patterns.length; i++) {
      const col = sol2.Columns[`x${i}`];
      if (!col) continue;
      const count = Math.round(col.Primal || 0);
      if (count <= 0) continue;
      totalRolls += count;
      const items = patterns[i].slice().sort((a, b) => a - b);
      for (const w of items) {
        const key = String(w);
        produced[key] = (produced[key] || 0) + count;
      }
      solutionRows.push({ items, count });
    }

    setStatus(`排出 ${solutionRows.length} 種刀路，計算刀具移動距離最小的生產順序中...`, "busy");
    await yieldToUI();
    const { order, totalCost } = sequencePatterns(solutionRows);
    const sequencedRows = order.map((i, seqIdx) => {
      const row = solutionRows[i];
      const prev = seqIdx === 0 ? null : solutionRows[order[seqIdx - 1]];
      const move = prev ? transitionCost(knifePositions(prev.items), knifePositions(row.items)) : 0;
      return { ...row, seq: seqIdx + 1, move };
    });

    const totalDemand = widths.reduce((s, w) => s + (demand[String(w)] || 0), 0);
    const totalProduced = widths.reduce((s, w) => s + (produced[String(w)] || 0), 0);

    renderSummary({
      totalDemand,
      totalProduced,
      shortfall: totalDemand - totalProduced,
      totalRolls,
      patternTypes: sequencedRows.length,
      totalKnifeMovement: totalCost,
      stage1Status: sol1.Status,
      stage2Status: sol2.Status,
    });
    renderPlanTable(sequencedRows);
    renderFulfillTable(widths, demand, produced);

    setStatus(
      `完成。共排產 ${totalProduced}/${totalDemand} 件，缺口 ${totalDemand - totalProduced} 件，使用 ${totalRolls} 支母卷，${sequencedRows.length} 種刀路，建議生產順序總刀具移動距離 ${totalCost}mm。`,
      totalDemand - totalProduced > 0 ? "warn" : "ok"
    );

    window.__lastPlan = sequencedRows;
    window.__lastFulfill = widths.map((w) => ({
      width: w,
      demand: demand[String(w)] || 0,
      produced: produced[String(w)] || 0,
    }));
  } catch (err) {
    console.error(err);
    setStatus("發生錯誤：" + (err && err.message ? err.message : String(err)), "error");
  } finally {
    els.runBtn.disabled = false;
  }
}

function renderSummary({
  totalDemand,
  totalProduced,
  shortfall,
  totalRolls,
  patternTypes,
  totalKnifeMovement,
  stage1Status,
  stage2Status,
}) {
  els.summaryPanel.hidden = false;
  const pct = totalDemand > 0 ? ((totalProduced / totalDemand) * 100).toFixed(1) : "0.0";
  const cards = [
    { label: "總訂量 (件)", value: totalDemand },
    { label: "已排產 (件)", value: totalProduced },
    { label: "滿足率", value: pct + "%", tone: totalDemand > 0 && totalProduced === totalDemand ? "good" : "" },
    { label: "缺口 (件)", value: shortfall, tone: shortfall > 0 ? "warn" : "good" },
    { label: "使用母卷數", value: totalRolls },
    { label: "刀路種類數", value: patternTypes },
    { label: "刀具總移動距離 (mm)", value: totalKnifeMovement },
    { label: "求解狀態", value: `${stage1Status} / ${stage2Status}` },
  ];
  els.summaryCards.innerHTML = "";
  for (const c of cards) {
    const div = document.createElement("div");
    div.className = "card" + (c.tone ? " " + c.tone : "");
    div.innerHTML = `<div class="value">${c.value}</div><div class="label">${c.label}</div>`;
    els.summaryCards.appendChild(div);
  }
}

function renderPlanTable(rows) {
  els.planPanel.hidden = false;
  els.planTable.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.seq}</td><td>${row.count}</td><td>${row.items.join(" + ")}</td><td>${row.items.length}</td><td>${row.items.reduce((s, w) => s + w, 0)}</td><td>${row.move}</td>`;
    els.planTable.appendChild(tr);
  }
}

function renderFulfillTable(widths, demand, produced) {
  els.fulfillPanel.hidden = false;
  els.fulfillTable.innerHTML = "";
  for (const w of widths) {
    const key = String(w);
    const d = demand[key] || 0;
    const p = produced[key] || 0;
    const diff = d - p;
    const tr = document.createElement("tr");
    const badgeClass = diff > 0 ? "short" : "ok";
    const statusText = diff > 0 ? "缺口" : "已滿足";
    tr.innerHTML = `<td>${w}</td><td>${d}</td><td>${p}</td><td>${diff}</td><td><span class="badge ${badgeClass}">${statusText}</span></td>`;
    els.fulfillTable.appendChild(tr);
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

els.downloadPlanBtn.addEventListener("click", () => {
  if (!window.__lastPlan) return;
  const rows = [["生產順序", "母卷數量", "裁切規格(mm)", "刀數", "合計寬度(mm)", "與前一刀路刀具移動距離(mm)"]];
  for (const row of window.__lastPlan) {
    rows.push([row.seq, row.count, row.items.join(" + "), row.items.length, row.items.reduce((s, w) => s + w, 0), row.move]);
  }
  downloadCSV("cutting_plan.csv", rows);
});

els.downloadFulfillBtn.addEventListener("click", () => {
  if (!window.__lastFulfill) return;
  const rows = [["規格(mm)", "訂量", "已排產", "差額"]];
  for (const r of window.__lastFulfill) {
    rows.push([r.width, r.demand, r.produced, r.demand - r.produced]);
  }
  downloadCSV("fulfillment.csv", rows);
});

els.runBtn.addEventListener("click", runPipeline);

// auto-run once on load with the pre-filled sample data, so results are
// visible immediately without needing to press a button
runPipeline();
