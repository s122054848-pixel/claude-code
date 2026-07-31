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
  statusProgressWrap: document.getElementById("statusProgressWrap"),
  statusProgressFill: document.getElementById("statusProgressFill"),
  tubeLen1: document.getElementById("tubeLen1"),
  tubeLen2: document.getElementById("tubeLen2"),
  tubeLen3: document.getElementById("tubeLen3"),
  tubeLen4: document.getElementById("tubeLen4"),
  tubeWasteTol: document.getElementById("tubeWasteTol"),
  tubeStageTimeLimit: document.getElementById("tubeStageTimeLimit"),
  deepSearchTypes: document.getElementById("deepSearchTypes"),
  deepSearchTimeLimit: document.getElementById("deepSearchTimeLimit"),
  tubeR2Len1: document.getElementById("tubeR2Len1"),
  tubeR2Len2: document.getElementById("tubeR2Len2"),
  tubeR2Len3: document.getElementById("tubeR2Len3"),
  tubeR2Len4: document.getElementById("tubeR2Len4"),
  tubeSummaryPanel: document.getElementById("tubeSummaryPanel"),
  tubeSummaryCards: document.getElementById("tubeSummaryCards"),
  orderDetailPanel: document.getElementById("orderDetailPanel"),
  orderDetailTable: document.getElementById("orderDetailTable").querySelector("tbody"),
  downloadOrderDetailBtn: document.getElementById("downloadOrderDetailBtn"),
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

// Deep search only has a chance of improving on the fast-mode result if
// the underlying max_fulfill/min_rolls stages themselves converge to
// Optimal first - a 60s budget is often not enough for that on harder
// datasets, so bump the shared stage time limit to 300s when deep search
// is turned on, and back to 60s when turned off.
els.deepSearchTypes.addEventListener("change", () => {
  els.tubeStageTimeLimit.value = els.deepSearchTypes.checked ? 300 : 45;
});

// A single solve can legitimately take tens of seconds, during which only
// one or two status lines would otherwise change - which can look identical
// to a frozen/broken page. Show a live elapsed-time counter while busy, plus
// (when the caller knows the current stage's time budget) a progress bar
// showing how far into that budget the stage has gotten - see webapp/app.js
// for the full rationale (not a solution-quality/gap measure, just a "how
// much of its allotted time has this step used" indicator).
let elapsedTimer = null;
let pipelineStartTime = null;
let lastBusyMsg = "";
let stageStartTime = null;
let stageCapSec = null;

function updateBusyStatusLine() {
  const totalS = Math.round((Date.now() - pipelineStartTime) / 1000);
  let text = `${lastBusyMsg}（已運算 ${totalS} 秒`;
  if (stageCapSec) {
    const stageS = Math.round((Date.now() - stageStartTime) / 1000);
    const pct = Math.max(0, Math.min(99, Math.round((stageS / stageCapSec) * 100)));
    text += `，本階段進度約 ${pct}%（上限 ${stageCapSec} 秒）`;
    els.statusProgressWrap.hidden = false;
    els.statusProgressFill.style.width = pct + "%";
  } else {
    els.statusProgressWrap.hidden = true;
  }
  els.statusLine.textContent = text + "）";
}

function setStatus(msg, state, stageCap) {
  if (state === "busy") {
    lastBusyMsg = msg;
    if (!pipelineStartTime) pipelineStartTime = Date.now();
    if (stageCap !== stageCapSec) {
      stageCapSec = stageCap || null;
      stageStartTime = Date.now();
    }
    if (!elapsedTimer) elapsedTimer = setInterval(updateBusyStatusLine, 1000);
    updateBusyStatusLine();
  } else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    pipelineStartTime = null;
    stageStartTime = null;
    stageCapSec = null;
    els.statusLine.textContent = msg;
    els.statusProgressWrap.hidden = true;
    els.statusProgressFill.style.width = "0%";
  }
  els.statusBanner.className = "status-banner state-" + (state || "idle");
  els.statusSpinner.hidden = state !== "busy";
}

// ---- parsing: each row is (寬度, 訂量) = a tube-segment width and how many
// segments of it are needed - this IS the tube demand directly, no
// slitting/cutting-plan stage in between. ----
// Accepts two input shapes per line:
//  - simple "寬度,數量" (or space-separated) pairs, e.g. "2100,149" - kept as
//    an orderRow with blank order/customer/item metadata
//  - the ERP order export format: 訂單編號,項次,客戶編號,客戶名稱,料號,門幅,需求量
//    (>= 7 comma-separated columns), where 門幅/需求量 are columns 6 and 7
//    (index 5/6) - all columns are retained per-row in orderRows so later
//    stages can trace a produced piece back to its originating order/item;
//    demand/widths still aggregate by 門幅 (summed across all matching rows)
//    for the solver, which only cares about totals per width.
function parseOrders(text) {
  const widths = [];
  const demand = {};
  const orderRows = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const commaParts = line.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length);
    let w, q, orderNo, seq, custNo, custName, itemNo;
    if (commaParts.length >= 7) {
      [orderNo, seq, custNo, custName, itemNo] = commaParts;
      w = Number(commaParts[5]);
      q = Number(commaParts[6]);
    } else {
      const parts = line.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s.length);
      if (parts.length < 2) continue;
      w = Number(parts[0]);
      q = Number(parts[1]);
      orderNo = seq = custNo = custName = itemNo = "";
    }
    if (!Number.isFinite(w) || !Number.isFinite(q)) continue; // header or bad row
    if (w <= 0) continue;
    const key = String(w);
    if (!(key in demand)) widths.push(w);
    const qty = Math.max(0, Math.round(q));
    demand[key] = (demand[key] || 0) + qty;
    orderRows.push({ orderNo, seq, custNo, custName, itemNo, width: w, qty });
  }
  widths.sort((a, b) => a - b);
  return { widths, demand, orderRows };
}

// Breaks a sequenced production plan (rows of {seq, count, items}, as
// rendered in the Round1/Round2 tables) into a per-width FIFO queue of
// {label, qty} chunks - see webapp/app.js for the full rationale.
function buildSeqQueues(sequencedRows, labelFn) {
  const queues = {};
  for (const row of sequencedRows) {
    const label = labelFn(row);
    const counts = patternToCounts(row.items);
    for (const key in counts) {
      const qty = row.count * counts[key];
      if (!queues[key]) queues[key] = [];
      queues[key].push({ label, qty });
    }
  }
  return queues;
}

// Concatenates two per-width seq-queue sets (Round1 chunks followed by
// Round2 chunks) into one, preserving chunk order within each width.
function mergeSeqQueues(a, b) {
  const merged = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    merged[key] = [...(a[key] || []), ...(b[key] || [])];
  }
  return merged;
}

// Allocates a solved per-width production total back down to the individual
// order rows that requested that width, first-come-first-served in the
// original row order - see webapp/app.js for the full rationale. If
// seqQueues is given, also reports which cutting-sequence position(s) each
// order row was actually cut at.
function allocateToOrderRows(orderRows, produced, seqQueues) {
  const remaining = {};
  for (const key in produced) remaining[key] = produced[key];
  const queues = {};
  if (seqQueues) {
    for (const key in seqQueues) queues[key] = seqQueues[key].map((c) => ({ ...c }));
  }
  return orderRows.map((row) => {
    const key = String(row.width);
    const avail = remaining[key] || 0;
    const fulfilled = Math.min(row.qty, avail);
    remaining[key] = avail - fulfilled;

    const cutSeqLabels = [];
    if (queues[key]) {
      let need = fulfilled;
      while (need > 0 && queues[key].length > 0) {
        const chunk = queues[key][0];
        const take = Math.min(need, chunk.qty);
        if (take > 0 && !cutSeqLabels.includes(chunk.label)) cutSeqLabels.push(chunk.label);
        chunk.qty -= take;
        need -= take;
        if (chunk.qty <= 0) queues[key].shift();
      }
    }

    return { ...row, fulfilled, shortfall: row.qty - fulfilled, cutSeq: cutSeqLabels.join(", ") };
  });
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
// opts.weightFn(width): per-unit-width coefficient used in the "max_fulfill"
// objective, defaulting to a flat 1 (plain piece-count maximization). Passing
// e.g. (w) => w instead maximizes total fulfilled *width*, which - for a
// fixed total piece count (see opts.fulfillFloor below) - biases the chosen
// mix towards fulfilling larger widths over smaller ones.
// opts.fulfillFloor: if set, adds a "total fulfilled pieces >= floor"
// constraint regardless of mode (used both to pin "min_rolls" to the
// max-fulfillment stage's result, and to pin a weighted re-solve to not
// regress below the plain max).
// opts.perWidthFloor: { [width]: minCount } - adds a per-width "fulfilled
// >= minCount" constraint for each listed width, used to carry a
// large-width-priority allocation (computed by a weighted solve) forward
// into the min-rolls stage so roll-count optimization can't undo it.
function buildLP(patterns, patternCounts, widths, demand, opts) {
  const nPat = patterns.length;
  const minBatch = opts.minBatch || 0;
  const weightFn = opts.weightFn || (() => 1);
  // "min_types" (minimize how many distinct patterns are used, e.g. after
  // rolls are already minimized) needs the same x_i<=U_i*y_i "is this
  // pattern used at all" linkage that minBatch semi-continuity uses, but
  // for every pattern, not just when minBatch>1.
  const useTypeBinary = minBatch > 1 || opts.mode === "min_types";
  const lines = [];

  const activeIdx = [];
  const upperBound = new Array(nPat);
  for (let i = 0; i < nPat; i++) {
    if (useTypeBinary) {
      let U = Infinity;
      const counts = patternCounts[i];
      for (const key in counts) {
        U = Math.min(U, Math.floor((demand[key] || 0) / counts[key]));
      }
      // No single pattern's count can exceed the total roll cap either -
      // tightening the "big-M" bound this way doesn't cut off any feasible
      // solution (it's already implied by c_rollcap + x>=0), but a looser
      // bound here directly weakens the LP relaxation the MIP solver
      // branches against, so this can materially speed up how fast it
      // closes the gap - most useful for min_types, where U from demand
      // alone is often much larger than the roll cap.
      if (opts.rollCap != null) U = Math.min(U, opts.rollCap);
      upperBound[i] = U;
      if (minBatch > 1 && U < minBatch) continue;
    }
    activeIdx.push(i);
  }

  if (opts.mode === "min_types") {
    lines.push("Minimize");
    lines.push(" obj: " + (activeIdx.length ? activeIdx.map((i) => `y${i}`).join(" + ") : "0"));
  } else if (opts.mode === "min_rolls") {
    lines.push("Minimize");
    lines.push(" obj: " + (activeIdx.length ? activeIdx.map((i) => `x${i}`).join(" + ") : "0"));
  } else {
    lines.push("Maximize");
    lines.push(
      " obj: " +
        (activeIdx.length
          ? activeIdx
              .map((i) => `${patterns[i].reduce((s, w) => s + weightFn(w), 0)} x${i}`)
              .join(" + ")
          : "0")
    );
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

  if (opts.fulfillFloor != null) {
    const fulfillTerms = activeIdx.length ? activeIdx.map((i) => `${patterns[i].length} x${i}`).join(" + ") : "0 dummy";
    lines.push(` c_fulfill: ${fulfillTerms} >= ${opts.fulfillFloor}`);
  }

  if (opts.perWidthFloor) {
    for (const w of widths) {
      const floor = opts.perWidthFloor[String(w)] || 0;
      if (floor <= 0) continue;
      const key = String(w);
      const terms = widthTerms.get(key) || [];
      const expr = terms.length ? terms.join(" + ") : activeIdx.length ? `0 x${activeIdx[0]}` : "0 dummy";
      lines.push(` cfloor_${key}: ${expr} >= ${floor}`);
    }
  }

  if (opts.rollCap != null) {
    const rollTerms = activeIdx.length ? activeIdx.map((i) => `x${i}`).join(" + ") : "0 dummy";
    lines.push(` c_rollcap: ${rollTerms} <= ${opts.rollCap}`);
  }

  if (useTypeBinary) {
    for (const i of activeIdx) {
      lines.push(` cub_${i}: x${i} - ${upperBound[i]} y${i} <= 0`);
      if (minBatch > 1) {
        lines.push(` clb_${i}: x${i} - ${minBatch} y${i} >= 0`);
      }
    }
  }

  lines.push("General");
  lines.push(activeIdx.map((i) => `x${i}`).join(" "));

  if (useTypeBinary) {
    lines.push("Binary");
    lines.push(activeIdx.map((i) => `y${i}`).join(" "));
  }

  lines.push("End");

  return lines.join("\n");
}

// ---- sequence tube patterns to minimize total cutting-blade movement ----
// Cut positions of a pattern are its cumulative segment boundaries,
// excluding the final tube edge, e.g. widths [2100,2500] -> cut points
// [2100]. Moving from pattern A to pattern B, the cheapest way to realign
// the blades is the 1-D optimal assignment: sort both position lists
// (padding the shorter one with 0s, representing blades parked at the
// start), then sum |a_i - b_i| pairwise - this pairing is provably optimal
// for 1-D assignment.
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

// Nearest-neighbor construction (tried from every start) + delta-based
// 2-opt improvement (O(1) cost delta per candidate swap, in-place reversal
// only on acceptance - see webapp/app.js for the complexity rationale).
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

  const order = bestOrder.slice();
  let totalCost = bestCost;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      const a = order[i - 1];
      let b = order[i];
      let dab = dist[a][b];
      for (let j = i + 1; j < n; j++) {
        const c = order[j];
        const d = j + 1 < n ? order[j + 1] : null;
        const oldEdges = dab + (d !== null ? dist[c][d] : 0);
        const newEdges = dist[a][c] + (d !== null ? dist[b][d] : 0);
        if (newEdges < oldEdges - 1e-9) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = order[lo];
            order[lo] = order[hi];
            order[hi] = tmp;
            lo++;
            hi--;
          }
          totalCost += newEdges - oldEdges;
          improved = true;
          b = order[i];
          dab = dist[a][b];
        }
      }
    }
  }

  return { order, totalCost, dist };
}

// Sequence a solved tube round's pattern list into the movement-minimizing
// production order, attaching seq (order number) and move (distance from
// the previous pattern) to each row.
function sequenceTubeRows(solutionRows) {
  if (solutionRows.length === 0) return { rows: [], totalCost: 0 };
  const { order, totalCost } = sequencePatterns(solutionRows);
  const rows = order.map((i, seqIdx) => {
    const row = solutionRows[i];
    const prev = seqIdx === 0 ? null : solutionRows[order[seqIdx - 1]];
    const move = prev ? transitionCost(knifePositions(prev.items), knifePositions(row.items)) : 0;
    return { ...row, seq: seqIdx + 1, move };
  });
  return { rows, totalCost };
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

// A min_rolls solve only minimizes the *total* roll count - many different
// pattern combinations can tie for that same total, and it has no
// preference among them for how many distinct patterns make it up. This
// runs one more solve, capped at the roll count already achieved (never
// allowed to regress it) and requiring at least the fulfillment already
// achieved, that instead minimizes how many distinct patterns are used -
// fewer setups on the machine for the same output.
//
// Searching over every pattern the mother width could generate turns this
// into a cardinality-minimization MIP over hundreds of 0/1 variables - an
// NP-hard problem that can take many minutes to *prove* minimal even
// though a good incumbent shows up almost instantly. By default this
// restricts the candidate pool to just the patterns the roll-minimizing
// stage actually used (rows) - typically a few dozen, not several
// hundred - which keeps the search fast (seconds).
//
// Important caveat, confirmed by comparing against a real human-planned
// solution for the same order: a plain min_rolls solve is indifferent
// among many equally-optimal roll-count solutions, so it only ever
// reveals ONE arbitrary set of "active" patterns - restricting the
// search to just that set can structurally exclude the patterns a truly
// minimal solution needs. (Measured: a human planner's 25-pattern
// solution needed 14 patterns that simply weren't in our 57-pattern
// pool at all - no amount of searching within that pool could ever have
// found them, which is why the fast default here caps out around
// 30-something rather than approaching a human planner's result.) See
// deepSearchMinTypes below for the slower opt-in mode that addresses
// this with a much richer candidate pool searched concurrently.
//
// Unlike max_fulfill/min_rolls, an unproven answer here carries no real
// risk: every candidate this LP considers already satisfies the roll cap
// and fulfillment floor as hard constraints, so any feasible solution it
// returns is automatically safe to use - "not proven minimal" just means
// the pattern count might be a bit more than the true best, never a real
// production regression. Falls back to the input unchanged if it can't
// find an equally-good solution in time.
const TYPE_MINIMIZATION_TIME_LIMIT_SEC = 15;
const DEEP_SEARCH_TYPES_TIME_LIMIT_SEC = 45;
const DEEP_SEARCH_RELAX_TIME_LIMIT_SEC = 30;
const DEEP_SEARCH_SAMPLE_SIZE = 200;

// Deep search's per-worker search budget is user-configurable (separate
// from the tube-stage's own time-limit field, which governs the much
// smaller/faster fast-mode path) since the two solve fundamentally
// different-sized problems and a harder dataset may need a much larger
// deep-search budget without also inflating every other stage's time limit.
function getDeepSearchTimeLimitSec() {
  const v = els.deepSearchTimeLimit && Math.round(Number(els.deepSearchTimeLimit.value));
  return Number.isFinite(v) && v > 0 ? v : DEEP_SEARCH_TYPES_TIME_LIMIT_SEC;
}

// Deep search: finds a rich set of alternative candidate patterns via LP
// sensitivity analysis, then searches it with several concurrent workers
// instead of one sequential solve.
//
// Step 1 - find candidates fast: relaxing the min_rolls problem to a
// plain LP (dropping the General/Binary declarations - HiGHS only
// reports a Dual/reduced-cost value per column for LPs, not MIPs) and
// solving it ONCE identifies every pattern with (near-)zero reduced
// cost - i.e. every pattern that could appear in some equally-optimal
// roll-count solution - in a single sub-second solve (measured: 0.05s on
// an 803-pattern instance, versus ~180s for an earlier version that
// re-solved the MIP a dozen times with random objective perturbations to
// get the same information).
//
// Step 2 - search it concurrently, not sequentially: that reduced-cost
// set is usually still too large to hand a cardinality-minimizing MIP
// directly (measured: worse results within a time budget than a smaller
// sample), so several *different* random samples of it are dispatched to
// independent Web Workers at once (verified: N workers finish in ~1x
// their shared time_limit, not Nx - genuine OS-thread parallelism, even
// though HiGHS itself has no internal multi-threading in this WASM
// build) and the best result across all of them is kept. This also fixes
// the earlier single-sample version's run-to-run unreliability (one run
// could land on a mediocre sample and show no improvement at all) -
// trying several samples per run makes getting at least one good one far
// more likely.
async function deepSearchMinTypes(patternsFull, patternCounts, widths, demand, baseOpts, rows, produced, deepSearchTimeLimitSec) {
  const totalRolls = rows.reduce((s, r) => s + r.count, 0);
  const totalPieces = Object.values(produced).reduce((a, b) => a + b, 0);
  const patterns = patternsFull.map((p) => p.items);

  const relaxLp = buildLP(patterns, patternCounts, widths, demand, { ...baseOpts, mode: "min_rolls" });
  const generalIdx = relaxLp.indexOf("\nGeneral");
  const relaxedLp = generalIdx >= 0 ? relaxLp.slice(0, generalIdx) + "\nEnd" : relaxLp;
  const relaxSol = await solveLP(relaxedLp, DEEP_SEARCH_RELAX_TIME_LIMIT_SEC);

  const initialKeys = new Set(rows.map((r) => r.items.join(",")));
  const candIdx = [];
  if (relaxSol && relaxSol.Columns) {
    for (let i = 0; i < patterns.length; i++) {
      const col = relaxSol.Columns[`x${i}`];
      const key = patterns[i].join(",");
      if (col && Math.abs(col.Dual) < 1e-6 && !initialKeys.has(key)) candIdx.push(i);
    }
  }

  const pool = getWorkerPool();
  // Deep search's own time budget is user-configurable and intentionally
  // NOT coupled to the fast-mode stage's own time limit - see
  // getDeepSearchTimeLimitSec above.
  const cappedTimeLimit = deepSearchTimeLimitSec;
  const hardMs = hardTimeoutMsFor(cappedTimeLimit);

  const jobs = pool.map(async (worker) => {
    const shuffled = candIdx.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sampledIdx = shuffled.slice(0, DEEP_SEARCH_SAMPLE_SIZE);
    const poolPatterns = rows.map((r) => r.items).concat(sampledIdx.map((i) => patterns[i]));
    const poolCounts = poolPatterns.map(patternToCounts);
    const poolPatternsFull = rows.map((r) => ({ ...r })).concat(sampledIdx.map((i) => patternsFull[i]));
    const lp = buildLP(poolPatterns, poolCounts, widths, demand, {
      ...baseOpts,
      mode: "min_types",
      rollCap: totalRolls,
    });
    let sol;
    try {
      sol = await withHardTimeout(
        solveOnWorker(worker, lp, {
          time_limit: cappedTimeLimit,
          output_flag: false,
          mip_rel_gap: MIP_REL_GAP,
          mip_abs_gap: 2,
        }),
        hardMs
      );
    } catch (err) {
      return null;
    }
    const ext = extractPatternSolution(sol, poolPatternsFull, widths);
    const extRolls = ext.rows.reduce((s, r) => s + r.count, 0);
    if (sol && extRolls > 0 && extRolls <= totalRolls + 0.5 && ext.totalProduced >= totalPieces - 0.5) {
      return { rows: ext.rows, produced: ext.produced, status: sol.Status };
    }
    return null;
  });

  const results = await Promise.all(jobs);
  let best = null;
  for (const r of results) {
    if (r && (!best || r.rows.length < best.rows.length)) best = r;
  }
  if (best) return best;
  return { rows, produced, status: "Failed（未找到更少種類的可行解，維持原刀路）" };
}

async function minimizeTypeCount(widths, demand, baseOpts, rows, produced, timeLimitSec, deepSearch) {
  const totalRolls = rows.reduce((s, r) => s + r.count, 0);
  if (totalRolls <= 0) return { rows, produced, status: "N/A" };
  if (deepSearch && deepSearch.patternsFull && deepSearch.patternCounts) {
    return deepSearchMinTypes(
      deepSearch.patternsFull,
      deepSearch.patternCounts,
      widths,
      demand,
      baseOpts,
      rows,
      produced,
      deepSearch.timeLimitSec
    );
  }
  const totalPieces = Object.values(produced).reduce((a, b) => a + b, 0);
  const activePatterns = rows.map((r) => r.items);
  const activePatternCounts = activePatterns.map(patternToCounts);
  // Keep every field from the original row (e.g. stockLength on tube-plan
  // patterns), not just items - extractPatternSolution below only
  // overwrites `count`, so anything else (like stockLength) needs to
  // already be present or it comes back undefined.
  const activePatternsFull = rows.map((r) => ({ ...r }));
  const lp = buildLP(activePatterns, activePatternCounts, widths, demand, {
    ...baseOpts,
    mode: "min_types",
    rollCap: totalRolls,
  });
  const cappedTimeLimit = Math.min(timeLimitSec, TYPE_MINIMIZATION_TIME_LIMIT_SEC);
  const sol = await solveLP(lp, cappedTimeLimit, { mip_abs_gap: 2 });
  const ext = extractPatternSolution(sol, activePatternsFull, widths);
  const extRolls = ext.rows.reduce((s, r) => s + r.count, 0);
  if (sol && extRolls > 0 && extRolls <= totalRolls + 0.5 && ext.totalProduced >= totalPieces - 0.5) {
    return { rows: ext.rows, produced: ext.produced, status: sol.Status };
  }
  return { rows, produced, status: (sol ? sol.Status : "Failed") + "（未找到更少種類的可行解，維持原刀路）" };
}

// Generic three-stage solve over an arbitrary set of {items, stockLength}
// patterns - reuses buildLP/solveLP since the LP itself only cares about
// widths, not the actual stock length:
//   1. max fulfillment (plain piece count) -> fulfillFloor
//   2. among solutions achieving fulfillFloor, maximize total fulfilled
//      *width* (weightFn = width) -> a per-width allocation that prioritizes
//      larger widths without sacrificing the overall fulfillment rate
//   3. min tube count, pinned to stage 2's per-width allocation so
//      roll-count optimization can't trade large-width fulfillment away
async function solveTubeStage(patternsFull, widths, demand, t1, t2, label, deepSearchEnabled) {
  if (patternsFull.length === 0 || widths.length === 0) {
    return { solution: [], produced: {}, status1: "N/A", status2: "N/A", status3: "N/A" };
  }
  const tag = label || "紙管";
  const itemsList = patternsFull.map((p) => p.items);
  const counts = itemsList.map(patternToCounts);
  const lp1 = buildLP(itemsList, counts, widths, demand, { mode: "max_fulfill" });
  setStatus(`${tag}：求解最大排產量中（最多 ${t1} 秒）...`, "busy", t1);
  await yieldToUI();
  const sol1 = await solveMaxFulfillConcurrent(lp1, t1);
  const fulfillFloor = Math.round((sol1 && sol1.ObjectiveValue) || 0);

  const lpPriority = buildLP(itemsList, counts, widths, demand, {
    mode: "max_fulfill",
    fulfillFloor,
    weightFn: (w) => w,
  });
  setStatus(`${tag}：最大排產量 ${fulfillFloor} 件，求解大尺寸優先分配中（最多 ${t1} 秒）...`, "busy", t1);
  await yieldToUI();
  const solPriority = await solveLP(lpPriority, t1);
  let extPriority = extractPatternSolution(solPriority, patternsFull, widths);
  if (extPriority.totalProduced < fulfillFloor - 0.5) {
    // weighted re-solve failed to reach the floor (timed out with no
    // incumbent) - fall back to stage1's own (unweighted) solution.
    extPriority = extractPatternSolution(sol1, patternsFull, widths);
  }
  const priorityFloor = {};
  for (const w of widths) priorityFloor[String(w)] = extPriority.produced[String(w)] || 0;

  const lp2 = buildLP(itemsList, counts, widths, demand, {
    mode: "min_rolls",
    fulfillFloor,
    perWidthFloor: priorityFloor,
  });
  setStatus(`${tag}：求解最少母管數中（最多 ${t2} 秒）...`, "busy", t2);
  await yieldToUI();
  const sol2 = await solveLP(lp2, t2);

  let ext = extractPatternSolution(sol2, patternsFull, widths);
  if (ext.totalProduced < fulfillFloor - 0.5) {
    // stage3 failed to find any solution meeting the per-width floors
    // (timed out with no incumbent) - fall back to stage2's own solution,
    // which is already known to achieve them.
    ext = extPriority;
  }

  const deepSearchTimeLimitSec = getDeepSearchTimeLimitSec();
  const typesCap = deepSearchEnabled ? deepSearchTimeLimitSec : TYPE_MINIMIZATION_TIME_LIMIT_SEC;
  setStatus(
    `${tag}：最小化組合種類數中（${deepSearchEnabled ? "深度搜索，" : ""}最多 ${typesCap} 秒）...`,
    "busy",
    typesCap
  );
  await yieldToUI();
  const typesResult = await minimizeTypeCount(
    widths,
    demand,
    { fulfillFloor, perWidthFloor: priorityFloor },
    ext.rows,
    ext.produced,
    t2,
    deepSearchEnabled ? { patternsFull, patternCounts: counts, timeLimitSec: deepSearchTimeLimitSec } : null
  );
  const rows = typesResult.rows.slice().sort((a, b) => b.count - a.count);

  return {
    solution: rows,
    produced: typesResult.produced,
    status1: sol1 ? sol1.Status : "Failed",
    status2: sol2 ? sol2.Status : "Failed",
    status3: typesResult.status,
  };
}

function readLengthList(ids) {
  return ids
    .map((id) => Math.round(Number(els[id].value)))
    .filter((v) => Number.isFinite(v) && v > 0);
}

// The tube-plan patterns are far fewer/simpler than a full slitting problem
// and consistently solve in a few seconds, so each stage gets its own small
// time budget. Round1 and Round2 each run 3 stages (max-fulfill,
// large-width-priority re-solve, then min-tubes), so at this per-stage cap
// the absolute worst case for round1+round2 combined is 6 * cap; default
// 12s keeps that at 72s.
async function runTubePlan(demand, widths) {
  const tubeStageCap = Math.max(1, Math.round(Number(els.tubeStageTimeLimit.value)) || 60);
  const round1Lengths = readLengthList(["tubeLen1", "tubeLen2", "tubeLen3", "tubeLen4"]);
  const round2Lengths = readLengthList(["tubeR2Len1", "tubeR2Len2", "tubeR2Len3", "tubeR2Len4"]);
  const wasteTol = Math.max(0, Number(els.tubeWasteTol.value) || 0) / 100;
  const deepSearchEnabled = !!(els.deepSearchTypes && els.deepSearchTypes.checked);

  const tubeWidths = widths.filter((w) => (demand[String(w)] || 0) > 0).sort((a, b) => a - b);
  const tubeDemand = {};
  for (const w of tubeWidths) tubeDemand[String(w)] = demand[String(w)];

  // Round1 never uses deep search - avoids paying the ~30-75s deep-search
  // cost (relaxation solve + worker-pool search) twice, once per round,
  // back to back.
  const round1Patterns = generateRound1TubePatterns(tubeWidths, round1Lengths, wasteTol);
  const round1 = await solveTubeStage(round1Patterns, tubeWidths, tubeDemand, tubeStageCap, tubeStageCap, "Round1", false);

  const remainingWidths = tubeWidths.filter(
    (w) => tubeDemand[String(w)] - (round1.produced[String(w)] || 0) > 0
  );
  const remainingDemand = {};
  for (const w of remainingWidths) {
    remainingDemand[String(w)] = tubeDemand[String(w)] - (round1.produced[String(w)] || 0);
  }

  let round2 = { solution: [], produced: {}, status1: "N/A", status2: "N/A", status3: "N/A" };
  if (remainingWidths.length > 0 && round2Lengths.length > 0) {
    const round2Patterns = generateBoundedTubePatterns(remainingWidths, round2Lengths);
    round2 = await solveTubeStage(round2Patterns, remainingWidths, remainingDemand, tubeStageCap, tubeStageCap, "Round2", deepSearchEnabled);
  }

  const totalDemand = tubeWidths.reduce((s, w) => s + tubeDemand[String(w)], 0);
  const round1Total = Object.values(round1.produced).reduce((a, b) => a + b, 0);
  const round2Total = Object.values(round2.produced).reduce((a, b) => a + b, 0);
  const round1Tubes = round1.solution.reduce((s, r) => s + r.count, 0);
  const round2Tubes = round2.solution.reduce((s, r) => s + r.count, 0);

  // Sequence each round's patterns into the blade-movement-minimizing
  // production order (Round1 and Round2 use different mother-tube stock, so
  // each is sequenced independently rather than as one combined run).
  const round1Seq = sequenceTubeRows(round1.solution);
  const round2Seq = sequenceTubeRows(round2.solution);

  return {
    round1Lengths,
    round2Lengths,
    wasteTol,
    tubeWidths,
    tubeDemand,
    round1,
    round2,
    round1SequencedRows: round1Seq.rows,
    round2SequencedRows: round2Seq.rows,
    round1Movement: round1Seq.totalCost,
    round2Movement: round2Seq.totalCost,
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

// A pool of *independent* Workers (each with its own HiGHS-WASM instance),
// separate from the single `highsWorker` used for the main sequential
// pipeline above. HiGHS itself has no internal multi-threading in this
// WASM build, but the browser can genuinely run several Worker instances
// on separate OS threads at once - used only by deep search's "try
// several different candidate samples and keep the best" step, where
// trying more samples in the same wall-clock budget matters more than the
// mainline pipeline's simplicity. Verified: 4 workers solving 4 different
// samples concurrently finish in ~1x their shared time_limit, not 4x.
// Match the pool size to the browser's actual reported hardware
// concurrency exactly - no artificial floor/ceiling. Oversubscribing
// (more workers than real parallel execution units) doesn't blow up wall
// time much (HiGHS's time_limit still gets honored per-worker) but does
// measurably hurt solution quality, since each worker gets a smaller
// slice of real CPU time within the same nominal budget (measured: 16
// workers on a 4-core machine landed mostly in the 33-36 pattern-type
// range, versus 28-32 with a properly-sized 4-worker pool).
const WORKER_POOL_SIZE = Math.max(1, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4);
let workerPool = null;

function createPoolWorker() {
  const blob = new Blob([window.WORKER_BUNDLE_SOURCE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  return new Worker(blobUrl);
}

function getWorkerPool() {
  if (!workerPool) {
    workerPool = [];
    for (let i = 0; i < WORKER_POOL_SIZE; i++) workerPool.push(createPoolWorker());
  }
  return workerPool;
}

// Terminates and replaces one pool slot in place - used when a job is
// abandoned mid-solve (see solveMaxFulfillConcurrent's early-exit below)
// so a still-running orphaned computation doesn't delay whatever the pool
// gets used for next.
function replacePoolWorker(pool, idx) {
  try {
    pool[idx].terminate();
  } catch (err) {
    // ignore
  }
  pool[idx] = createPoolWorker();
}

function solveOnWorker(worker, lpText, options) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}_${Math.random()}`;
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", handler);
      if (e.data.ok) resolve(e.data.sol);
      else reject(new Error(e.data.error));
    };
    worker.addEventListener("message", handler);
    try {
      worker.postMessage({ id, lp: lpText, options });
    } catch (err) {
      worker.removeEventListener("message", handler);
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

// A nonzero mip_rel_gap lets HiGHS stop as soon as it's within that relative
// distance of its own best proven bound - but that bound is computed
// against the LP relaxation, which the min-batch-size binaries can leave
// quite loose, so a nominal tolerance can translate into a much larger real
// shortfall against the true achievable optimum. Set to 0 (exact
// optimality, no early stopping) so an "Optimal" status is always
// trustworthy - see webapp/app.js for the full rationale.
const MIP_REL_GAP = 0;

// An earlier attempt used HiGHS's mip_max_stall_nodes to give up early once
// the search stops finding improving incumbents. Reverted - see
// webapp/app.js for the full rationale (a second real-world dataset showed
// it causes a genuine, non-deterministic under-fulfillment, not just a
// slower-but-honest trade-off).

// HiGHS's own time_limit option is only checked at internal B&B node
// boundaries - on hard instances a single node can occasionally run well
// past that nominal cap, leaving the page waiting indefinitely with no
// result. Enforce a hard external ceiling (requested limit + grace) as a
// safety net so a solve always ends, worst case reported as a failed/
// timed-out stage rather than hanging forever. See webapp/app.js for the
// full rationale (identical logic, kept in sync).
function hardTimeoutMsFor(timeLimitSec) {
  const bufferSec = Math.max(30, Math.min(120, Math.round(timeLimitSec * 0.25)));
  return (timeLimitSec + bufferSec) * 1000;
}

function withHardTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (onTimeout) onTimeout();
      const err = new Error(`Solve exceeded hard time ceiling (${Math.round(ms / 1000)}s)`);
      err.hardTimeout = true;
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function resetWorker() {
  if (highsWorker) {
    try {
      highsWorker.terminate();
    } catch (err) {
      // ignore
    }
  }
  highsWorker = null;
  for (const pending of workerPending.values()) pending.reject(new Error("worker reset after hard timeout"));
  workerPending.clear();
}

async function solveLP(lpText, timeLimitSec, optionOverrides) {
  const options = {
    time_limit: timeLimitSec,
    output_flag: false,
    mip_rel_gap: MIP_REL_GAP,
    ...optionOverrides,
  };
  if (!workerBroken && typeof Worker !== "undefined") {
    try {
      return await withHardTimeout(solveInWorker(lpText, options), hardTimeoutMsFor(timeLimitSec));
    } catch (err) {
      if (err && err.hardTimeout) {
        console.warn(err.message, "- aborting this solve stage instead of hanging; treating it as failed.");
        resetWorker();
        return null;
      }
      console.warn("Worker solve failed, falling back to main-thread solve:", err);
      workerBroken = true;
    }
  }
  const highs = await getHighsInline();
  return highs.solve(lpText, options);
}

// Unlike min_types (where different candidate-pattern SUBSETS create real
// diversity), running the exact same max_fulfill problem on several
// workers with identical options is pointless - HiGHS's B&B is
// deterministic (verified: 4 workers solving the identical hard B1160
// instance for 30s each all landed on the exact same 617-piece
// incumbent). But HiGHS does expose `random_seed` and
// `mip_heuristic_effort`, and varying those DOES genuinely diversify the
// search (verified on the same instance/budget: seeds 0-3 landed on
// 617/616/618/619 - a real, if modest, spread). Since every worker still
// only runs for the same shared time_limit and they all run concurrently,
// trying several seeds and keeping the best incumbent found is a "free"
// quality improvement for the stage that decides the fulfillment rate
// (the primary objective, ahead of roll count and pattern-type count) -
// no extra wall-clock cost versus a single solve, unlike the min_types
// deep-search checkbox which deliberately trades time for quality.
//
// Exits as soon as ANY worker reports "Optimal", instead of waiting for
// all of them: a proven optimum can't be beaten by another seed, and
// waiting anyway made already-easy instances measurably SLOWER than a
// plain single solve (measured on T2085, all-Optimal case: seeds finished
// anywhere from 5.8s to 31.3s apart despite agreeing on the same 1127
// value, so Promise.all-style waiting for the slowest one added ~15s of
// pure waste). The other pool slots are terminated and replaced (not just
// abandoned) so a still-running orphaned computation can't delay whatever
// the pool gets dispatched to next (e.g. the min_rolls stage right after).
function solveMaxFulfillConcurrent(lpText, timeLimitSec) {
  const pool = getWorkerPool();
  const hardMs = hardTimeoutMsFor(timeLimitSec);
  return new Promise((resolve) => {
    let settled = false;
    let bestSoFar = null;
    let remaining = pool.length;

    function settle(sol) {
      if (settled) return;
      settled = true;
      resolve(sol);
    }

    pool.forEach((worker, idx) => {
      withHardTimeout(
        solveOnWorker(worker, lpText, {
          time_limit: timeLimitSec,
          output_flag: false,
          mip_rel_gap: MIP_REL_GAP,
          random_seed: idx,
          mip_heuristic_effort: Math.min(0.95, 0.05 + idx * (0.9 / Math.max(1, pool.length - 1))),
        }),
        hardMs
      )
        .then((sol) => {
          if (sol && sol.Status === "Optimal") {
            settle(sol);
            pool.forEach((_, i) => {
              if (i !== idx) replacePoolWorker(pool, i);
            });
            return;
          }
          if (sol && Number.isFinite(sol.ObjectiveValue) && (!bestSoFar || sol.ObjectiveValue > bestSoFar.ObjectiveValue)) {
            bestSoFar = sol;
          }
        })
        .catch(() => {})
        .then(() => {
          remaining--;
          if (remaining === 0) settle(bestSoFar);
        });
    });
  });
}

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- main pipeline: import data -> compute tube plan directly ----
async function runPipeline() {
  els.runBtn.disabled = true;
  els.tubeSummaryPanel.hidden = true;
  els.orderDetailPanel.hidden = true;
  els.tubeRound1Panel.hidden = true;
  els.tubeRound2Panel.hidden = true;

  try {
    const { widths, demand, orderRows } = parseOrders(els.ordersText.value);
    if (widths.length === 0) {
      setStatus("找不到有效的紙管需求資料，請確認格式為「寬度,數量」。", "idle");
      return;
    }

    setStatus("計算紙管組合計畫中...", "busy");
    await yieldToUI();
    const tube = await runTubePlan(demand, widths);
    renderTubePlan(tube);
    window.__lastTube = tube;

    const tubeProduced = {};
    for (const w of tube.tubeWidths) {
      tubeProduced[String(w)] = (tube.round1.produced[String(w)] || 0) + (tube.round2.produced[String(w)] || 0);
    }
    const tubeCutSeqQueues = mergeSeqQueues(
      buildSeqQueues(tube.round1SequencedRows, (row) => `R1-${row.seq}`),
      buildSeqQueues(tube.round2SequencedRows, (row) => `R2-${row.seq}`)
    );
    const orderDetailRows = allocateToOrderRows(orderRows, tubeProduced, tubeCutSeqQueues);
    renderOrderDetailTable(orderDetailRows);
    window.__lastOrderDetail = orderDetailRows;

    setStatus(
      `完成。共排產 ${tube.round1Total + tube.round2Total}/${tube.totalDemand} 段，缺口 ${tube.shortfall} 段（Round1 ${tube.round1Tubes} 支，移動距離 ${tube.round1Movement}mm；Round2 ${tube.round2Tubes} 支，移動距離 ${tube.round2Movement}mm）。`,
      tube.shortfall > 0 ? "warn" : "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus("發生錯誤：" + (err && err.message ? err.message : String(err)), "error");
  } finally {
    els.runBtn.disabled = false;
  }
}

function renderOrderDetailTable(rows) {
  els.orderDetailPanel.hidden = rows.length === 0;
  els.orderDetailTable.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.orderNo,
      row.seq,
      row.custNo,
      row.custName,
      row.itemNo,
      row.width,
      row.qty,
      row.fulfilled,
      row.cutSeq || "-",
      row.shortfall,
    ];
    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    const statusTd = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + (row.shortfall > 0 ? "short" : "ok");
    badge.textContent = row.shortfall > 0 ? "缺口" : "已滿足";
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);
    els.orderDetailTable.appendChild(tr);
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
    { label: "Round1 刀具移動距離 (mm)", value: tube.round1Movement },
    { label: "Round2 刀具移動距離 (mm)", value: tube.round2Movement },
  ];
  els.tubeSummaryCards.innerHTML = "";
  for (const c of cards) {
    const div = document.createElement("div");
    div.className = "card" + (c.tone ? " " + c.tone : "");
    div.innerHTML = `<div class="value">${c.value}</div><div class="label">${c.label}</div>`;
    els.tubeSummaryCards.appendChild(div);
  }

  els.tubeRound1Panel.hidden = tube.round1SequencedRows.length === 0;
  els.tubeRound1Title.textContent = `Round1：${tube.round1Lengths.join("/")}mm 母管（修邊損耗 < ${(tube.wasteTol * 100).toFixed(1)}%，依刀具移動最少排序）`;
  els.tubeRound1Table.innerHTML = "";
  for (const row of tube.round1SequencedRows) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    const rate = ((waste / row.stockLength) * 100).toFixed(2) + "%";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.seq}</td><td>${row.stockLength}</td><td>${row.count}</td><td>${row.items.join(" + ")}</td><td>${row.items.length}</td><td>${sum}</td><td>${waste}</td><td>${rate}</td><td>${row.move}</td>`;
    els.tubeRound1Table.appendChild(tr);
  }

  els.tubeRound2Panel.hidden = tube.round2SequencedRows.length === 0;
  els.tubeRound2Title.textContent = `Round2：剩餘規格組合（${tube.round2Lengths.join("/")}mm 母管，不限修邊損耗，依刀具移動最少排序）`;
  els.tubeRound2Table.innerHTML = "";
  for (const row of tube.round2SequencedRows) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.seq}</td><td>${row.stockLength}</td><td>${row.count}</td><td>${row.items.join(" + ")}</td><td>${row.items.length}</td><td>${sum}</td><td>${waste}</td><td>${row.move}</td>`;
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
  const rows = [["生產順序", "母管長度(mm)", "母管數量", "組合規格(mm)", "段數", "合計寬度(mm)", "修邊損耗(mm)", "損耗率", "與前一支刀具移動距離(mm)"]];
  for (const row of window.__lastTube.round1SequencedRows) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    const waste = row.stockLength - sum;
    rows.push([row.seq, row.stockLength, row.count, row.items.join(" + "), row.items.length, sum, waste, ((waste / row.stockLength) * 100).toFixed(2) + "%", row.move]);
  }
  downloadCSV("tube_plan_round1.csv", rows);
});

els.downloadTube2Btn.addEventListener("click", () => {
  if (!window.__lastTube) return;
  const rows = [["生產順序", "母管長度(mm)", "母管數量", "組合規格(mm)", "段數", "合計寬度(mm)", "修邊損耗(mm)", "與前一支刀具移動距離(mm)"]];
  for (const row of window.__lastTube.round2SequencedRows) {
    const sum = row.items.reduce((s, w) => s + w, 0);
    rows.push([row.seq, row.stockLength, row.count, row.items.join(" + "), row.items.length, sum, row.stockLength - sum, row.move]);
  }
  downloadCSV("tube_plan_round2.csv", rows);
});

els.downloadOrderDetailBtn.addEventListener("click", () => {
  if (!window.__lastOrderDetail) return;
  const rows = [["訂單編號", "項次", "客戶編號", "客戶名稱", "料號", "門幅(mm)", "需求量", "已排產", "裁切順序", "差額"]];
  for (const r of window.__lastOrderDetail) {
    rows.push([r.orderNo, r.seq, r.custNo, r.custName, r.itemNo, r.width, r.qty, r.fulfilled, r.cutSeq || "-", r.shortfall]);
  }
  downloadCSV("order_item_detail.csv", rows);
});

els.runBtn.addEventListener("click", runPipeline);

// auto-run once on load with the pre-filled sample data, so results are
// visible immediately without needing to press a button
runPipeline();
