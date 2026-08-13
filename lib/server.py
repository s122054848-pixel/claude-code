"""
Local-only web server for the live, single-page dispatch planner.

Serves lib/template.html (the same artifact-style 3D-loading UI used for static reports) as
the front page, with no order data embedded -- the page's own JS calls back to /api/orders
whenever the user picks a date range or plant, and this server runs extract_orders.ps1 (the
existing 32-bit-ODBC extraction script, unmodified) to answer it. This replaces the old
RunReport.hta workflow of "fill in a separate launcher window, wait, then a static HTML file
pops up in a new browser tab" with one page the user just... uses, the same way they'd use the
demo Artifact: pick a range, see the report, change the range, see it update.

Binds to 127.0.0.1 only. Never intended to be reachable from any machine but this one -- there
is no authentication, and /api/orders shells out to a script that reads ERP credentials from
config.json.
"""
import csv
import datetime
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import urllib.parse
import webbrowser

LIB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(LIB_DIR)
sys.path.insert(0, LIB_DIR)
import build_dispatch  # noqa: E402  (rows_to_raw_lines, PLANT_NAMES -- shared with the static export path)

CONFIG_PATH = os.path.join(ROOT, "config.json")
TEMPLATE_PATH = os.path.join(LIB_DIR, "template.html")
EXTRACT_SCRIPT = os.path.join(LIB_DIR, "extract_orders.ps1")
OUTPUT_DIR = os.path.join(ROOT, "output")
PS_32BIT = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe")
PORT = 8765

REPORT_DEFAULTS_PLACEHOLDER = (
    '/*__REPORT_DEFAULTS__*/{"truckL":8700,"truckW":2400,"truckH":2400,"loadMode":"pallet",'
    '"plantCode":"T2","dateLabel":"2026-07-01","rangeStart":"2026-07-01","rangeEnd":"2026-07-01"}'
    '/*__END_REPORT_DEFAULTS__*/'
)


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def run_extraction(start, end):
    """Runs the existing extract_orders.ps1 unmodified (32-bit PowerShell, same as run.ps1 does)
    and returns the parsed CSV rows. Writes to a throwaway temp file rather than a fixed name in
    output/ so overlapping requests (e.g. a plant switch fired right after a date change) can
    never read a half-written file from a different, still-running extraction."""
    fd, csv_path = tempfile.mkstemp(suffix=".csv", prefix="live_orders_", dir=OUTPUT_DIR)
    os.close(fd)
    try:
        cmd = [
            PS_32BIT, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", EXTRACT_SCRIPT,
            "-StartDate", start, "-EndDate", end, "-ConfigPath", CONFIG_PATH, "-OutCsv", csv_path,
        ]
        # extract_orders.ps1 runs three sequential ODBC queries, each with its own 90s
        # CommandTimeout -- worst case (every query right at its own limit) is comfortably
        # over 180s, and this session's ERP connection has been intermittently slow/flaky
        # throughout, so 180s cut off at least one otherwise-fine query mid-flight.
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "extract_orders.ps1 failed")
        with open(csv_path, encoding="utf-8-sig") as f:
            return list(csv.DictReader(f))
    finally:
        try:
            os.remove(csv_path)
        except OSError:
            pass


def default_range():
    # matches the demo Artifact's own rolling window (see dispatch_template.html defaultRange())
    today = datetime.date.today()
    start = today - datetime.timedelta(days=7)
    end = today + datetime.timedelta(days=5)
    return start.isoformat(), end.isoformat()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "DispatchPlannerLive/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_index()
        elif parsed.path == "/api/orders":
            self._serve_orders(urllib.parse.parse_qs(parsed.query))
        else:
            self.send_error(404, "Not found")

    def _serve_index(self):
        try:
            config = load_config()
        except Exception as e:
            self.send_error(500, f"config.json 讀取失敗: {e}")
            return
        plant_code = config["db"]["database"]
        truck = config.get("truck", {})
        range_start, range_end = default_range()
        report_defaults = {
            "truckL": truck.get("L", 8700), "truckW": truck.get("W", 2400), "truckH": truck.get("H", 2400),
            "loadMode": "pallet", "plantCode": plant_code, "dateLabel": "即時查詢",
            "rangeStart": range_start, "rangeEnd": range_end,
            "liveApi": True,
        }
        with open(TEMPLATE_PATH, encoding="utf-8") as f:
            tpl = f.read()
        html = tpl.replace(
            REPORT_DEFAULTS_PLACEHOLDER,
            json.dumps(report_defaults, ensure_ascii=False, separators=(",", ":")),
        )
        html = html.replace(
            "<title>排車單與3D裝載模擬</title>",
            "<title>出貨排車 &amp; 3D裝載模擬（即時）</title>",
        )
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_orders(self, qs):
        start = (qs.get("start") or [""])[0]
        end = (qs.get("end") or [""])[0]
        plant = (qs.get("plant") or [""])[0]
        if not start or not end:
            self._send_json(400, {"error": "缺少 start/end 參數"})
            return
        try:
            config = load_config()
        except Exception as e:
            self._send_json(500, {"error": f"無法讀取 config.json：{e}"})
            return
        configured_plant = config["db"]["database"]
        # This deployment's config.json is wired to exactly one ERP database (one plant) --
        # extract_orders.ps1 has no -Database override, so a request for any other plant can't
        # actually be served. Reject explicitly rather than silently querying the wrong plant.
        if plant and plant != configured_plant:
            plant_name = build_dispatch.PLANT_NAMES.get(configured_plant, configured_plant)
            self._send_json(400, {"error": f"這台工具目前只設定連線到 {configured_plant}（{plant_name}），無法查詢 {plant}"})
            return
        try:
            rows = run_extraction(start, end)
        except Exception as e:
            self._send_json(502, {"error": f"查詢ERP失敗：{e}"})
            return
        raw_lines = build_dispatch.rows_to_raw_lines(rows)
        label = build_dispatch.PLANT_NAMES.get(configured_plant, configured_plant)
        self._send_json(200, {"label": label, "lines": raw_lines})


def find_free_port(preferred):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", preferred))
        s.close()
        return preferred
    except OSError:
        s.close()
        s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s2.bind(("127.0.0.1", 0))
        port = s2.getsockname()[1]
        s2.close()
        return port


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    port = find_free_port(PORT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"出貨排車 & 3D裝載模擬（即時版）已啟動：{url}")
    print("這個視窗要保持開啟 -- 關閉視窗（或按 Ctrl+C）就會停止伺服器。")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
