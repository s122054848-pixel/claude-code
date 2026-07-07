import csv
import os
from collections import Counter
import pulp

MOTHER_WIDTH = 6600
MIN_PIECES = 3
MIN_ROLLS_PER_PATTERN = 3  # each pattern, if used at all, must be used > 2 times

# With the min-batch-size binary indicators, CBC finds the true optimum in
# ~0.3-10s but then spends the rest of a long time limit trying to *prove*
# optimality against an LP-relaxation bound that isn't integer-achievable -
# that gap never fully closes, so without a gapRel it just burns the whole
# time limit for no benefit. Accepting solutions within 0.1% of the best
# known bound gets the identical answer (verified: 2149 fulfilled/653 rolls,
# matching the old 180s-per-stage run exactly) in ~11s total instead of 140s+.
MIP_GAP_REL = 0.001

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- load demand ---
widths = []
demand = {}
with open(os.path.join(BASE_DIR, 'orders.csv'), encoding='utf-8') as f:
    r = csv.reader(f)
    next(r)
    for row in r:
        if not row or not row[0].strip():
            continue
        w = int(row[0])
        q = int(row[1])
        widths.append(w)
        demand[w] = q

widths.sort()
n = len(widths)
max_pieces = MOTHER_WIDTH // widths[0]
print(f"widths: {n}, max possible pieces per roll: {max_pieces}")

# --- enumerate all patterns: multisets (non-decreasing index sequences) of widths[i]
# with MIN_PIECES..max_pieces items summing exactly to MOTHER_WIDTH
patterns = []  # each: Counter(width->count)

def dfs(start_idx, count, total, combo):
    if total == MOTHER_WIDTH and count >= MIN_PIECES:
        patterns.append(Counter(combo))
        # continue is not needed; exact match found, but could also extend? no, extension only increases sum
        return
    if total > MOTHER_WIDTH or count >= max_pieces:
        return
    for i in range(start_idx, n):
        w = widths[i]
        if total + w > MOTHER_WIDTH:
            break  # since widths sorted ascending, further only larger
        combo.append(w)
        dfs(i, count + 1, total + w, combo)
        combo.pop()

dfs(0, 0, 0, [])
print(f"total feasible patterns (sum==6600, pieces 3..{max_pieces}): {len(patterns)}")

# dedupe patterns (Counter equality) - dfs with non-decreasing already avoids dup, but just in case
seen = {}
uniq_patterns = []
for p in patterns:
    key = tuple(sorted(p.items()))
    if key not in seen:
        seen[key] = True
        uniq_patterns.append(p)
patterns = uniq_patterns
print(f"unique patterns: {len(patterns)}")

# Tight per-pattern upper bound: a pattern can never be used more times than
# the scarcest width it consumes allows, ignoring competition from other
# patterns. Also serves as the big-M for the 0-or->=MIN_ROLLS_PER_PATTERN
# indicator constraints below.
pattern_ubound = [
    min(demand[w] // c for w, c in patterns[i].items())
    for i in range(len(patterns))
]

# --- ILP stage 1: maximize total fulfilled quantity (sum of production), production_i <= demand_i
prob1 = pulp.LpProblem("max_fulfillment", pulp.LpMaximize)
x = [pulp.LpVariable(f"x_{i}", lowBound=0, cat="Integer") for i in range(len(patterns))]
y = [pulp.LpVariable(f"y_{i}", cat="Binary") for i in range(len(patterns))]

# production per width
prod_expr = {w: pulp.lpSum(x[i] * patterns[i].get(w, 0) for i in range(len(patterns))) for w in widths}

for w in widths:
    prob1 += prod_expr[w] <= demand[w]

for i in range(len(patterns)):
    prob1 += x[i] <= pattern_ubound[i] * y[i]
    prob1 += x[i] >= MIN_ROLLS_PER_PATTERN * y[i]

prob1 += pulp.lpSum(prod_expr[w] for w in widths)

solver = pulp.PULP_CBC_CMD(msg=1, timeLimit=180, gapRel=MIP_GAP_REL)
prob1.solve(solver)
print("Stage1 status:", pulp.LpStatus[prob1.status])
total_fulfilled = pulp.value(prob1.objective)
print("Max total fulfilled pieces:", total_fulfilled)

# stage1's own solution is already a feasible point for stage2 (same
# constraints, and its total production already equals total_fulfilled) -
# use it as a warm start so CBC doesn't have to rediscover feasibility from
# scratch under the extra big-M/binary constraints, which otherwise can take
# a very long time to find any incumbent at all.
x1_vals = [round(xi.value() or 0) for xi in x]

# --- stage 2: minimize number of rolls while keeping total fulfilled == total_fulfilled (or >=, since it's max)
prob2 = pulp.LpProblem("min_rolls", pulp.LpMinimize)
x2 = [pulp.LpVariable(f"x2_{i}", lowBound=0, cat="Integer") for i in range(len(patterns))]
y2 = [pulp.LpVariable(f"y2_{i}", cat="Binary") for i in range(len(patterns))]
prod_expr2 = {w: pulp.lpSum(x2[i] * patterns[i].get(w, 0) for i in range(len(patterns))) for w in widths}
for w in widths:
    prob2 += prod_expr2[w] <= demand[w]
for i in range(len(patterns)):
    prob2 += x2[i] <= pattern_ubound[i] * y2[i]
    prob2 += x2[i] >= MIN_ROLLS_PER_PATTERN * y2[i]
prob2 += pulp.lpSum(prod_expr2[w] for w in widths) >= total_fulfilled - 1e-3
prob2 += pulp.lpSum(x2)

for i in range(len(patterns)):
    x2[i].setInitialValue(x1_vals[i])
    y2[i].setInitialValue(1 if x1_vals[i] > 0 else 0)

solver2 = pulp.PULP_CBC_CMD(msg=1, timeLimit=180, gapRel=MIP_GAP_REL, warmStart=True)
prob2.solve(solver2)
print("Stage2 status:", pulp.LpStatus[prob2.status])
total_rolls = pulp.value(prob2.objective)
x2_fulfilled = sum(
    round(xi.value() or 0) * len(patterns[i])
    for i, xi in enumerate(x2)
)
if total_rolls is None or x2_fulfilled < total_fulfilled - 1e-3:
    # Either no incumbent at all, or (defensively) one that doesn't actually
    # meet the fulfillment floor - fall back to stage1's own solution, which
    # is already known to satisfy every constraint including MIN_ROLLS_PER_PATTERN.
    print("Stage2 didn't produce a solution meeting the fulfillment floor; "
          "falling back to stage1's own (non-roll-minimized) solution.")
    x2 = x
    total_rolls = sum(x1_vals)
print("Min rolls achieving that fulfillment:", total_rolls)

# --- extract solution ---
solution = []
for i, xi in enumerate(x2):
    v = xi.value()
    if v and v > 0.5:
        solution.append((patterns[i], int(round(v))))

solution.sort(key=lambda t: -t[1])

# --- stage 3: sequence the distinct patterns to minimize total knife movement ---
# Knife positions of a pattern are the cumulative cut points (excluding the final
# roll edge), e.g. widths [2100,2100,2400] -> cut points [2100, 4200].
# Moving from pattern A to pattern B, the cheapest way to realign the knives is
# the 1-D optimal assignment: sort both position lists (pad the shorter one with
# 0s, representing knives parked at the start), then sum |a_i - b_i| pairwise
# (this pairing is provably optimal for 1-D assignment costs).

def knife_positions(items):
    items = sorted(items)
    cum = 0
    positions = []
    for w in items[:-1]:
        cum += w
        positions.append(cum)
    return positions

def transition_cost(pos_a, pos_b):
    n = max(len(pos_a), len(pos_b))
    a = sorted(pos_a) + [0] * (n - len(pos_a))
    b = sorted(pos_b) + [0] * (n - len(pos_b))
    a.sort()
    b.sort()
    return sum(abs(x - y) for x, y in zip(a, b))

def sequence_patterns(entries):
    n = len(entries)
    positions = [knife_positions(sorted(p.elements())) for p, _ in entries]
    dist = [[transition_cost(positions[i], positions[j]) for j in range(n)] for i in range(n)]

    def path_cost(order):
        return sum(dist[order[i]][order[i + 1]] for i in range(len(order) - 1))

    best_order, best_cost = None, None
    for start in range(n):
        visited = [False] * n
        order = [start]
        visited[start] = True
        cur = start
        for _ in range(n - 1):
            nxt = min((j for j in range(n) if not visited[j]), key=lambda j: dist[cur][j])
            order.append(nxt)
            visited[nxt] = True
            cur = nxt
        cost = path_cost(order)
        if best_cost is None or cost < best_cost:
            best_order, best_cost = order, cost

    # 2-opt: evaluate each candidate swap via its O(1) cost delta (only the
    # two edges at the ends of the reversed segment change) and reverse
    # in-place only when it actually improves, instead of rebuilding the
    # whole list and recomputing the full path cost per candidate. This
    # turns each pass from O(n^3) into O(n^2), and the overall convergence
    # from O(n^4) into O(n^3) - which matters once there are 50-100+ patterns.
    order = best_order[:]
    total_cost = best_cost
    improved = True
    while improved:
        improved = False
        for i in range(1, n - 1):
            a = order[i - 1]
            b = order[i]
            dab = dist[a][b]
            for j in range(i + 1, n):
                c = order[j]
                d = order[j + 1] if j + 1 < n else None
                old_edges = dab + (dist[c][d] if d is not None else 0)
                new_edges = dist[a][c] + (dist[b][d] if d is not None else 0)
                if new_edges < old_edges - 1e-9:
                    order[i:j + 1] = order[i:j + 1][::-1]
                    total_cost += new_edges - old_edges
                    improved = True
                    b = order[i]
                    dab = dist[a][b]

    return order, total_cost, dist

seq_order, total_knife_distance, dist_matrix = sequence_patterns(solution)
sequenced = [solution[i] for i in seq_order]

with open(os.path.join(BASE_DIR, 'cutting_plan_6600.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    w_csv = csv.writer(f)
    w_csv.writerow(['生產順序', '母卷數量', '裁切規格(mm)', '刀數', '合計寬度(mm)', '與前一刀路刀具移動距離(mm)'])
    prev_idx = None
    for seq_no, (idx, (p, c)) in enumerate(zip(seq_order, sequenced), start=1):
        items = sorted(p.elements())
        move = 0 if prev_idx is None else dist_matrix[prev_idx][idx]
        w_csv.writerow([seq_no, c, ' + '.join(str(x) for x in items), len(items), sum(items), move])
        prev_idx = idx

print(f"\n=== Stage3: knife-movement-minimizing production sequence ===")
print(f"Total knife movement distance across {len(sequenced)} pattern changeovers: {total_knife_distance} mm")

print("\n=== Cutting plan (production sequence) ===")
total_rolls_used = 0
produced = Counter()
prev_idx = None
for idx, (p, c) in zip(seq_order, sequenced):
    items = sorted(p.elements())
    total_rolls_used += c
    for w, cnt in p.items():
        produced[w] += cnt * c
    move = 0 if prev_idx is None else dist_matrix[prev_idx][idx]
    print(f"Rolls: {c:4d}  Move: {move:5d}mm  Pattern: {' + '.join(str(x) for x in items)} = {sum(items)}")
    prev_idx = idx

print(f"\nTotal mother rolls used: {total_rolls_used}")
print("\n=== Fulfillment check ===")
under = []
for w in widths:
    d = demand[w]
    p_ = produced.get(w, 0)
    status = "OK" if p_ == d else ("SHORT" if p_ < d else "OVER!!!")
    if p_ != d:
        under.append((w, d, p_, d - p_))
    print(f"{w:5d}: demand={d:4d} produced={p_:4d} diff={d-p_:4d} {status}")

print(f"\nTotal demand: {sum(demand.values())}, Total produced: {sum(produced.values())}, Total shortfall: {sum(demand.values())-sum(produced.values())}")
