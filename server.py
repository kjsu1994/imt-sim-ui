import http.server
import json
import os
import re
import shutil
import string
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.parse
import webbrowser

BASE_DIR = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
LOCAL_INI = os.path.join(BASE_DIR, "data", "omnetpp.ini")
IMAGE_NAME = "florasat-sim:local"
NO_WIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_leo_main():
    candidates = [os.path.abspath(os.path.join(BASE_DIR, "..", "leo-main"))]
    candidates += [f"{d}:\\leo-main" for d in string.ascii_uppercase]
    for path in candidates:
        if os.path.isfile(os.path.join(path, "simulations", "Dijkstra132", "omnetpp.ini")):
            return path
    return None


LEO_DIR = find_leo_main()
INI_PATH = os.path.join(LEO_DIR, "simulations", "Dijkstra132", "omnetpp.ini") if LEO_DIR else LOCAL_INI


def _strip_comment(raw):
    in_q = False
    out = []
    for ch in raw:
        if ch == '"':
            in_q = not in_q
        elif ch == "#" and not in_q:
            break
        out.append(ch)
    return "".join(out).strip()


def _unquote(val):
    v = val.strip()
    return v[1:-1] if len(v) >= 2 and v[0] == '"' and v[-1] == '"' else v


def _num(val, default=0.0):
    m = re.match(r"[-+]?[0-9]*\.?[0-9]+", str(val).strip())
    return float(m.group(0)) if m else default


def _time_sec(val, default=0.0):
    m = re.match(r"^\s*([-+]?[0-9]*\.?[0-9]+)\s*(ms|s|min|h|d)?", str(val).strip())
    if not m:
        return default
    scale = {None: 1.0, "ms": 0.001, "s": 1.0, "min": 60.0, "h": 3600.0, "d": 86400.0}.get(m.group(2), 1.0)
    return float(m.group(1)) * scale


def _parse_ini_tree(entry_path):
    sections = {"General": []}
    extends = {}
    configs = []
    visited = set()

    def walk(path, cur_sec, is_root):
        norm = os.path.normpath(path)
        if norm in visited or not os.path.isfile(norm):
            return cur_sec
        visited.add(norm)
        for raw_line in open(norm, "r", encoding="utf-8"):
            line = _strip_comment(raw_line)
            if not line:
                continue
            m_sec = re.match(r"^\[(?:Config\s+)?([^\]]+)\]$", line)
            if m_sec:
                name = m_sec.group(1).strip()
                cur_sec = "General" if name == "General" else name
                sections.setdefault(cur_sec, [])
                if is_root and cur_sec != "General" and not any(c["name"] == cur_sec for c in configs):
                    configs.append({"name": cur_sec, "description": ""})
                continue
            m_inc = re.match(r"^include\s+(.+)$", line)
            if m_inc:
                rel = _unquote(m_inc.group(1))
                cand = os.path.join(os.path.dirname(norm), rel)
                if not os.path.isfile(cand):
                    cand = os.path.join(BASE_DIR, "data", os.path.basename(rel))
                cur_sec = walk(cand, cur_sec, False)
                continue
            if "=" not in line:
                continue
            k, v = [p.strip() for p in line.split("=", 1)]
            if k == "extends":
                extends[cur_sec] = [x.strip() for x in v.split(",") if x.strip()]
            elif k == "description" and is_root:
                cfg_obj = next((c for c in configs if c["name"] == cur_sec), None)
                if cfg_obj is not None:
                    cfg_obj["description"] = _unquote(v)
            else:
                sections.setdefault(cur_sec, []).append((k, v))
        return cur_sec

    walk(entry_path, "General", True)
    return configs, sections, extends


def _resolve_chain(cfg_name, extends):
    seen, chain = set(), ["General"]
    def visit(name):
        if name in seen or name == "General":
            return
        seen.add(name)
        for p in extends.get(name, []):
            visit(p)
        chain.append(name)
    visit(cfg_name)
    return chain


def _parse_stations(items):
    st_map = {}
    for k, v in items:
        m = re.match(r"^\*\.station\[(\d+)(?:\.\.(\d+))?\]\.(.+)$", k)
        if not m:
            continue
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo
        prop = m.group(3)
        val = _unquote(v)
        for idx in range(lo, hi + 1):
            st = st_map.setdefault(idx, {"id": idx, "name": f"Station {idx}", "lat": 0.0, "lon": 0.0, "alt": 0.0, "mobile": False})
            if prop == "label":
                st["name"] = val
            elif prop == "nodeType":
                st["mobile"] = (val == "mobile")
            elif prop == "mobility.latitude":
                st["lat"] = float(val)
            elif prop == "mobility.longitude":
                st["lon"] = float(val)
            elif prop == "mobility.altitudeKm":
                st["alt"] = _num(val)
            elif prop == "mobility.speed":
                st["speed"] = _num(val)
            elif prop == "mobility.routeStart":
                st["start"] = _num(val)
            elif prop == "mobility.route":
                pts = []
                for pair in val.split():
                    if "," in pair:
                        a, b = pair.split(",", 1)
                        pts.append([float(a), float(b)])
                if pts:
                    st["route"] = pts
                    st["lat"], st["lon"] = pts[0][0], pts[0][1]
    return [st_map[i] for i in sorted(st_map)]


def _parse_terminals(items, limit):
    if limit <= 0:
        return []
    t_map = {}
    for k, v in items:
        m = re.match(r"^\*\.terminal\[(\d+)\]\.mob\.(centerLatitude|centerLongitude)$", k)
        if not m:
            continue
        idx = int(m.group(1))
        if idx >= limit:
            continue
        t = t_map.setdefault(idx, {"id": idx, "name": f"T{idx}", "lat": 0.0, "lon": 0.0, "alt": 0.0})
        if m.group(2) == "centerLatitude":
            t["lat"] = _num(v)
        else:
            t["lon"] = _num(v)
    return [t_map[i] for i in sorted(t_map)]


def read_ini_config(config_name=None):
    configs, sections, extends = _parse_ini_tree(INI_PATH)
    names = [c["name"] for c in configs]
    active = config_name if config_name in names else (names[0] if names else "Dijkstra132")
    chain = _resolve_chain(active, extends)

    flat = {}
    items = []
    resolved = {}
    for sec in chain:
        for k, v in sections.get(sec, []):
            flat[k] = _unquote(v)
            items.append((k, v))
            if k in resolved:
                del resolved[k]
            resolved[k] = {"k": k, "v": v, "sec": sec}

    def get_num(keys, default, conv=_num):
        for k in keys:
            if k in flat:
                return conv(flat[k], default)
        return default

    def get_str(keys, default):
        for k in keys:
            if k in flat:
                return flat[k]
        return default

    num_terminals = int(get_num(["**.numTerminals", "*.numTerminals"], 0))
    desc = next((c["description"] for c in configs if c["name"] == active), "")

    return {
        "iniPath": INI_PATH,
        "leoFound": bool(LEO_DIR),
        "leoDir": LEO_DIR,
        "activeConfig": active,
        "description": desc,
        "extends": extends.get(active, []),
        "chain": chain,
        "configs": [{**c, "extends": extends.get(c["name"], [])} for c in configs],
        "ownEntries": [{"k": k, "v": v} for k, v in sections.get(active, [])],
        "effectiveEntries": list(resolved.values()),
        "simTimeLimit": get_num(["sim-time-limit"], 600.0, _time_sec),
        "minimumElevation": get_num(["*.topologyControl.minimumElevation"], 10.0),
        "metric": get_str(["*.satellite[*].net.routing.metric"], "delay"),
        "routingType": get_str(["*.satellite[*].net.routingType"], "Sat_Net_DijkstraRouting"),
        "altitude": get_num(["*.constellationCreator.altitude"], 550.0),
        "inclination": get_num(["*.constellationCreator.inclination"], 53.0),
        "numSatellites": int(get_num(["*.numSatellites"], 132)),
        "planes": int(get_num(["*.**.planeCount", "*.constellationCreator.planeCount"], 12)),
        "phasing": int(get_num(["*.**.interPlaneSpacing", "*.constellationCreator.interPlaneSpacing"], 1)),
        "raanSpread": get_num(["*.constellationCreator.raanSpread"], 360.0),
        "baseYear": int(get_num(["*.constellationCreator.baseYear"], 20)),
        "baseDay": get_num(["*.constellationCreator.baseDay"], 1.5),
        "maxRoutes": int(get_num(["*.mapDataSource.maxRoutes"], 8)),
        "routeLifetime": get_num(["*.mapDataSource.routeLifetime"], 30.0, _time_sec),
        "numTerminals": num_terminals,
        "stations": _parse_stations(items),
        "terminals": _parse_terminals(items, num_terminals),
    }


def parse_routes_csv(csv_text):
    routes = []
    for line in csv_text.strip().splitlines()[1:]:
        if not line:
            continue
        r = line.split(",")
        if len(r) < 11 or r[0] == "time" or not r[0][0].isdigit():
            continue
        entry = [
            float(r[0]),
            int(r[1]),
            int(r[2].lstrip("GST")),
            int(r[3]),
            int(r[6]),
            float(r[9]),
            [int(x) for x in r[10].split("-") if x],
        ]
        if r[2].startswith("T"):
            entry.append(1)
        routes.append(entry)
    return routes


def ensure_docker_image():
    chk = subprocess.run(
        ["wsl", "--cd", "~", "-e", "docker", "image", "inspect", IMAGE_NAME],
        capture_output=True, creationflags=NO_WIN
    )
    if chk.returncode == 0:
        return
    if not LEO_DIR:
        raise RuntimeError("Docker image missing and leo-main directory was not found.")
    tmp_tar = os.path.join(tempfile.gettempdir(), "florasat_build.tar")
    with tarfile.open(tmp_tar, "w", format=tarfile.GNU_FORMAT) as tar:
        tar.add(os.path.join(BASE_DIR, "Dockerfile"), arcname="Dockerfile")
        for item in ("src", "simulations"):
            tar.add(os.path.join(LEO_DIR, item), arcname=item)
    wsl_tar = "/mnt/" + tmp_tar[0].lower() + tmp_tar[2:].replace("\\", "/")
    res = subprocess.run(
        ["wsl", "--cd", "~", "-e", "bash", "-c", f"docker build -t {IMAGE_NAME} - < '{wsl_tar}'"],
        capture_output=True, text=True, creationflags=NO_WIN
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr or res.stdout)


def run_simulation(config_name="Dijkstra132"):
    ensure_docker_image()
    ini_bytes = open(INI_PATH, "rb").read()
    cmd = (
        f"docker run --rm -i --entrypoint /bin/bash {IMAGE_NAME} -c "
        f"'cat > omnetpp.ini && source /root/omnetpp/setenv >/dev/null 2>&1 && "
        f"source /opt/inet4.5/setenv >/dev/null 2>&1 && "
        f"opp_run -u Cmdenv -c {config_name} -n ../../src:..:/opt/inet4.5/src -l ../../src/flora omnetpp.ini >/dev/null 2>&1 && "
        f"cat results/routes.csv'"
    )
    proc = subprocess.run(
        ["wsl", "--cd", "~", "-e", "bash", "-c", cmd],
        input=ini_bytes, capture_output=True, timeout=600, creationflags=NO_WIN
    )
    csv_text = proc.stdout.decode("utf-8", errors="replace")
    if proc.returncode != 0 or "time,route" not in csv_text:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(err or csv_text or "Simulator failed")

    idx = csv_text.index("time,route")
    clean_csv = csv_text[idx:]
    open(os.path.join(BASE_DIR, "data", "routes.csv"), "w", encoding="utf-8", newline="\n").write(clean_csv)

    if LEO_DIR:
        leo_res_dir = os.path.join(LEO_DIR, "simulations", "Dijkstra132", "results")
        os.makedirs(leo_res_dir, exist_ok=True)
        open(os.path.join(leo_res_dir, "routes.csv"), "w", encoding="utf-8", newline="\n").write(clean_csv)

    routes = parse_routes_csv(clean_csv)
    open(os.path.join(BASE_DIR, "data", "routes_data.js"), "w", encoding="utf-8").write(
        "window.ROUTES=" + json.dumps(routes, separators=(",", ":")) + ";"
    )
    return routes


class SimHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        pass

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/config":
            qs = urllib.parse.parse_qs(parsed.query)
            cfg_name = qs.get("config", [None])[0]
            return self.send_json(read_ini_config(cfg_name))
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if self.path == "/api/open-ini":
            os.startfile(INI_PATH)
            return self.send_json({"ok": True, "path": INI_PATH})

        if self.path == "/api/run":
            try:
                cfg_name = body.get("configName") or read_ini_config().get("activeConfig", "Dijkstra132")
                routes = run_simulation(cfg_name)
                return self.send_json({"ok": True, "routes": routes, "config": read_ini_config(cfg_name)})
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)}, status=500)

        self.send_error(404)


if __name__ == "__main__":
    port = 8090
    url = f"http://127.0.0.1:{port}"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), SimHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        import webview
        webview.create_window("FLoRaSat LEO Simulator", url, width=1520, height=900)
        webview.start()
    except ImportError:
        webbrowser.open(url)
        input(f"Running at {url} (Press Enter to quit)...\n")
    finally:
        srv.shutdown()
