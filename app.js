// Interactive 2D Map, Route Replay & Simulator Runner Controller
const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");
const W = 2160, H = 1080;
const ROUTE_COLORS = ["#ff6b6b", "#40c4ff", "#69f0ae", "#ffe066", "#b388ff", "#ff9e40", "#ea80fc", "#ff5c8a"];

const earthImg = new Image();
earthImg.src = "data/earth.png";
earthImg.onload = () => render();

let routes = window.ROUTES || [];
let simTime = routes.length ? Math.min(1210.0, routes[routes.length - 1][0]) : 0.0;
let maxSimTime = routes.length ? Math.max(10, Math.ceil(routes[routes.length - 1][0])) : 600.0;
let playing = false, speed = 10, selectedRouteId = null, lastFrame = 0;
let lastSatStates = [], lastStationStates = [];

const cfgNameSel = document.getElementById("cfgName");
const srcFilter = document.getElementById("srcFilter");
const dstFilter = document.getElementById("dstFilter");

function populateFilters() {
  const prevSrc = srcFilter.value || "-1";
  const prevDst = dstFilter.value || "-1";
  srcFilter.innerHTML = '<option value="-1">All Sources</option>';
  dstFilter.innerHTML = '<option value="-1">All Destinations</option>';

  const fixed = STATIONS.filter(s => !s.mobile), mobile = STATIONS.filter(s => s.mobile);
  fixed.forEach(s => srcFilter.add(new Option(`GS${s.id}: ${s.name}`, `GS:${s.id}`)));
  mobile.forEach(s => srcFilter.add(new Option(`Mobile ${s.id}: ${s.name}`, `GS:${s.id}`)));
  TERMINALS.forEach(t => srcFilter.add(new Option(`T${t.id}: Terminal ${t.id}`, `T:${t.id}`)));

  mobile.forEach(s => dstFilter.add(new Option(`Mobile ${s.id}: ${s.name}`, `${s.id}`)));
  fixed.forEach(s => dstFilter.add(new Option(`GS${s.id}: ${s.name}`, `${s.id}`)));

  srcFilter.value = [...srcFilter.options].some(o => o.value === prevSrc) ? prevSrc : "-1";
  dstFilter.value = [...dstFilter.options].some(o => o.value === prevDst) ? prevDst : "-1";
}
populateFilters();

function syncTimeBounds(limitSec) {
  const dataMax = routes.length ? Math.ceil(routes[routes.length - 1][0]) : 0;
  maxSimTime = Math.max(10, dataMax || 0, limitSec || 0);
  document.getElementById("timeSlider").max = maxSimTime;
  if (simTime > maxSimTime) simTime = dataMax ? Math.min(maxSimTime, routes[routes.length - 1][0]) : 0;
}
syncTimeBounds(maxSimTime);

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

  let islCount = 0;
  if (document.getElementById("chkIsl").checked) {
    for (const s of sats) {
      if (PLANES > 1) {
        const nextPlane = sats[((s.plane + 1) % PLANES) * SATS_PER_PLANE + s.satInPlane];
        if (nextPlane) {
          drawWrappedLine(s.lon, s.lat, nextPlane.lon, nextPlane.lat, "#9aa4b1", 1, 0.6);
          islCount++;
        }
      }
      if (SATS_PER_PLANE > 1) {
        const nextInPlane = sats[s.plane * SATS_PER_PLANE + ((s.satInPlane + 1) % SATS_PER_PLANE)];
        if (nextInPlane) {
          drawWrappedLine(s.lon, s.lat, nextInPlane.lon, nextInPlane.lat, "#4f8fd6", 1, 0.8);
          islCount++;
        }
      }
    }
  } else {
    islCount = (PLANES > 1 ? sats.length : 0) + (SATS_PER_PLANE > 1 ? sats.length : 0);
  }

  if (document.getElementById("chkGsl").checked) {
    for (const [st, sat] of gslLinks) {
      drawWrappedLine(st.lon, st.lat, sat.lon, sat.lat, st.mobile ? "#00d0ff" : "#22b14c", 2, 0.9);
    }
  }

  const routeLifetime = ORBIT_CFG.routeLifetime || 30.0;
  const maxRoutes = ORBIT_CFG.maxRoutes || 8;
  const endIdx = upperBoundTime(simTime);
  const srcF = srcFilter.value, dstF = parseInt(dstFilter.value, 10);
  const windowRoutes = [];
  for (let i = endIdx - 1; i >= 0 && windowRoutes.length < 40; i--) {
    const r = routes[i];
    if (simTime - r[0] > routeLifetime) break;
    const rSrcKey = (r[7] ? "T:" : "GS:") + r[2];
    if ((srcF === "-1" || rSrcKey === srcF) && (dstF === -1 || r[3] === dstF)) windowRoutes.push(r);
  }
  const drawnRoutes = windowRoutes.slice(0, maxRoutes).reverse();
  const activeSatSet = new Set();

  if (document.getElementById("chkRoutes").checked) {
    drawnRoutes.forEach((r, idx) => {
      const [t, rId, srcId, dstId, hops, ms, path, srcIsTerm] = r;
      const srcSt = srcIsTerm ? (TERMINALS[srcId] || stStates[0]) : (stStates[srcId] || stStates[0]);
      const dstSt = stStates[dstId] || stStates[0];
      const age = Math.max(0, simTime - t);
      const alpha = selectedRouteId === rId ? 1.0 : Math.max(0.15, 1.0 - age / routeLifetime);
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
        ctx.font = "bold 20px sans-serif";
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fillText(`${srcSt.name} -> ${dstSt.name}  ${hops} ISL hops  ${ms.toFixed(1)} ms`, lonToX(pts[0][0]) + 12, latToY(pts[0][1]) - 14);
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

  for (const tm of TERMINALS) {
    ctx.beginPath();
    ctx.arc(lonToX(tm.lon), latToY(tm.lat), 3.5, 0, TWOPI);
    ctx.fillStyle = "#ffe066";
    ctx.fill();
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
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = st.mobile ? "#7fe8ff" : "#ffffff";
      ctx.fillText(st.name, x + 16, y + 18);
    }
    ctx.restore();
  }

  let sumMs = 0, sumHops = 0;
  for (let i = 0; i < endIdx; i++) { sumHops += routes[i][4]; sumMs += routes[i][5]; }
  const avgMs = endIdx ? (sumMs / endIdx).toFixed(1) : "0.0";
  const avgHops = endIdx ? (sumHops / endIdx).toFixed(1) : "0.0";

  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(10, 10, 560, 120);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText(`t = ${simTime.toFixed(0)} s`, 22, 36);
  ctx.fillText(`satellites ${sats.length}   ISL ${islCount}   ground links ${gslLinks.length}`, 22, 62);
  ctx.fillText(`from stations ${endIdx} sent / ${endIdx} delivered, ${avgMs} ms`, 22, 88);
  ctx.fillText(`routing ${ORBIT_CFG.routingType} (${ORBIT_CFG.metric})`, 22, 114);

  document.getElementById("timeLabel").textContent = `t = ${simTime.toFixed(1)} s`;
  document.getElementById("timeSlider").value = simTime;
  document.getElementById("kpiSat").textContent = `${sats.length} / ${islCount}`;
  document.getElementById("kpiGslLabel").textContent = `Active GSL (≥${ORBIT_CFG.minEl}°)`;
  document.getElementById("kpiGsl").textContent = gslLinks.length;
  document.getElementById("kpiPkts").textContent = `${endIdx} / ${routes.length}`;
  document.getElementById("kpiDelay").textContent = `${avgMs} ms / ${avgHops}`;
  document.getElementById("activeCount").textContent = `${windowRoutes.length} in ${routeLifetime}s`;

  const tbody = document.querySelector("#routeTable tbody");
  tbody.innerHTML = windowRoutes.slice(0, 25).map(r => {
    const [t, rId, srcId, dstId, hops, ms, path, srcIsTerm] = r;
    const dstSt = stStates[dstId];
    const srcTag = srcIsTerm ? `T${srcId}` : `GS${srcId}`;
    const dstTag = (dstSt && dstSt.mobile) ? `M${dstId}` : `GS${dstId}`;
    const sel = selectedRouteId === rId ? " class='selected'" : "";
    return `<tr data-id="${rId}" data-t="${t}"${sel}>
      <td>${t.toFixed(1)}s</td>
      <td>${srcTag}→${dstTag}</td>
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

// Hover Tooltip on Map (accounts for object-fit: contain letterboxing)
const tooltip = document.getElementById("tooltip");
canvas.onmousemove = e => {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / W, rect.height / H);
  if (!scale) return (tooltip.hidden = true);
  const offX = (rect.width - W * scale) / 2, offY = (rect.height - H * scale) / 2;
  const mx = (e.clientX - rect.left - offX) / scale, my = (e.clientY - rect.top - offY) / scale;
  if (mx < 0 || mx > W || my < 0 || my > H) return (tooltip.hidden = true);
  let hit = null;
  for (const st of lastStationStates) {
    if (Math.hypot(lonToX(st.lon) - mx, latToY(st.lat) - my) < 14) {
      hit = `${st.mobile ? "Mobile Terminal" : "Ground Station"} #${st.id}\n${st.name}\nLat: ${st.lat.toFixed(2)}°, Lon: ${st.lon.toFixed(2)}°`;
      break;
    }
  }
  if (!hit) {
    for (const tm of TERMINALS) {
      if (Math.hypot(lonToX(tm.lon) - mx, latToY(tm.lat) - my) < 9) {
        hit = `IoT Terminal T${tm.id}\nLat: ${tm.lat.toFixed(2)}°, Lon: ${tm.lon.toFixed(2)}°`;
        break;
      }
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
    const wrap = canvas.parentElement.getBoundingClientRect();
    tooltip.hidden = false;
    tooltip.textContent = hit;
    tooltip.style.left = `${Math.min(wrap.width - 210, e.clientX - wrap.left + 12)}px`;
    tooltip.style.top = `${Math.min(wrap.height - 70, e.clientY - wrap.top + 12)}px`;
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
      const isTerm = r[2].startsWith("T");
      const row = [
        parseFloat(r[0]), parseInt(r[1], 10), parseInt(r[2].replace(/^[A-Z]+/, ""), 10),
        parseInt(r[3], 10), parseInt(r[6], 10), parseFloat(r[9]), r[10].split("-").map(Number)
      ];
      if (isTerm) row.push(1);
      return row;
    });
    if (routes.length) syncTimeBounds(Math.ceil(routes[routes.length - 1][0]));
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

const escHtml = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const iniFilter = document.getElementById("iniFilter");
const chkShowNodes = document.getElementById("chkShowNodes");
let currentEffectiveEntries = [];

function flashEl(el) {
  if (!el) return;
  el.classList.remove("flash-change");
  void el.offsetWidth;
  el.classList.add("flash-change");
  clearTimeout(el._flashTid);
  el._flashTid = setTimeout(() => el.classList.remove("flash-change"), 900);
}

function renderIniTable() {
  const q = (iniFilter.value || "").trim().toLowerCase();
  const showNodes = chkShowNodes.checked;
  const rows = currentEffectiveEntries.filter(e => {
    if (!showNodes && !q && /^\*\.(station|terminal)\[\d+\]\.(mob|mobility|label|nodeType)/.test(e.k)) return false;
    return !q || e.k.toLowerCase().includes(q) || String(e.v).toLowerCase().includes(q) || e.sec.toLowerCase().includes(q);
  });
  document.querySelector("#iniTable tbody").innerHTML = rows.map(e => {
    const ov = e.sec !== "General" ? " class=\"ini-override\"" : "";
    return `<tr${ov}><td class="ini-k" title="${escHtml(e.k)}">${escHtml(e.k)}</td><td class="ini-v" title="${escHtml(e.v)}">${escHtml(e.v)}</td><td class="ini-s">[${escHtml(e.sec)}]</td></tr>`;
  }).join("");
  document.getElementById("iniCount").textContent = `표시 ${rows.length} / 전체 ${currentEffectiveEntries.length}개 INI 키 (파란 강조 = 상속/시나리오 설정)`;
}

iniFilter.oninput = renderIniTable;
chkShowNodes.onchange = renderIniTable;

function updateProfileBox(cfg, highlight) {
  const iniSrc = document.getElementById("cfgIniSrc");
  const descEl = document.getElementById("cfgDesc");
  const extEl = document.getElementById("cfgExtends");
  const ownEl = document.getElementById("cfgOwnIni");

  if (cfg.iniPath) {
    iniSrc.textContent = cfg.leoFound ? `📂 ${cfg.iniPath}` : `⚠️ 내장 백업: ${cfg.iniPath}`;
    iniSrc.title = cfg.iniPath;
    iniSrc.style.color = cfg.leoFound ? "#69f0ae" : "#ffe066";
  } else if (!location.protocol.startsWith("http")) {
    iniSrc.textContent = "ℹ️ 로컬 HTML 모드 (기본 내장 orbit.js · 전체 INI 확인은 sim-ui.exe 실행)";
    iniSrc.style.color = "#8da2c0";
  }

  const desc = cfg.description || "";
  descEl.textContent = desc;
  descEl.hidden = !desc;

  const chainTxt = Array.isArray(cfg.extends) && cfg.extends.length
    ? `extends = ${cfg.extends.join(", ")}`
    : (Array.isArray(cfg.chain) && cfg.chain.length > 1 ? `상속: ${cfg.chain.join(" → ")}` : "");
  extEl.textContent = chainTxt;
  extEl.hidden = !chainTxt;

  const active = cfg.activeConfig || cfgNameSel.value || "Dijkstra132";
  const ownLines = (cfg.ownEntries || []).map(e => `${e.k} = ${e.v}`);
  ownEl.textContent = `[Config ${active}]\n` + (ownLines.length ? ownLines.join("\n") : "; (직접 오버라이드 없음 — extends 설정 그대로 사용)");

  if (highlight) flashEl(document.getElementById("cfgProfile"));
}

function applyLoadedConfig(cfg, opts = {}) {
  if (!cfg) return;
  if (Array.isArray(cfg.configs) && cfg.configs.length) {
    cfgNameSel.innerHTML = "";
    cfg.configs.forEach(c => {
      const opt = new Option(c.name, c.name);
      if (c.description) opt.title = c.description;
      cfgNameSel.add(opt);
    });
    if (cfg.activeConfig) cfgNameSel.value = cfg.activeConfig;
    cfgNameSel.dataset.loaded = "1";
  }

  updateOrbitConfig({
    altitude: cfg.altitude, inclination: cfg.inclination, minEl: cfg.minimumElevation,
    numSatellites: cfg.numSatellites, planes: cfg.planes, phasing: cfg.phasing,
    raanSpread: cfg.raanSpread, baseYear: cfg.baseYear, baseDay: cfg.baseDay,
    routingType: cfg.routingType, metric: cfg.metric, maxRoutes: cfg.maxRoutes, routeLifetime: cfg.routeLifetime,
    stations: cfg.stations, terminals: cfg.terminals
  });
  if (Array.isArray(cfg.stations) || Array.isArray(cfg.terminals)) populateFilters();
  if (cfg.simTimeLimit) syncTimeBounds(cfg.simTimeLimit);

  const active = cfg.activeConfig || cfgNameSel.value;
  const rShort = (ORBIT_CFG.routingType || "Routing").replace(/^Sat_Net_|Routing$/g, "");
  document.title = `FLoRaSat LEO Simulator (${active})`;
  document.getElementById("topBadge").textContent =
    `${active} · Walker-Delta ${SATS.length}/${ORBIT_CFG.planes}/${ORBIT_CFG.phasing} · ${ORBIT_CFG.altitude}km · ${ORBIT_CFG.inclination}° · ${rShort} (${ORBIT_CFG.metric})`;

  currentEffectiveEntries = Array.isArray(cfg.effectiveEntries) ? cfg.effectiveEntries : [];
  updateProfileBox(cfg, !!opts.announce);
  renderIniTable();

  if (opts.announce) {
    setStatus(`📌 [${active}] .ini 로드됨 (직접 설정 ${(cfg.ownEntries || []).length}줄 · 유효 키 ${currentEffectiveEntries.length}개)`);
  }
  render();
}

updateProfileBox({}, false);
renderIniTable();

if (location.protocol.startsWith("http")) {
  const fetchConfig = (cfg, announce = false) =>
    fetch(cfg ? `/api/config?config=${encodeURIComponent(cfg)}` : "/api/config")
      .then(r => r.json()).then(d => applyLoadedConfig(d, { announce })).catch(() => {});
  fetchConfig();
  cfgNameSel.onchange = () => fetchConfig(cfgNameSel.value, true);
  document.getElementById("btnRefreshIni").onclick = () => fetchConfig(cfgNameSel.value, true);
  window.addEventListener("focus", () => fetchConfig(cfgNameSel.dataset.loaded ? cfgNameSel.value : "", false));
}

document.getElementById("btnOpenIni").onclick = async () => {
  if (!location.protocol.startsWith("http")) {
    return setStatus("⚠️ sim-ui.exe로 실행해야 원본 .ini 파일을 열 수 있습니다.");
  }
  const res = await fetch("/api/open-ini", { method: "POST" }).then(r => r.json());
  if (res.ok) setStatus(`📂 열림: ${res.path}`);
};

document.getElementById("btnRunSim").onclick = async e => {
  const btn = e.target;
  const cfgName = cfgNameSel.value;
  if (!location.protocol.startsWith("http")) {
    return setStatus("⚠️ 시뮬레이션 실행은 sim-ui.exe에서 동작합니다.");
  }
  btn.disabled = true;
  setStatus(`⏳ [${cfgName}] omnetpp.ini 그대로 OMNeT++ 시뮬레이션 실행 중...`);
  try {
    const t0 = performance.now();
    const res = await fetch("/api/run", { method: "POST", body: JSON.stringify({ configName: cfgName }) }).then(r => r.json());
    if (!res.ok) throw new Error(res.error || "Simulation failed");
    routes = res.routes;
    simTime = routes.length ? routes[0][0] : 0;
    applyLoadedConfig(res.config, { announce: false });
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`✅ [${cfgName}] 완료! (${elapsed}s 소요 · 패킷 ${routes.length}개 로드됨)`);
  } catch (err) {
    setStatus(`❌ 실행 오류: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

render();
