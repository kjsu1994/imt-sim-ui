import http.server
import json
import os
import re
import shutil
import string
import subprocess
import tempfile
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_INI = os.path.join(BASE_DIR, "data", "omnetpp.ini")


def find_leo_main():
    # 1. Sibling directory (e.g., ../leo-main)
    candidates = [os.path.abspath(os.path.join(BASE_DIR, "..", "leo-main"))]
    # 2. Root of any mounted drive C:\ .. Z:\ (e.g., C:\leo-main, O:\leo-main)
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
    txt = re.sub(r'^(\*\.mapDataSource\.graphLogFile\s*=\s*)"[^"]*"', r'\1""', txt, flags=re.M)

    open(INI_PATH, "w", encoding="utf-8", newline="\n").write(txt)
    if INI_PATH != LOCAL_INI:
        shutil.copyfile(INI_PATH, LOCAL_INI)


def ensure_docker_image():
    chk = subprocess.run(["wsl", "--cd", "~", "-e", "docker", "image", "inspect", "florasat-sim:local"], capture_output=True)
    if chk.returncode == 0:
        return True, ""
    if not LEO_DIR:
        return False, "florasat-sim:local 도커 이미지가 없고 leo-main 원본 폴더를 찾을 수 없습니다."

    # Auto-build image on a new PC using leo-main + Dockerfile
    dockerfile_src = os.path.join(BASE_DIR, "Dockerfile")
    dockerfile_dst = os.path.join(LEO_DIR, "Dockerfile")
    shutil.copyfile(dockerfile_src, dockerfile_dst)
    tar_path = os.path.join(tempfile.gettempdir(), "florasat_build.tar")
    try:
        subprocess.run([
            "tar.exe", "--exclude=simulations/Dijkstra132/results_sample/graph.jsonl",
            "--exclude=.git", "-cf", tar_path, "-C", LEO_DIR, "."
        ], check=True)
        wsl_tar = "/mnt/" + tar_path[0].lower() + tar_path[2:].replace("\\", "/")
        build = subprocess.run(
            ["wsl", "--cd", "~", "-e", "bash", "-c", f"docker build -t florasat-sim:local - < '{wsl_tar}'"],
            capture_output=True, text=True
        )
        return build.returncode == 0, (build.stderr or build.stdout)[-1500:]
    finally:
        if os.path.exists(dockerfile_dst):
            os.remove(dockerfile_dst)
        if os.path.exists(tar_path):
            os.remove(tar_path)


def parse_routes_csv(csv_text):
    lines = [l.strip() for l in csv_text.splitlines() if l.strip()]
    data = []
    for l in lines:
        r = l.split(",")
        if len(r) < 11 or r[0] == "time" or not r[0][0].isdigit():
            continue
        src = int(r[2][2:]) if r[2].startswith("GS") else int(r[2].lstrip("T"))
        data.append([
            round(float(r[0]), 2), int(r[1]), src, int(r[3]),
            int(r[6]), round(float(r[9]), 1), [int(x) for x in r[10].split("-") if x]
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
            update_ini_config(body)
            ok, err = ensure_docker_image()
            if not ok:
                return self.send_json({"ok": False, "error": err}, status=500)

            cfg = read_ini_config()
            config_name = body.get("configName", "Dijkstra132")
            sim_limit = cfg["simTimeLimit"]

            # Pipe omnetpp.ini via stdin into stateless container and read routes.csv via stdout
            sim_cmd = (
                "docker run --rm -i --entrypoint /bin/bash florasat-sim:local -c '"
                "cat > omnetpp.ini && "
                "source /root/omnetpp/setenv >/dev/null 2>&1 && source /opt/inet4.5/setenv >/dev/null 2>&1 && "
                "mkdir -p results && rm -f results/routes.csv && "
                f"opp_run -u Cmdenv -c {config_name} -n ../../src:..:/opt/inet4.5/src "
                "-l ../../src/flora -l /opt/inet4.5/src/INET "
                f"--sim-time-limit={sim_limit}s omnetpp.ini >/dev/null 2>&1 && "
                "cat results/routes.csv'"
            )
            proc = subprocess.run(
                ["wsl", "--cd", "~", "-e", "bash", "-c", sim_cmd],
                input=open(INI_PATH, "rb").read(),
                capture_output=True
            )
            if proc.returncode != 0:
                err_txt = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")[-1500:]
                return self.send_json({"ok": False, "error": err_txt}, status=500)

            csv_text = proc.stdout.decode("utf-8", errors="replace")
            open(os.path.join(BASE_DIR, "data", "routes.csv"), "w", encoding="utf-8", newline="\n").write(csv_text)
            if LEO_DIR:
                leo_res_dir = os.path.join(LEO_DIR, "simulations", "Dijkstra132", "results")
                os.makedirs(leo_res_dir, exist_ok=True)
                open(os.path.join(leo_res_dir, "routes.csv"), "w", encoding="utf-8", newline="\n").write(csv_text)

            routes = parse_routes_csv(csv_text)
            open(os.path.join(BASE_DIR, "data", "routes_data.js"), "w", encoding="utf-8").write(
                "window.ROUTES=" + json.dumps(routes, separators=(",", ":")) + ";"
            )
            return self.send_json({"ok": True, "config": cfg, "routes": routes})

        self.send_error(404)


if __name__ == "__main__":
    port = 8090
    url = f"http://localhost:{port}"
    print(f"LEO Simulator Web UI: {url}")
    print(f"Auto-detected INI   : {INI_PATH}")
    if not os.environ.get("NO_BROWSER"):
        webbrowser.open(url)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), SimHandler).serve_forever()
