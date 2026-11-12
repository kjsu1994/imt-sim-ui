// Interactive 2D Map, Route Replay & Simulator Runner Controller
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const W = 2160, H = 1080;
const ROUTE_COLORS = ["#ff6b6b", "#40c4ff", "#69f0ae", "#ffe066", "#b388ff", "#ff9e40", "#ea80fc", "#ff5c8a"];
const ROUTE_LIFETIME = 30.0, MAX_ROUTES = 8;

const earthImg = new Image();
earthImg.src = "data/earth.png";
earthImg.onload = () => render();

let simTime = 1210.0, maxSimTime = 5700.0, playing = false, speed = 10, selectedRouteId = null, lastFrame = 0;
let routes = window.ROUTES || [];
let lastSatStates = [], lastStationStates = [];

// Populate station filter dropdowns
const srcFilter = document.getElementById("srcFilter");
const dstFilter = document.getElementById("dstFilter");
STATIONS.forEach(s => {
  const opt = new Option(`${s.mobile ? "Mobile" : "GS" + s.id}: ${s.name}`, s.id);
  (s.mobile ? dstFilter : srcFilter).add(opt);
});

const lonToX = lon => (lon + 180) / 360 * W;
const latToY = lat => (90 - lat) / 180 * H;

function drawWrappedLine(lon1, lat1, lon2, lat2, color, width, alpha = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (Math.abs(lon1 - lon2) <= 180) {
    ctx.moveTo(lonToX(lon1), latToY(lat1));
    ctx.lineTo(lonToX(lon2), latToY(lat2));
  } else {
    const lon2Adj = lon2 < lon1 ? lon2 + 360 : lon2 - 360;
    const boundaryLon = lon2 < lon1 ? 180 : -180;
    const t = (boundaryLon - lon1) / (lon2Adj - lon1);
    const latMid = lat1 + t * (lat2 - lat1);
    ctx.moveTo(lonToX(lon1), latToY(lat1));
    ctx.lineTo(lonToX(boundaryLon), latToY(latMid));
    ctx.moveTo(lonToX(-boundaryLon), latToY(latMid));
    ctx.lineTo(lonToX(lon2), latToY(lat2));
  }
  ctx.stroke();
  ctx.restore();
}

function drawFootprint(latDeg, lonDeg, altKm) {
  const Re = 6371, el = ORBIT_CFG.minEl * DEG;
  const psi = Math.acos(Math.min(1, Re / (Re + altKm) * Math.cos(el))) - el;
  const lat0 = latDeg * DEG, lon0 = lonDeg * DEG;
  ctx.save();
  ctx.strokeStyle = "rgba(240,196,25,0.65)";
  ctx.fillStyle = "rgba(240,196,25,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let prevLon = null, wrapped = false;
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const brg = (i / 48) * TWOPI;
    const sLat = Math.sin(lat0) * Math.cos(psi) + Math.cos(lat0) * Math.sin(psi) * Math.cos(brg);
    const lat = Math.asin(Math.max(-1, Math.min(1, sLat)));
    const y = Math.sin(brg) * Math.sin(psi) * Math.cos(lat0);
    const x = Math.cos(psi) - Math.sin(lat0) * sLat;
    let lon = (lon0 + Math.atan2(y, x)) * RAD;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) wrapped = true;
    prevLon = lon;
    pts.push([lonToX(lon), latToY(lat * RAD)]);
  }
  if (!wrapped) {
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function upperBoundTime(t) {
  let lo = 0, hi = routes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (routes[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function render() {
  ctx.fillStyle = "#0d2240";
  ctx.fillRect(0, 0, W, H);
  if (earthImg.complete && earthImg.naturalWidth) ctx.drawImage(earthImg, 0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = lonToX(lon);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let lat = -90; lat <= 90; lat += 30) {
    const y = latToY(lat);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const sats = SATS.map(s => getSatState(s, simTime));
  const gmst = sats[0].gmst;
  const stStates = STATIONS.map(st => {
    const p = getStationPos(st, simTime);
    return { ...p, eci: siteEci(p.lat, p.lon, p.alt, gmst) };
  });
  lastSatStates = sats;
  lastStationStates = stStates;

  const gslLinks = [];
  const gslSatSet = new Set();
  for (const st of stStates) {
    for (const sat of sats) {
      if (getElevationDeg(st.eci, sat) >= ORBIT_CFG.minEl) {
        gslLinks.push([st, sat]);
        gslSatSet.add(sat.idx);
      }
    }
  }

  if (document.getElementById("chkFoot").checked) {
    gslSatSet.forEach(idx => drawFootprint(sats[idx].lat, sats[idx].lon, sats[idx].alt));
  }

  if (document.getElementById("chkIsl").checked) {
    for (const s of sats) {
      const nextInPlane = sats[s.plane * SATS_PER_PLANE + ((s.satInPlane + 1) % SATS_PER_PLANE)];
      const nextPlane = sats[((s.plane + 1) % PLANES) * SATS_PER_PLANE + s.satInPlane];
      drawWrappedLine(s.lon, s.lat, nextPlane.lon, nextPlane.lat, "#9aa4b1", 1, 0.6);
      drawWrappedLine(s.lon, s.lat, nextInPlane.lon, nextInPlane.lat, "#4f8fd6", 1, 0.8);
    }
  }

  if (document.getElementById("chkGsl").checked) {
    for (const [st, sat] of gslLinks) {
      drawWrappedLine(st.lon, st.lat, sat.lon, sat.lat, st.mobile ? "#00d0ff" : "#22b14c", 2, 0.9);
    }
  }

  const endIdx = upperBoundTime(simTime);
  const srcF = parseInt(srcFilter.value, 10), dstF = parseInt(dstFilter.value, 10);
  const windowRoutes = [];
  for (let i = endIdx - 1; i >= 0 && windowRoutes.length < 40; i--) {
    const r = routes[i];
    if (simTime - r[0] > ROUTE_LIFETIME) break;
    if ((srcF === -1 || r[2] === srcF) && (dstF === -1 || r[3] === dstF)) windowRoutes.push(r);
  }
  const drawnRoutes = windowRoutes.slice(0, MAX_ROUTES).reverse();
  const activeSatSet = new Set();

  if (document.getElementById("chkRoutes").checked) {
    drawnRoutes.forEach((r, idx) => {
      const [t, rId, srcId, dstId, hops, ms, path] = r;
      const srcSt = stStates[srcId] || stStates[0], dstSt = stStates[dstId] || stStates[0];
      const age = Math.max(0, simTime - t);
      const alpha = selectedRouteId === rId ? 1.0 : Math.max(0.15, 1.0 - age / ROUTE_LIFETIME);
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
      const width = selectedRouteId === rId ? 6 : 4;
      const pts = [[srcSt.lon, srcSt.lat]];
      path.forEach(satIdx => {
        if (sats[satIdx]) {
          activeSatSet.add(satIdx);
          pts.push([sats[satIdx].lon, sats[satIdx].lat]);
        }
      });
      pts.push([dstSt.lon, dstSt.lat]);
      for (let i = 1; i < pts.length; i++) {
        drawWrappedLine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], color, width, alpha);
      }
      if (document.getElementById("chkLabels").checked) {
        ctx.save();
        ctx.font = "bold 14px sans-serif";
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fillText(`${srcSt.name} -> ${dstSt.name}  ${hops} ISL hops  ${ms.toFixed(1)} ms`, lonToX(pts[0][0]) + 10, latToY(pts[0][1]) - 12);
        ctx.restore();
      }
    });
  }

  for (const s of sats) {
    ctx.beginPath();
    ctx.arc(lonToX(s.lon), latToY(s.lat), 4, 0, TWOPI);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    if (activeSatSet.has(s.idx)) {
      ctx.strokeStyle = "orange";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  const showLabels = document.getElementById("chkLabels").checked;
  for (const st of stStates) {
    const x = lonToX(st.lon), y = latToY(st.lat);
    ctx.save();
    if (!st.mobile) {
      ctx.fillStyle = "#ff4040";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.fillRect(x - 6, y - 6, 12, 12);
      ctx.strokeRect(x - 6, y - 6, 12, 12);
    } else {
      ctx.fillStyle = "#00d0ff";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x - 7, y + 6);
      ctx.lineTo(x + 7, y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (showLabels) {
      ctx.font = "bold 14px sans-serif";
      ctx.fillStyle = st.mobile ? "#7fe8ff" : "#ffffff";
      ctx.fillText(st.name, x + 14, y + 16);
    }
    ctx.restore();
  }

  let sumMs = 0, sumHops = 0;
  for (let i = 0; i < endIdx; i++) { sumHops += routes[i][4]; sumMs += routes[i][5]; }
  const avgMs = endIdx ? (sumMs / endIdx).toFixed(1) : "0.0";
  const avgHops = endIdx ? (sumHops / endIdx).toFixed(1) : "0.0";

  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(8, 8, 360, 88);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(`t = ${simTime.toFixed(0)} s`, 18, 30);
  ctx.fillText(`satellites ${sats.length}   ISL 264   ground links ${gslLinks.length}`, 18, 50);
  ctx.fillText(`from stations ${endIdx} sent / ${endIdx} delivered, ${avgMs} ms`, 18, 70);
  ctx.fillText(`routing Sat_Net_DijkstraRouting (${document.getElementById("cfgMetric").value})`, 18, 90);

  document.getElementById("timeLabel").textContent = `t = ${simTime.toFixed(1)} s`;
  document.getElementById("timeSlider").value = simTime;
  document.getElementById("kpiGsl").textContent = gslLinks.length;
  document.getElementById("kpiPkts").textContent = `${endIdx} / ${routes.length}`;
  document.getElementById("kpiDelay").textContent = `${avgMs} ms / ${avgHops}`;
  document.getElementById("activeCount").textContent = `${windowRoutes.length} in 30s`;

  const tbody = document.querySelector("#routeTable tbody");
  tbody.innerHTML = windowRoutes.slice(0, 25).map(r => {
    const [t, rId, srcId, dstId, hops, ms, path] = r;
    const sel = selectedRouteId === rId ? " class='selected'" : "";
    return `<tr data-id="${rId}" data-t="${t}"${sel}>
      <td>${t.toFixed(1)}s</td>
      <td>GS${srcId}→M${dstId}</td>
      <td>${hops}</td>
      <td>${ms.toFixed(1)}ms</td>
      <td class="path-cell" title="${path.join("-")}">${path.join("-")}</td>
    </tr>`;
  }).join("");
}

function loop(ts) {
  if (playing) {
    const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
    simTime = Math.min(maxSimTime, simTime + dt * speed);
    if (simTime >= maxSimTime) { playing = false; document.getElementById("btnPlay").textContent = "▶ Play"; }
    render();
  }
  lastFrame = ts;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

document.getElementById("btnPlay").onclick = e => {
  playing = !playing;
  e.target.textContent = playing ? "⏸ Pause" : "▶ Play";
};
document.getElementById("btnStepBack").onclick = () => { simTime = Math.max(0, simTime - 1); render(); };
document.getElementById("btnStepFwd").onclick = () => { simTime = Math.min(maxSimTime, simTime + 1); render(); };
document.getElementById("btnSnap").onclick = () => { simTime = Math.min(maxSimTime, 1210); selectedRouteId = null; render(); };
document.getElementById("timeSlider").oninput = e => { simTime = parseFloat(e.target.value); render(); };
document.getElementById("speedSel").onchange = e => { speed = parseFloat(e.target.value); };
["chkIsl", "chkGsl", "chkFoot", "chkRoutes", "chkLabels", "srcFilter", "dstFilter"].forEach(id => {
  document.getElementById(id).onchange = () => render();
});

document.querySelector("#routeTable tbody").onclick = e => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  selectedRouteId = parseInt(tr.dataset.id, 10);
  simTime = parseFloat(tr.dataset.t);
  render();
};

// Hover Tooltip on Map
const tooltip = document.getElementById("tooltip");
canvas.onmousemove = e => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width, scaleY = H / rect.height;
  const mx = (e.clientX - rect.left) * scaleX, my = (e.clientY - rect.top) * scaleY;
  let hit = null;
  for (const st of lastStationStates) {
    if (Math.hypot(lonToX(st.lon) - mx, latToY(st.lat) - my) < 14) {
      hit = `${st.mobile ? "Mobile Terminal" : "Ground Station"} #${st.id}\n${st.name}\nLat: ${st.lat.toFixed(2)}°, Lon: ${st.lon.toFixed(2)}°`;
      break;
    }
  }
  if (!hit) {
    for (const s of lastSatStates) {
      if (Math.hypot(lonToX(s.lon) - mx, latToY(s.lat) - my) < 10) {
        hit = `Satellite sat[${s.idx}] (Plane ${s.plane}, #${s.satInPlane})\nLat: ${s.lat.toFixed(2)}°, Lon: ${s.lon.toFixed(2)}°, Alt: ${s.alt.toFixed(0)}km`;
        break;
      }
    }
  }
  if (hit) {
    tooltip.hidden = false;
    tooltip.style.left = `${e.clientX - rect.left + 12}px`;
    tooltip.style.top = `${e.clientY - rect.top + 12}px`;
    tooltip.textContent = hit;
  } else {
    tooltip.hidden = true;
  }
};
canvas.onmouseleave = () => { tooltip.hidden = true; };

// Custom CSV Loader
document.getElementById("csvInput").onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.trim().split(/\r?\n/).slice(1);
    // shortcut: assumes standard 11-column routes.csv format, upgrade if schema changes
    routes = lines.filter(Boolean).map(l => {
      const r = l.split(",");
      return [parseFloat(r[0]), parseInt(r[1], 10), parseInt(r[2].replace("GS", ""), 10), parseInt(r[3], 10), parseInt(r[6], 10), parseFloat(r[9]), r[10].split("-").map(Number)];
    });
    if (routes.length) {
      maxSimTime = Math.ceil(routes[routes.length - 1][0]);
      document.getElementById("timeSlider").max = maxSimTime;
      simTime = Math.min(simTime, maxSimTime);
    }
    render();
  };
  reader.readAsText(file);
};

// ---- Local Backend API Integration (server.py) ----
const runStatus = document.getElementById("runStatus");
function setStatus(msg) {
  runStatus.hidden = !msg;
  runStatus.textContent = msg;
}

function getFormPayload() {
  return {
    configName: document.getElementById("cfgName").value,
    metric: document.getElementById("cfgMetric").value,
    simTimeLimit: parseFloat(document.getElementById("cfgSimTime").value),
    sendInterval: parseFloat(document.getElementById("cfgSendInt").value),
    minimumElevation: parseFloat(document.getElementById("cfgMinEl").value),
    altitude: parseFloat(document.getElementById("cfgAlt").value)
  };
}

function applyLoadedConfig(cfg) {
  if (!cfg) return;
  document.getElementById("cfgMetric").value = cfg.metric || "delay";
  document.getElementById("cfgSimTime").value = cfg.simTimeLimit || 600;
  document.getElementById("cfgSendInt").value = cfg.sendInterval || 2;
  document.getElementById("cfgMinEl").value = cfg.minimumElevation || 10;
  document.getElementById("cfgAlt").value = cfg.altitude || 550;
  updateOrbitConfig({ altitude: cfg.altitude, inclination: cfg.inclination, minEl: cfg.minimumElevation });
  document.getElementById("topBadge").textContent =
    `Walker-Delta 132/12/1 · ${ORBIT_CFG.altitude}km · ${ORBIT_CFG.inclination}° · Dijkstra (${cfg.metric})`;
  render();
}

if (location.protocol.startsWith("http")) {
  const syncIniFromDisk = () => fetch("/api/config").then(r => r.json()).then(applyLoadedConfig).catch(() => {});
  syncIniFromDisk();
  window.addEventListener("focus", syncIniFromDisk);
}

document.getElementById("btnOpenIni").onclick = async () => {
  if (!location.protocol.startsWith("http")) {
    return setStatus("⚠️ sim-ui.exe로 실행해야 원본 .ini 파일을 열 수 있습니다.");
  }
  const res = await fetch("/api/open-ini", { method: "POST" }).then(r => r.json());
  if (res.ok) setStatus(`📂 열림: ${res.path}`);
};

document.getElementById("btnSaveIni").onclick = async () => {
  const payload = getFormPayload();
  applyLoadedConfig(payload);
  if (!location.protocol.startsWith("http")) {
    return setStatus("💾 화면에 설정 반영됨 (파일 저장은 sim-ui.exe에서 동작)");
  }
  const res = await fetch("/api/save-ini", { method: "POST", body: JSON.stringify(payload) }).then(r => r.json());
  if (res.ok) setStatus(`💾 저장 완료: ${res.config.iniPath}`);
};

document.getElementById("btnRunSim").onclick = async e => {
  const btn = e.target;
  btn.disabled = true;
  const payload = getFormPayload();
  setStatus(`⏳ [${payload.configName}] (${payload.simTimeLimit}s) OMNeT++ 시뮬레이션 실행 중...`);
  try {
    const t0 = performance.now();
    const res = await fetch("/api/run", { method: "POST", body: JSON.stringify(payload) }).then(r => r.json());
    if (!res.ok) throw new Error(res.error || "Simulation failed");
    routes = res.routes;
    maxSimTime = payload.simTimeLimit;
    document.getElementById("timeSlider").max = maxSimTime;
    simTime = Math.min(simTime, maxSimTime);
    applyLoadedConfig(res.config);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`✅ 완료! (${elapsed}s 소요 · 패킷 ${routes.length}개 로드됨)`);
  } catch (err) {
    setStatus(`❌ 실행 오류: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

render();
