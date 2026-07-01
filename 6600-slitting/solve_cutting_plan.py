import csv
import os
from collections import Counter
import pulp

MOTHER_WIDTH = 6600
MIN_PIECES = 3

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

# --- ILP stage 1: maximize total fulfilled quantity (sum of production), production_i <= demand_i
prob1 = pulp.LpProblem("max_fulfillment", pulp.LpMaximize)
x = [pulp.LpVariable(f"x_{i}", lowBound=0, cat="Integer") for i in range(len(patterns))]

# production per width
prod_expr = {w: pulp.lpSum(x[i] * patterns[i].get(w, 0) for i in range(len(patterns))) for w in widths}

for w in widths:
    prob1 += prod_expr[w] <= demand[w]

prob1 += pulp.lpSum(prod_expr[w] for w in widths)

solver = pulp.PULP_CBC_CMD(msg=1, timeLimit=120)
prob1.solve(solver)
print("Stage1 status:", pulp.LpStatus[prob1.status])
total_fulfilled = pulp.value(prob1.objective)
print("Max total fulfilled pieces:", total_fulfilled)

# --- stage 2: minimize number of rolls while keeping total fulfilled == total_fulfilled (or >=, since it's max)
prob2 = pulp.LpProblem("min_rolls", pulp.LpMinimize)
x2 = [pulp.LpVariable(f"x2_{i}", lowBound=0, cat="Integer") for i in range(len(patterns))]
prod_expr2 = {w: pulp.lpSum(x2[i] * patterns[i].get(w, 0) for i in range(len(patterns))) for w in widths}
for w in widths:
    prob2 += prod_expr2[w] <= demand[w]
prob2 += pulp.lpSum(prod_expr2[w] for w in widths) >= total_fulfilled - 1e-3
prob2 += pulp.lpSum(x2)

prob2.solve(solver)
print("Stage2 status:", pulp.LpStatus[prob2.status])
total_rolls = pulp.value(prob2.objective)
print("Min rolls achieving that fulfillment:", total_rolls)

# --- extract solution ---
solution = []
for i, xi in enumerate(x2):
    v = xi.value()
    if v and v > 0.5:
        solution.append((patterns[i], int(round(v))))

solution.sort(key=lambda t: -t[1])

with open(os.path.join(BASE_DIR, 'cutting_plan_6600.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    w_csv = csv.writer(f)
    w_csv.writerow(['母卷數量', '裁切規格(mm)', '刀數', '合計寬度(mm)'])
    for p, c in solution:
        items = sorted(p.elements())
        w_csv.writerow([c, ' + '.join(str(x) for x in items), len(items), sum(items)])

print("\n=== Cutting plan ===")
total_rolls_used = 0
produced = Counter()
for p, c in solution:
    items = sorted(p.elements())
    total_rolls_used += c
    for w, cnt in p.items():
        produced[w] += cnt * c
    print(f"Rolls: {c:4d}  Pattern: {' + '.join(str(x) for x in items)} = {sum(items)}")

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
