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
  minRollsPerPattern: document.getElementById("minRollsPerPattern"),
  timeLimit1: document.getElementById("timeLimit1"),
  timeLimit2: document.getElementById("timeLimit2"),
  runSlitBtn: document.getElementById("runSlitBtn"),
  runFullBtn: document.getElementById("runFullBtn"),
  runTubeBtn: document.getElementById("runTubeBtn"),
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

els.loadSampleBtn.addEventListener("click", () => {
  els.ordersText.value = SAMPLE_CSV;
});

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const decoder = new TextDecoder(els.encodingSelect.value);
  els.ordersText.value = decoder.decode(buf);
});

// A single solve can legitimately take over a minute (harder MIPs with the
// min-batch-size constraint don't converge quickly), during which only one
// or two status lines would otherwise change - which can look identical to
// a frozen/broken page. Show a live elapsed-time counter while busy so it's
// visibly still working.
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

// ---- parsing ----
function parseOrders(text) {
  const widths = [];
  const demand = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s.length);
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
// opts.minBatch: if set (>1), each pattern must be used 0 times or at least
// minBatch times (modeled with a binary indicator y_i per pattern and a
// tight big-M = the pattern's own per-width demand ceiling). Patterns that
// could never reach minBatch even alone are dropped entirely.
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

  if (opts.mode === "min_rolls") {
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

  // 2-opt: evaluate each candidate swap via its O(1) cost delta (only the
  // two edges at the ends of the reversed segment change) and reverse
  // in-place only when it actually improves, instead of rebuilding the
  // whole array and recomputing the full path cost per candidate. This
  // turns each pass from O(n^3) into O(n^2), and the overall convergence
  // from O(n^4) into O(n^3) - which matters once there are 50-100+ patterns.
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
// the previous pattern) to each row. Reuses the same knifePositions /
// transitionCost / sequencePatterns as the slitting stage3 above.
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

// ---- stage 4: paper-tube (紙管) combination plan ----
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

// Generic three-stage solve over an arbitrary set of {items, stockLength}
// patterns - reuses buildLP/solveLP since the LP itself only cares about
// widths, not the actual stock length:
//   1. max fulfillment (plain piece count) -> fulfillFloor
//   2. among solutions achieving fulfillFloor, maximize total fulfilled
//      *width* (weightFn = width) -> a per-width allocation that prioritizes
//      larger widths without sacrificing the overall fulfillment rate
//   3. min tube count, pinned to stage 2's per-width allocation so
//      roll-count optimization can't trade large-width fulfillment away
async function solveTubeStage(patternsFull, widths, demand, t1, t2) {
  if (patternsFull.length === 0 || widths.length === 0) {
    return { solution: [], produced: {}, status1: "N/A", status2: "N/A" };
  }
  const itemsList = patternsFull.map((p) => p.items);
  const counts = itemsList.map(patternToCounts);
  const lp1 = buildLP(itemsList, counts, widths, demand, { mode: "max_fulfill" });
  const sol1 = await solveLP(lp1, t1);
  const fulfillFloor = Math.round((sol1 && sol1.ObjectiveValue) || 0);

  const lpPriority = buildLP(itemsList, counts, widths, demand, {
    mode: "max_fulfill",
    fulfillFloor,
    weightFn: (w) => w,
  });
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
  const sol2 = await solveLP(lp2, t2);

  let ext = extractPatternSolution(sol2, patternsFull, widths);
  if (ext.totalProduced < fulfillFloor - 0.5) {
    // stage3 failed to find any solution meeting the per-width floors
    // (timed out with no incumbent) - fall back to stage2's own solution,
    // which is already known to achieve them.
    ext = extPriority;
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

// The tube-plan patterns are far fewer/simpler than the main slitting
// problem and consistently solve in a few seconds, so give them their own
// small fixed time budget instead of reusing the (possibly much larger)
// main Stage1/Stage2 limits - otherwise a single run can end up doing the
// main solve plus up to two more two-stage solves (round1, round2) each at
// the full main time limit, and the worst case compounds into minutes.
// Round1 and Round2 each run 3 stages (max-fulfill, large-width-priority
// re-solve, then min-tubes), so at this per-stage cap the absolute worst
// case for round1+round2 combined is 6 * cap; default 12s keeps that at 72s.
async function runTubePlanCore(tubeWidths, tubeDemand, t1, t2) {
  const tubeStageCap = Math.max(1, Math.round(Number(els.tubeStageTimeLimit.value)) || 12);
  const tubeT1 = Math.min(t1, tubeStageCap);
  const tubeT2 = Math.min(t2, tubeStageCap);
  const round1Lengths = readLengthList(["tubeLen1", "tubeLen2", "tubeLen3", "tubeLen4"]);
  const round2Lengths = readLengthList(["tubeR2Len1", "tubeR2Len2", "tubeR2Len3", "tubeR2Len4"]);
  const wasteTol = Math.max(0, Number(els.tubeWasteTol.value) || 0) / 100;

  const round1Patterns = generateRound1TubePatterns(tubeWidths, round1Lengths, wasteTol);
  const round1 = await solveTubeStage(round1Patterns, tubeWidths, tubeDemand, tubeT1, tubeT2);

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
    round2 = await solveTubeStage(round2Patterns, remainingWidths, remainingDemand, tubeT1, tubeT2);
  }

  const totalDemand = tubeWidths.reduce((s, w) => s + tubeDemand[String(w)], 0);
  const round1Total = Object.values(round1.produced).reduce((a, b) => a + b, 0);
  const round2Total = Object.values(round2.produced).reduce((a, b) => a + b, 0);
  const round1Tubes = round1.solution.reduce((s, r) => s + r.count, 0);
  const round2Tubes = round2.solution.reduce((s, r) => s + r.count, 0);

  // Sequence each round's patterns into the blade-movement-minimizing
  // production order (Round1 and Round2 use different mother-tube stock, so
  // each is sequenced independently rather than as one combined run). Reuses
  // sequencePatterns/knifePositions/transitionCost from the slitting stage3
  // above, since the same 1-D cut-position assignment logic applies.
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

// Wrapper for the "full" pipeline: derives tube-segment demand from the
// slitting stage's produced roll counts, then delegates to the shared core.
async function runTubePlan(produced, t1, t2) {
  const tubeWidths = Object.keys(produced)
    .map(Number)
    .filter((w) => (produced[String(w)] || 0) > 0)
    .sort((a, b) => a - b);
  const tubeDemand = {};
  for (const w of tubeWidths) tubeDemand[String(w)] = produced[String(w)];
  return runTubePlanCore(tubeWidths, tubeDemand, t1, t2);
}

// ---- HiGHS wasm solving ----
// Solving runs in a Web Worker so a slow MIP (e.g. with the min-batch-size
// constraint) doesn't freeze the page's UI thread. Falls back to a
// synchronous in-page solve if the Worker can't be created/used.
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

// HiGHS (and CBC before it) will happily burn the entire time_limit trying
// to *prove* optimality even after it already found the true-best incumbent
// in a fraction of that time, whenever the LP-relaxation bound isn't
// integer-achievable (very common with the min-batch-size binaries). Once
// the solution is within this relative gap of the best proven bound, HiGHS
// stops early instead of continuing to search for no real benefit. Tuned
// against the real dataset: mip_rel_gap=0.0005 with a 30s cap reproduces the
// exact optimum (2149/2151, matching a from-scratch ~140s/no-gap run) in
// ~30s - tighter gaps (0.0001) or shorter caps (15-20s) settle a bit short.
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

// ---- main pipeline ----
// mode: "slit" (only the 6600mm cutting plan), "full" (6600 cutting plan
// then feed its produced rolls into the 4600 tube plan), or "tube" (skip the
// 6600 stage entirely and treat the imported width,qty data directly as
// tube-segment demand).
async function runPipeline(mode) {
  els.runSlitBtn.disabled = true;
  els.runFullBtn.disabled = true;
  els.runTubeBtn.disabled = true;
  els.warningsPanel.hidden = true;
  els.warningsList.innerHTML = "";
  els.summaryPanel.hidden = true;
  els.planPanel.hidden = true;
  els.fulfillPanel.hidden = true;
  els.tubeSummaryPanel.hidden = true;
  els.tubeRound1Panel.hidden = true;
  els.tubeRound2Panel.hidden = true;

  try {
    const { widths, demand } = parseOrders(els.ordersText.value);
    if (widths.length === 0) {
      setStatus("找不到有效的訂單資料，請確認格式為「寬度,數量」。", "idle");
      return;
    }

    if (mode === "tube") {
      // ---- 4600 only: imported data is treated directly as tube-segment
      // demand, bypassing the 6600mm slitting stage entirely. ----
      setStatus("計算紙管組合計畫中...", "busy");
      await yieldToUI();
      const tube = await runTubePlanCore(widths, demand, Infinity, Infinity);
      renderTubePlan(tube);
      window.__lastPlan = null;
      window.__lastFulfill = null;
      window.__lastTube = tube;
      setStatus(
        `完成。共排產 ${tube.round1Total + tube.round2Total}/${tube.totalDemand} 段，缺口 ${tube.shortfall} 段（Round1 ${tube.round1Tubes} 支/移動 ${tube.round1Movement}mm、Round2 ${tube.round2Tubes} 支/移動 ${tube.round2Movement}mm）。`,
        tube.shortfall > 0 ? "warn" : "ok"
      );
      return;
    }

    const motherWidth = Math.round(Number(els.motherWidth.value));
    const minPieces = Math.max(1, Math.round(Number(els.minPieces.value)));
    const t1 = Math.max(1, Number(els.timeLimit1.value) || 30);
    const t2 = Math.max(1, Number(els.timeLimit2.value) || 30);

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

    const minBatch = Math.max(1, Math.round(Number(els.minRollsPerPattern.value)) || 1);

    setStatus(`共產生 ${patterns.length} 種可行刀路，求解最大排產量中（最多 ${t1} 秒）...`, "busy");
    await yieldToUI();
    const lp1 = buildLP(patterns, patternCounts, widths, demand, { mode: "max_fulfill", minBatch });
    const sol1 = await solveLP(lp1, t1);

    if (!sol1 || !sol1.Columns || !Number.isFinite(sol1.ObjectiveValue)) {
      setStatus("Stage1 求解失敗，請調整時間上限或參數後再試一次。", "error");
      return;
    }

    const fulfillFloor = Math.round(sol1.ObjectiveValue);
    const patternsFull = patterns.map((items) => ({ items: items.slice().sort((a, b) => a - b) }));

    setStatus(
      `最大可排產量為 ${fulfillFloor} 件（狀態：${sol1.Status}）。求解優先滿足大尺寸門幅之分配中（最多 ${t1} 秒）...`,
      "busy"
    );
    await yieldToUI();
    const lpPriority = buildLP(patterns, patternCounts, widths, demand, {
      mode: "max_fulfill",
      fulfillFloor,
      minBatch,
      weightFn: (w) => w,
    });
    const solPriority = await solveLP(lpPriority, t1);
    let extPriority = extractPatternSolution(solPriority, patternsFull, widths);
    if (extPriority.totalProduced < fulfillFloor - 0.5) {
      // weighted re-solve failed to reach the floor (timed out with no
      // incumbent) - fall back to stage1's own (unweighted) solution.
      extPriority = extractPatternSolution(sol1, patternsFull, widths);
    }
    const priorityFloor = {};
    for (const w of widths) priorityFloor[String(w)] = extPriority.produced[String(w)] || 0;

    setStatus(
      `大尺寸優先分配完成。求解最少母卷數中（最多 ${t2} 秒）...`,
      "busy"
    );
    await yieldToUI();
    const lp2 = buildLP(patterns, patternCounts, widths, demand, {
      mode: "min_rolls",
      fulfillFloor,
      minBatch,
      perWidthFloor: priorityFloor,
    });
    const sol2 = await solveLP(lp2, t2);

    if (!sol2 || !sol2.Columns) {
      setStatus("Stage2 求解失敗，請調整時間上限或參數後再試一次。", "error");
      return;
    }

    // ---- extract solution ----
    let ext = extractPatternSolution(sol2, patternsFull, widths);
    if (ext.totalProduced < fulfillFloor - 0.5) {
      // stage3 (min rolls) failed to find any solution meeting the
      // per-width floors (e.g. timed out with no incumbent, which HiGHS
      // can report as a present-but-empty Columns object) - fall back to
      // the large-width-priority stage's own solution, which is already
      // known to achieve them.
      ext = extPriority;
    }
    if (fulfillFloor > 0 && ext.totalProduced === 0) {
      setStatus(
        "求解器回報了排產量但沒有實際找到可行解（可能是時限內找不到解），請調整時間上限或參數後再試一次。",
        "error"
      );
      return;
    }
    const solutionRows = ext.rows;
    const produced = ext.produced;
    const totalRolls = solutionRows.reduce((s, r) => s + r.count, 0);

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

    window.__lastPlan = sequencedRows;
    window.__lastFulfill = widths.map((w) => ({
      width: w,
      demand: demand[String(w)] || 0,
      produced: produced[String(w)] || 0,
    }));

    let tubeSummaryMsg = "";
    if (mode === "full") {
      setStatus("排刀計畫完成，計算紙管組合計畫中...", "busy");
      await yieldToUI();
      const tube = await runTubePlan(produced, t1, t2);
      renderTubePlan(tube);
      window.__lastTube = tube;
      tubeSummaryMsg = `｜紙管：${tube.round1Total + tube.round2Total}/${tube.totalDemand} 段（Round1 ${tube.round1Tubes} 支/移動 ${tube.round1Movement}mm、Round2 ${tube.round2Tubes} 支/移動 ${tube.round2Movement}mm）`;
      if (tube.shortfall > 0) tubeSummaryMsg += `，缺口 ${tube.shortfall} 段`;
    } else {
      window.__lastTube = null;
    }

    setStatus(
      `完成。共排產 ${totalProduced}/${totalDemand} 件，缺口 ${totalDemand - totalProduced} 件，使用 ${totalRolls} 支母卷，${sequencedRows.length} 種刀路，建議生產順序總刀具移動距離 ${totalCost}mm${tubeSummaryMsg}。`,
      totalDemand - totalProduced > 0 || (window.__lastTube && window.__lastTube.shortfall > 0) ? "warn" : "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus("發生錯誤：" + (err && err.message ? err.message : String(err)), "error");
  } finally {
    els.runSlitBtn.disabled = false;
    els.runFullBtn.disabled = false;
    els.runTubeBtn.disabled = false;
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

els.runSlitBtn.addEventListener("click", () => runPipeline("slit"));
els.runFullBtn.addEventListener("click", () => runPipeline("full"));
els.runTubeBtn.addEventListener("click", () => runPipeline("tube"));
