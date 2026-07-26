"""
Build a dispatch sheet (CSV + XLSX) and an interactive 3D-loading / route-map HTML report
from one day's order-line CSV (as produced by extract_orders.ps1).

Usage:
    python build_dispatch.py --csv output\\orders_2026-07-08.csv --date 2026-07-08 ^
        --template lib\\template.html --out-html output\\dispatch_2026-07-08.html ^
        --out-csv output\\dispatch_sheet_2026-07-08.csv --out-xlsx output\\dispatch_sheet_2026-07-08.xlsx ^
        --truck-l 8400 --truck-w 2400 --truck-h 2300

run.ps1 wraps this call -- you normally don't need to invoke it directly.
"""
import argparse
import csv
import json
import math
import os
import urllib.request

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


def haversine_km(p1, p2):
    R = 6371.0
    lat1, lng1 = map(math.radians, p1)
    lat2, lng2 = map(math.radians, p2)
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _osrm_table_call(points_subset, base_url, timeout):
    coord_str = ";".join(f"{lng},{lat}" for lat, lng in points_subset)
    url = f"{base_url}/table/v1/driving/{coord_str}?annotations=distance"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = json.load(resp)
    if data.get("code") != "Ok":
        raise ValueError(data.get("code", "unknown OSRM error"))
    return data["distances"]


def osrm_distance_matrix_km(codes, points, base_url="http://router.project-osrm.org", timeout=20, chunk=45):
    """Real driving-distance matrix (km) for parallel lists of customer codes / (lat,lng)
    points, via the public OSRM demo server. Returns {code_a: {code_b: km}}, possibly partial,
    or None if every request failed outright -- callers should fall back to haversine_km for
    any missing pair rather than fail the whole report over a network hiccup.

    The public demo caps a single /table request at roughly 100x100 nodes, so on a busy day
    with more than ~50 delivery customers this tiles the codes into groups of `chunk` and
    fetches one request per unordered group pair (covering that pair's union, which yields
    all four sub-blocks at once) instead of a single all-at-once call.
    """
    n = len(points)
    if n < 2:
        return None
    groups = [list(range(i, min(i + chunk, n))) for i in range(0, n, chunk)]
    result = {a: {} for a in codes}
    any_ok = False
    for gi in range(len(groups)):
        for gj in range(gi, len(groups)):
            union = groups[gi] if gi == gj else groups[gi] + groups[gj]
            try:
                dist = _osrm_table_call([points[i] for i in union], base_url, timeout)
            except Exception as e:
                print(f"WARNING: OSRM road-distance lookup failed for group {gi}x{gj} ({e}); those pairs fall back to straight-line distance.")
                continue
            any_ok = True
            for a2, ai in enumerate(union):
                for b2, bi in enumerate(union):
                    d = dist[a2][b2]
                    if d is not None:
                        result[codes[ai]][codes[bi]] = d / 1000.0
    return result if any_ok else None


def write_dispatch_xlsx(out_xlsx, header, rows):
    """Formatted .xlsx twin of the dispatch-sheet CSV -- same columns/rows, but with a real
    number type on the numeric columns (so Excel won't mangle order numbers as dates/scientific
    notation the way it sometimes does with plain CSV), bold header, borders, autosized columns,
    a frozen header row and an autofilter so it's usable straight out of the download."""
    numeric_cols = {6, 7, 8, 9, 10}  # 1-indexed: 箱數, 寬mm, 長mm, 厚mm, 堆疊數

    wb = Workbook()
    ws = wb.active
    ws.title = "排車明細"

    header_fill = PatternFill("solid", fgColor="1F2937")
    header_font = Font(bold=True, color="FFFFFF")
    thin = Side(style="thin", color="D0D0D0")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    ws.append(header)
    for col_idx in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border

    for row in rows:
        ws.append(row)

    max_len = [len(str(h)) for h in header]
    for r_idx, row in enumerate(rows, start=2):
        for c_idx, value in enumerate(row, start=1):
            cell = ws.cell(row=r_idx, column=c_idx)
            cell.border = border
            if c_idx in numeric_cols:
                cell.alignment = Alignment(horizontal="right")
            max_len[c_idx - 1] = max(max_len[c_idx - 1], len(str(value)))

    for c_idx, width in enumerate(max_len, start=1):
        ws.column_dimensions[get_column_letter(c_idx)].width = min(max(width + 3, 8), 40)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{len(rows) + 1}"

    os.makedirs(os.path.dirname(out_xlsx) or ".", exist_ok=True)
    wb.save(out_xlsx)


def build(csv_path, date_label, truck_l, truck_w, truck_h, out_html, out_csv, template_path, out_xlsx=None):
    with open(csv_path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    # Build stack units: one physical "stack" = boxes piled to (near) truck height, footprint w x l
    stacks = []
    for r in rows:
        qty = float(r["qty_box"])
        w = float(r["width_mm"]); l = float(r["length_mm"]); t = float(r["thickness_mm"])
        if w <= 0 or l <= 0 or t <= 0 or qty <= 0:
            continue
        boxes_per_stack = max(1, math.floor(truck_h / t))
        lat = (r.get("ship_lat") or "").strip()
        lng = (r.get("ship_lng") or "").strip()
        remaining = qty
        while remaining > 0:
            n = min(boxes_per_stack, remaining)
            stacks.append({
                "order_no": r["order_no"],
                "cust_code": r["ship_cust_code"].strip(),
                "cust_name": r["ship_cust_name"].strip(),
                "lat": float(lat) if lat else None,
                "lng": float(lng) if lng else None,
                "item_code": r["item_code"],
                "boxes": n, "w": w, "l": l, "t": t, "height": n * t,
            })
            remaining -= n

    if not stacks:
        raise SystemExit(f"No usable order lines found in {csv_path}")

    # --- route order customers by geographic proximity (occ732 lat / occ733 lng) ---
    # nearest-neighbour greedy chain: start from the westmost-southmost customer, always
    # hop to the closest unvisited one, so consecutive customers in the pack order are
    # geographically close and tend to land on the same truck(s).
    cust_points = {}
    for s in stacks:
        if s["cust_code"] not in cust_points and s["lat"] is not None and s["lng"] is not None:
            cust_points[s["cust_code"]] = (s["lat"], s["lng"])
    no_geo = sorted({s["cust_code"] for s in stacks if s["cust_code"] not in cust_points})

    # real driving-distance matrix between all delivery customers, via OSRM -- used both to
    # order the route (nearest neighbour by road, not as the crow flies) and to report the
    # actual distance a truck will drive. Falls back to haversine per-pair if OSRM is
    # unreachable, so a network hiccup degrades the estimate rather than breaking the report.
    dist_codes = list(cust_points.keys())
    dist_matrix = osrm_distance_matrix_km(dist_codes, [cust_points[c] for c in dist_codes]) if dist_codes else None

    def road_km(code_a, code_b):
        if dist_matrix and code_a in dist_matrix and dist_matrix[code_a].get(code_b) is not None:
            return dist_matrix[code_a][code_b]
        return haversine_km(cust_points[code_a], cust_points[code_b])

    route_order = {}
    if cust_points:
        remaining_custs = dict(cust_points)
        start = min(remaining_custs, key=lambda c: (remaining_custs[c][0], remaining_custs[c][1]))
        order_seq = [start]
        cur_code = start
        remaining_custs.pop(start)
        while remaining_custs:
            nxt = min(remaining_custs, key=lambda c: road_km(cur_code, c))
            order_seq.append(nxt)
            cur_code = nxt
            remaining_custs.pop(nxt)
        route_order = {c: i for i, c in enumerate(order_seq)}
    for i, c in enumerate(no_geo):
        route_order[c] = len(route_order) + i

    cust_name_by_code = {}
    for s in stacks:
        cust_name_by_code.setdefault(s["cust_code"], s["cust_name"])

    # group by delivery customer, ordered along the proximity route, so nearby customers
    # land on consecutive trucks; largest-footprint-first within a customer for packing efficiency.
    stacks.sort(key=lambda s: (route_order[s["cust_code"]], -(s["w"] * s["l"])))

    trucks = []

    def new_truck():
        return {"rows": [], "cur_x": 0.0}

    def try_place(truck, stack):
        w, l = stack["w"], stack["l"]
        for row in truck["rows"]:
            for (dx, dy) in [(l, w), (w, l)]:
                if dy <= row["free_y"] and dx <= row["depth"]:
                    item = dict(stack)
                    item["x"] = row["x0"]; item["y"] = row["used_y"]; item["dx"] = dx; item["dy"] = dy
                    row["items"].append(item)
                    row["used_y"] += dy
                    row["free_y"] -= dy
                    return True
        for (dx, dy) in [(l, w), (w, l)]:
            if dx <= (truck_l - truck["cur_x"]) and dy <= truck_w:
                row = {"x0": truck["cur_x"], "depth": dx, "used_y": 0.0, "free_y": truck_w, "items": []}
                item = dict(stack)
                item["x"] = row["x0"]; item["y"] = 0.0; item["dx"] = dx; item["dy"] = dy
                row["items"].append(item)
                row["used_y"] += dy
                row["free_y"] -= dy
                truck["rows"].append(row)
                truck["cur_x"] += dx
                return True
        return False

    cur = new_truck()
    trucks.append(cur)
    for s in stacks:
        if not try_place(cur, s):
            cur = new_truck()
            trucks.append(cur)
            if not try_place(cur, s):
                raise RuntimeError(f"stack too large for an empty truck: {s}")

    truck_out = []
    for ti, t in enumerate(trucks, start=1):
        items = [it for row in t["rows"] for it in row["items"]]
        floor_used = sum(it["dx"] * it["dy"] for it in items)
        cust_counts = {}
        for it in items:
            key = (it["cust_code"], it["cust_name"])
            cust_counts[key] = cust_counts.get(key, 0) + 1
        primary_cust = max(cust_counts.items(), key=lambda kv: kv[1])[0] if cust_counts else ("", "")
        truck_out.append({
            "truck_no": ti,
            "floor_utilization_pct": round(floor_used / (truck_l * truck_w) * 100, 1),
            "num_stacks": len(items),
            "num_customers": len(cust_counts),
            "primary_cust_code": primary_cust[0],
            "primary_cust_name": primary_cust[1],
            "items": items,
        })

    print(f"Total trucks needed: {len(truck_out)}")
    for t in truck_out:
        tag = t["primary_cust_name"] + ("" if t["num_customers"] == 1 else f"+{t['num_customers'] - 1}")
        print(f"  Truck {t['truck_no']:2d}: {t['num_stacks']:3d} stacks, floor util {t['floor_utilization_pct']}%  [{tag}]")

    # dispatch sheet (排車單): per truck x order aggregation, grouped by delivery customer
    sheet_header = ["車次", "送貨客戶代號", "送貨客戶名稱", "訂單號", "品號", "箱數", "寬mm", "長mm", "厚mm", "堆疊數"]
    sheet_rows = []
    for t in truck_out:
        agg = {}
        for it in t["items"]:
            key = (it["cust_code"], it["cust_name"], it["order_no"], it["item_code"], it["w"], it["l"], it["t"])
            agg.setdefault(key, {"boxes": 0, "stacks": 0})
            agg[key]["boxes"] += it["boxes"]
            agg[key]["stacks"] += 1
        for (cust_code, cust_name, order_no, item, w, l, th), v in sorted(agg.items(), key=lambda kv: route_order[kv[0][0]]):
            sheet_rows.append([f"車次{t['truck_no']}", cust_code, cust_name, order_no, item, int(v["boxes"]), w, l, th, v["stacks"]])

    os.makedirs(os.path.dirname(out_csv) or ".", exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
        wr = csv.writer(f)
        wr.writerow(sheet_header)
        wr.writerows(sheet_rows)
    print("Dispatch sheet written:", out_csv)

    if out_xlsx:
        write_dispatch_xlsx(out_xlsx, sheet_header, sheet_rows)
        print("Dispatch sheet (Excel) written:", out_xlsx)

    # --- compact embeddable JSON for the HTML report (3D view + route map + dispatch table) ---
    customers = sorted({(s["cust_code"], s["cust_name"]) for s in stacks})
    cust_index = {c[0]: i for i, c in enumerate(customers)}
    cust_labels = [f"{c[0]} {c[1]}" for c in customers]

    compact_trucks = []
    for t in truck_out:
        agg = {}
        citems = []
        for it in t["items"]:
            citems.append({
                "x": round(it["x"], 1), "y": round(it["y"], 1),
                "dx": round(it["dx"], 1), "dy": round(it["dy"], 1),
                "h": round(it["height"], 1),
                "c": cust_index[it["cust_code"]],
                "o": it["order_no"], "it": it["item_code"], "b": int(it["boxes"]),
            })
            key = (it["cust_code"], it["cust_name"], it["order_no"], it["item_code"], it["w"], it["l"], it["t"])
            agg.setdefault(key, {"boxes": 0, "stacks": 0})
            agg[key]["boxes"] += it["boxes"]
            agg[key]["stacks"] += 1
        rows_agg = [
            {"cust_code": k[0], "cust_name": k[1], "order_no": k[2], "item": k[3], "w": k[4], "l": k[5], "t": k[6],
             "boxes": int(v["boxes"]), "stacks": v["stacks"]}
            for k, v in sorted(agg.items(), key=lambda kv: route_order[kv[0][0]])
        ]

        truck_custs = sorted({it["cust_code"] for it in t["items"]}, key=lambda c: route_order[c])
        stop_points = [
            {"code": c, "name": cust_name_by_code[c], "lat": cust_points[c][0], "lng": cust_points[c][1]}
            for c in truck_custs if c in cust_points
        ]
        dist_km = sum(
            road_km(stop_points[i]["code"], stop_points[i + 1]["code"])
            for i in range(len(stop_points) - 1)
        )

        compact_trucks.append({
            "n": t["truck_no"], "util": t["floor_utilization_pct"], "stacks": t["num_stacks"],
            "primaryCust": f"{t['primary_cust_code']} {t['primary_cust_name']}" + ("" if t["num_customers"] == 1 else f" 等{t['num_customers']}家"),
            "items": citems, "rows": rows_agg,
            "stops": stop_points, "distanceKm": round(dist_km, 1),
        })

    all_cust_points = [
        {"code": c, "name": cust_name_by_code[c], "lat": lat, "lng": lng}
        for c, (lat, lng) in cust_points.items()
    ]

    embed = {
        "truckDims": {"L": truck_l, "W": truck_w, "H": truck_h},
        "customers": cust_labels,
        "allCustPoints": all_cust_points,
        "trucks": compact_trucks,
        "meta": {
            "date": date_label,
            "totalOrders": len({s["order_no"] for s in stacks}),
            "totalLines": len(rows),
            "totalBoxes": int(sum(s["boxes"] for s in stacks)),
            "totalTrucks": len(compact_trucks),
            "totalCustomers": len(customers),
            "custWithGeo": len(cust_points),
        },
    }

    with open(template_path, encoding="utf-8") as f:
        tpl = f.read()
    data_json = json.dumps(embed, ensure_ascii=False, separators=(",", ":"))
    html = tpl.replace("/*__EMBED_DATA__*/{}/*__END_EMBED_DATA__*/", data_json)
    html = html.replace("<title>2026-07-01 排車與3D裝載模擬 — 龍潭廠</title>",
                         f"<title>{date_label} 排車與3D裝載模擬 — 龍潭廠</title>")

    os.makedirs(os.path.dirname(out_html) or ".", exist_ok=True)
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    print("HTML report written:", out_html)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--csv", required=True, help="input order-line CSV from extract_orders.ps1")
    ap.add_argument("--date", required=True, help="date label shown in the report, e.g. 2026-07-08")
    ap.add_argument("--template", required=True, help="path to lib/template.html")
    ap.add_argument("--out-html", required=True)
    ap.add_argument("--out-csv", required=True, help="output dispatch-sheet CSV path")
    ap.add_argument("--out-xlsx", help="output dispatch-sheet Excel (.xlsx) path (optional)")
    ap.add_argument("--truck-l", type=float, default=8400.0, help="truck interior length, mm")
    ap.add_argument("--truck-w", type=float, default=2400.0, help="truck interior width, mm")
    ap.add_argument("--truck-h", type=float, default=2300.0, help="truck interior height, mm")
    args = ap.parse_args()

    build(args.csv, args.date, args.truck_l, args.truck_w, args.truck_h, args.out_html, args.out_csv, args.template, args.out_xlsx)


if __name__ == "__main__":
    main()
