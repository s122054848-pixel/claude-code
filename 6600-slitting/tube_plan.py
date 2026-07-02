"""
Paper-tube (紙管) combination plan, built on top of the 6600mm slitting
cutting plan (cutting_plan_6600.csv).

Each produced roll (from the slitting plan) needs a paper tube core cut to
the same width. This script plans how to cut those tube-core lengths out of
raw "mother tube" stock:

  Round 1: stock lengths 4600mm and 4400mm only, trim loss must be < 2%
           (i.e. each tube's combined segment lengths must use > 98% of the
           stock length).
  Round 2: whatever demand round 1 couldn't cover (regardless of how much
           round-1 trim loss those leftovers would have implied) is packed
           into a single additional stock length: the largest multiple of
           200mm below 4300mm, i.e. 4200mm, with no waste constraint (since
           any single leftover width already fits inside 4200mm, round 2 is
           effectively a bin-packing minimization: fit all remaining
           demand using as few 4200mm tubes as possible).
"""
import csv
import os
from collections import Counter
import pulp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ROUND1_LENGTHS = [4600, 4400]
WASTE_TOL = 0.02
ROUND2_LENGTH = 4200  # largest multiple of 200 below 4300

solver = pulp.PULP_CBC_CMD(msg=1, timeLimit=60)


def load_demand_from_cutting_plan(path):
    """Sum up produced roll counts per width from cutting_plan_6600.csv."""
    demand = Counter()
    with open(path, encoding='utf-8-sig') as f:
        r = csv.DictReader(f)
        for row in r:
            count = int(row['母卷數量'])
            items = [int(x.strip()) for x in row['裁切規格(mm)'].split('+')]
            for w in items:
                demand[w] += count
    return demand


def generate_round1_patterns(widths, demand):
    """All multisets of widths whose sum lands in the <2%-waste window of
    either 4600 or 4400 (the two windows never overlap)."""
    n = len(widths)
    max_len = max(ROUND1_LENGTHS)
    max_pieces = max_len // widths[0]
    windows = [(L, L * (1 - WASTE_TOL), L) for L in ROUND1_LENGTHS]

    patterns = []  # (tuple(widths), stock_length)
    combo = []

    def dfs(start_idx, count, total):
        if count >= 1:
            for L, lo, hi in windows:
                if lo <= total <= hi:
                    patterns.append((tuple(sorted(combo)), L))
        if total >= max_len or count >= max_pieces:
            return
        for i in range(start_idx, n):
            w = widths[i]
            if total + w > max_len:
                break
            combo.append(w)
            dfs(i, count + 1, total + w)
            combo.pop()

    dfs(0, 0, 0)
    # dedupe (widths, L) pairs
    seen = set()
    uniq = []
    for p in patterns:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def generate_bounded_patterns(widths, max_len):
    """All multisets of widths with sum <= max_len (no lower bound)."""
    n = len(widths)
    max_pieces = max_len // widths[0]
    patterns = []
    combo = []

    def dfs(start_idx, count, total):
        if count >= 1:
            patterns.append(tuple(sorted(combo)))
        if total >= max_len or count >= max_pieces:
            return
        for i in range(start_idx, n):
            w = widths[i]
            if total + w > max_len:
                break
            combo.append(w)
            dfs(i, count + 1, total + w)
            combo.pop()

    dfs(0, 0, 0)
    return sorted(set(patterns))


def solve_two_stage(pattern_defs, widths, demand, extra_len=None):
    """pattern_defs: list of tuples-of-widths (all sharing one stock length),
    or list of (widths, stock_length) pairs if extra_len is None.
    Returns (solution as [(pattern_widths, stock_length, count)], produced dict)."""
    if extra_len is not None:
        entries = [(p, extra_len) for p in pattern_defs]
    else:
        entries = pattern_defs

    n = len(entries)
    counts = [Counter(p) for p, _ in entries]

    prob1 = pulp.LpProblem("max_fulfill", pulp.LpMaximize)
    x = [pulp.LpVariable(f"x_{i}", lowBound=0, cat="Integer") for i in range(n)]
    prod_expr = {w: pulp.lpSum(x[i] * counts[i].get(w, 0) for i in range(n)) for w in widths}
    for w in widths:
        prob1 += prod_expr[w] <= demand.get(w, 0)
    prob1 += pulp.lpSum(prod_expr[w] for w in widths)
    prob1.solve(solver)
    fulfill_floor = round(pulp.value(prob1.objective) or 0)

    prob2 = pulp.LpProblem("min_tubes", pulp.LpMinimize)
    x2 = [pulp.LpVariable(f"x2_{i}", lowBound=0, cat="Integer") for i in range(n)]
    prod_expr2 = {w: pulp.lpSum(x2[i] * counts[i].get(w, 0) for i in range(n)) for w in widths}
    for w in widths:
        prob2 += prod_expr2[w] <= demand.get(w, 0)
    prob2 += pulp.lpSum(prod_expr2[w] for w in widths) >= fulfill_floor - 1e-3
    prob2 += pulp.lpSum(x2)
    prob2.solve(solver)

    solution = []
    produced = Counter()
    for i, xi in enumerate(x2):
        v = xi.value()
        if v and v > 0.5:
            c = int(round(v))
            p, L = entries[i]
            solution.append((p, L, c))
            for w in p:
                produced[w] += c
    solution.sort(key=lambda t: -t[2])
    return solution, produced, pulp.LpStatus[prob1.status], pulp.LpStatus[prob2.status]


def main():
    demand = load_demand_from_cutting_plan(os.path.join(BASE_DIR, 'cutting_plan_6600.csv'))
    widths = sorted(demand.keys())
    total_demand = sum(demand.values())
    print(f"Loaded tube demand for {len(widths)} widths, total {total_demand} tube segments needed.")

    # ---- round 1: 4600 / 4400 stock, <2% waste ----
    r1_patterns = generate_round1_patterns(widths, demand)
    print(f"\nRound1: {len(r1_patterns)} feasible (<2% waste) patterns across {ROUND1_LENGTHS}mm stock.")
    r1_solution, r1_produced, s1a, s1b = solve_two_stage(r1_patterns, widths, demand)
    r1_total_tubes = sum(c for _, _, c in r1_solution)
    r1_total_fulfilled = sum(r1_produced.values())
    print(f"Round1 status: {s1a}/{s1b}. Tubes used: {r1_total_tubes}. Segments fulfilled: {r1_total_fulfilled}/{total_demand}.")

    with open(os.path.join(BASE_DIR, 'tube_plan_round1.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w_csv = csv.writer(f)
        w_csv.writerow(['母管長度(mm)', '母管數量', '組合規格(mm)', '段數', '合計寬度(mm)', '修邊損耗(mm)', '修邊損耗率'])
        for p, L, c in r1_solution:
            s = sum(p)
            w_csv.writerow([L, c, ' + '.join(str(x) for x in p), len(p), s, L - s, f"{(L - s) / L:.2%}"])

    # ---- remaining demand after round1 ----
    remaining = {w: demand[w] - r1_produced.get(w, 0) for w in widths if demand[w] - r1_produced.get(w, 0) > 0}
    remaining_widths = sorted(remaining.keys())
    remaining_total = sum(remaining.values())
    print(f"\nRemaining after round1: {remaining_total} segments across {len(remaining_widths)} widths.")

    # ---- round 2: single 4200mm stock, no waste constraint ----
    solution2 = []
    produced2 = Counter()
    s2a = s2b = "N/A"
    if remaining_total > 0:
        r2_patterns = generate_bounded_patterns(remaining_widths, ROUND2_LENGTH)
        print(f"Round2: {len(r2_patterns)} feasible patterns for {ROUND2_LENGTH}mm stock (no waste limit).")
        solution2, produced2, s2a, s2b = solve_two_stage(r2_patterns, remaining_widths, remaining, extra_len=ROUND2_LENGTH)
        r2_total_tubes = sum(c for _, _, c in solution2)
        r2_total_fulfilled = sum(produced2.values())
        print(f"Round2 status: {s2a}/{s2b}. Tubes used: {r2_total_tubes}. Segments fulfilled: {r2_total_fulfilled}/{remaining_total}.")

        with open(os.path.join(BASE_DIR, 'tube_plan_round2.csv'), 'w', encoding='utf-8-sig', newline='') as f:
            w_csv = csv.writer(f)
            w_csv.writerow(['母管長度(mm)', '母管數量', '組合規格(mm)', '段數', '合計寬度(mm)', '修邊損耗(mm)'])
            for p, L, c in solution2:
                s = sum(p)
                w_csv.writerow([L, c, ' + '.join(str(x) for x in p), len(p), s, L - s])

    # ---- final summary ----
    final_produced = Counter()
    for w in widths:
        final_produced[w] = r1_produced.get(w, 0) + produced2.get(w, 0)
    final_shortfall = {w: demand[w] - final_produced.get(w, 0) for w in widths if demand[w] - final_produced.get(w, 0) > 0}

    with open(os.path.join(BASE_DIR, 'tube_plan_summary.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w_csv = csv.writer(f)
        w_csv.writerow(['規格(mm)', '所需紙管數', 'Round1產出', 'Round2產出', '合計產出', '缺口'])
        for w in widths:
            r1 = r1_produced.get(w, 0)
            r2 = produced2.get(w, 0)
            tot = r1 + r2
            w_csv.writerow([w, demand[w], r1, r2, tot, demand[w] - tot])

    total_final = sum(final_produced.values())
    print(f"\n=== Overall summary ===")
    print(f"Total tube segments needed: {total_demand}")
    print(f"Round1 fulfilled: {r1_total_fulfilled} ({r1_total_tubes} x {ROUND1_LENGTHS} tubes)")
    r2_tubes = sum(c for _, _, c in solution2)
    print(f"Round2 fulfilled: {sum(produced2.values())} ({r2_tubes} x {ROUND2_LENGTH}mm tubes)")
    print(f"Final total fulfilled: {total_final}/{total_demand} ({total_final/total_demand:.2%})")
    if final_shortfall:
        print(f"Still short on {len(final_shortfall)} widths: {final_shortfall}")
    else:
        print("All tube demand fulfilled.")


if __name__ == '__main__':
    main()
