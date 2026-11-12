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


def read_ini_config():
    txt = open(INI_PATH, "r", encoding="utf-8").read()
    def val(pat, default):
        m = re.search(pat, txt, re.M)
        return m.group(1) if m else default

    return {
        "iniPath": INI_PATH,
        "leoDir": LEO_DIR,
        "simTimeLimit": float(val(r"^sim-time-limit\s*=\s*([0-9.]+)", "600")),
        "sendInterval": float(val(r"^\*\.station\[\*\]\.traffic\.sendInterval\s*=\s*([0-9.]+)", "2")),
        "minimumElevation": float(val(r"^\*\.topologyControl\.minimumElevation\s*=\s*([0-9.]+)", "10.0")),
        "metric": val(r'^\*\.satellite\[\*\]\.net\.routing\.metric\s*=\s*"(\w+)"', "delay"),
        "altitude": float(val(r"^\*\.constellationCreator\.altitude\s*=\s*([0-9.]+)", "550")),
        "inclination": float(val(r"^\*\.constellationCreator\.inclination\s*=\s*([0-9.]+)", "53")),
    }


def update_ini_config(cfg):
    txt = open(INI_PATH, "r", encoding="utf-8").read()
    if "simTimeLimit" in cfg:
        txt = re.sub(r"^(sim-time-limit\s*=\s*)[0-9.]+s", rf"\g<1>{cfg['simTimeLimit']}s", txt, flags=re.M)
    if "sendInterval" in cfg:
        txt = re.sub(r"^(\*\.station\[\*\]\.traffic\.sendInterval\s*=\s*)[0-9.]+s", rf"\g<1>{cfg['sendInterval']}s", txt, flags=re.M)
    if "minimumElevation" in cfg:
        txt = re.sub(r"^(\*\.topologyControl\.minimumElevation\s*=\s*)[0-9.]+", rf"\g<1>{cfg['minimumElevation']}", txt, flags=re.M)
        txt = re.sub(r"^(\*\.station\[\*\]\.\*\*\.minimumElevation\s*=\s*)[0-9.]+", rf"\g<1>{cfg['minimumElevation']}", txt, flags=re.M)
    if "metric" in cfg:
        txt = re.sub(r'^(\*\.satellite\[\*\]\.net\.routing\.metric\s*=\s*)"\w+"', rf'\g<1>"{cfg["metric"]}"', txt, flags=re.M)
    if "altitude" in cfg:
        txt = re.sub(r"^(\*\.constellationCreator\.altitude\s*=\s*)[0-9.]+", rf"\g<1>{cfg['altitude']}", txt, flags=re.M)
    if "inclination" in cfg:
        txt = re.sub(r"^(\*\.constellationCreator\.inclination\s*=\s*)[0-9.]+", rf"\g<1>{cfg['inclination']}", txt, flags=re.M)

    open(INI_PATH, "w", encoding="utf-8", newline="\n").write(txt)
    if INI_PATH != LOCAL_INI:
        shutil.copyfile(INI_PATH, LOCAL_INI)


def parse_routes_csv(csv_text):
    routes = []
    for line in csv_text.strip().splitlines()[1:]:
        if not line:
            continue
        r = line.split(",")
        if len(r) < 11 or r[0] == "time" or not r[0][0].isdigit():
            continue
        routes.append([
            float(r[0]),
            int(r[1]),
            int(r[2].replace("GS", "")),
            int(r[3]),
            int(r[6]),
            float(r[9]),
            [int(x) for x in r[10].split("-") if x],
        ])
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
        if self.path == "/api/config":
            return self.send_json(read_ini_config())
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if self.path == "/api/open-ini":
            os.startfile(INI_PATH)
            return self.send_json({"ok": True, "path": INI_PATH})

        if self.path == "/api/save-ini":
            update_ini_config(body)
            return self.send_json({"ok": True, "config": read_ini_config()})

        if self.path == "/api/run":
            try:
                update_ini_config(body)
                routes = run_simulation(body.get("configName", "Dijkstra132"))
                return self.send_json({"ok": True, "routes": routes, "config": read_ini_config()})
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
