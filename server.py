import http.server
import json
import os
import re
import shutil
import subprocess
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LEO_INI = r"O:\leo-main\simulations\Dijkstra132\omnetpp.ini" # ini 파일 저장위치
LOCAL_INI = os.path.join(BASE_DIR, "data", "omnetpp.ini")
INI_PATH = LEO_INI if os.path.exists(LEO_INI) else LOCAL_INI


def read_ini_config():
    txt = open(INI_PATH, "r", encoding="utf-8").read()
    def find_val(pattern, default):
        m = re.search(pattern, txt, re.M)
        return m.group(1) if m else default

    return {
        "iniPath": INI_PATH,
        "simTimeLimit": float(find_val(r"^sim-time-limit\s*=\s*([0-9.]+)", "600")),
        "sendInterval": float(find_val(r"^\*\.station\[\*\]\.traffic\.sendInterval\s*=\s*([0-9.]+)", "2")),
        "minimumElevation": float(find_val(r"^\*\.topologyControl\.minimumElevation\s*=\s*([0-9.]+)", "10.0")),
        "metric": find_val(r'^\*\.satellite\[\*\]\.net\.routing\.metric\s*=\s*"(\w+)"', "delay"),
        "altitude": float(find_val(r"^\*\.constellationCreator\.altitude\s*=\s*([0-9.]+)", "550")),
        "inclination": float(find_val(r"^\*\.constellationCreator\.inclination\s*=\s*([0-9.]+)", "53")),
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
    txt = re.sub(r'^(\*\.mapDataSource\.graphLogFile\s*=\s*)"[^"]*"', r'\1""', txt, flags=re.M)

    open(INI_PATH, "w", encoding="utf-8", newline="\n").write(txt)
    if INI_PATH != LOCAL_INI:
        shutil.copyfile(INI_PATH, LOCAL_INI)


def parse_routes_csv(csv_text):
    lines = [l.strip() for l in csv_text.splitlines() if l.strip()][1:]
    data = []
    for l in lines:
        r = l.split(",")
        if len(r) < 11:
            continue
        src = int(r[2][2:]) if r[2].startswith("GS") else int(r[2].lstrip("T"))
        data.append([
            round(float(r[0]), 2),
            int(r[1]),
            src,
            int(r[3]),
            int(r[6]),
            round(float(r[9]), 1),
            [int(x) for x in r[10].split("-") if x]
        ])
    return data


class SimHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

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
            if body.get("updateIni", True):
                update_ini_config(body)
            cfg = read_ini_config()
            config_name = body.get("configName", "Dijkstra132")
            sim_limit = cfg["simTimeLimit"]

            # Sync current omnetpp.ini into WSL ~/florasat/simulations/Dijkstra132/omnetpp.ini
            ini_bytes = open(INI_PATH, "rb").read()
            subprocess.run(
                ["wsl", "--cd", "~", "-e", "bash", "-c", "cat > ~/florasat/simulations/Dijkstra132/omnetpp.ini"],
                input=ini_bytes, check=True
            )

            # Run actual OMNeT++ simulation inside WSL Docker container
            sim_cmd = (
                "docker run --rm --entrypoint /bin/bash "
                "-v ~/florasat/simulations/Dijkstra132:/opt/florasat/simulations/Dijkstra132 "
                "florasat-sim:local -c '"
                "source /root/omnetpp/setenv -q && source /opt/inet4.5/setenv -q && "
                "mkdir -p results && rm -f results/routes.csv results/graph.jsonl && "
                f"opp_run -u Cmdenv -c {config_name} -n ../../src:..:/opt/inet4.5/src "
                "-l ../../src/flora -l /opt/inet4.5/src/INET "
                f"--sim-time-limit={sim_limit}s omnetpp.ini'"
            )
            proc = subprocess.run(
                ["wsl", "--cd", "~", "-e", "bash", "-c", sim_cmd],
                capture_output=True, text=True
            )
            if proc.returncode != 0:
                return self.send_json({"ok": False, "error": (proc.stderr or proc.stdout)[-1500:]}, status=500)

            # Fetch generated routes.csv from WSL
            csv_proc = subprocess.run(
                ["wsl", "--cd", "~", "-e", "bash", "-c", "cat ~/florasat/simulations/Dijkstra132/results/routes.csv"],
                capture_output=True, text=True, check=True
            )
            csv_text = csv_proc.stdout
            open(os.path.join(BASE_DIR, "data", "routes.csv"), "w", encoding="utf-8", newline="\n").write(csv_text)
            routes = parse_routes_csv(csv_text)
            open(os.path.join(BASE_DIR, "data", "routes_data.js"), "w", encoding="utf-8").write(
                "window.ROUTES=" + json.dumps(routes, separators=(",", ":")) + ";"
            )
            return self.send_json({
                "ok": True,
                "config": cfg,
                "routes": routes,
                "log": (proc.stdout or "")[-800:]
            })

        self.send_error(404)


if __name__ == "__main__":
    port = 8090
    url = f"http://localhost:{port}"
    print(f"LEO Simulator Web UI running at {url}")
    print(f"Target INI: {INI_PATH}")
    webbrowser.open(url)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), SimHandler).serve_forever()
