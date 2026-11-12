// LEO Constellation (Walker-Delta 132/12/1) & SGP4A / Mobile Station Propagator
const PI = 3.1415926535, TWOPI = 2 * PI, DEG = PI / 180, RAD = 180 / PI;
const XKMPER = 6378.135, F = 1 / 298.26, GE = 398600.8, J2 = 1.0826158e-3, J3 = -2.53881e-6, J4 = -1.65597e-6;
const CK2 = J2 / 2, CK4 = -3 * J4 / 8, XJ3 = J3, AE = 1.0, OMEGA_E = 1.00273790934, SEC_DAY = 86400;
const XKE = Math.sqrt(3600 * GE / (XKMPER ** 3));
const QOMS2T = ((AE + 120 / XKMPER) - (AE + 78 / XKMPER)) ** 4;
const S = AE + 78 / XKMPER;

// Epoch: 2020 day 1.5 -> JD
function julianInit(year, day) {
  const y = year - 1, A = Math.trunc(y / 100), B = 2 - A + Math.trunc(A / 4);
  return Math.trunc(365.25 * y) + Math.trunc(30.6001 * 14) + 1720994.5 + B + day;
}
const JD_BASE = julianInit(2020, 1.5);

function toGMST(jd) {
  const UT = (jd + 0.5) % 1, TU = (jd - 2451545.0 - UT) / 36525.0;
  let gmst = (24110.54841 + TU * (8640184.812866 + TU * (0.093104 - TU * 6.2e-6)) + SEC_DAY * OMEGA_E * UT) % SEC_DAY;
  if (gmst < 0) gmst += SEC_DAY;
  return TWOPI * (gmst / SEC_DAY);
}
const fmod2p = x => { let m = x % TWOPI; return m < 0 ? m + TWOPI : m; };
const actan = (sinx, cosx) => cosx === 0 ? (sinx > 0 ? PI / 2 : 1.5 * PI) : (cosx > 0 ? Math.atan(sinx / cosx) : PI + Math.atan(sinx / cosx));

// Precompute SGP4A constants for the 132 satellites (altitude=550km, incl=53deg, ecc=0, argp=0, bstar=0)
const SATS = [];
const PLANES = 12, SATS_PER_PLANE = 11, TOTAL_SATS = 132;
const incl = 53 * DEG, cosio = Math.cos(incl), sinio = Math.sin(incl), theta2 = cosio * cosio;
const x3thm1 = 3 * theta2 - 1, x1mth2 = 1 - theta2, x7thm1 = 7 * theta2 - 1;
const a0 = (550 + XKMPER) / XKMPER, n0 = Math.sqrt(398601.2 / ((550 + XKMPER) ** 3)) * 60;
const a1 = (XKE / n0) ** (2 / 3), d1 = 1.5 * CK2 * x3thm1 / (a1 * a1), a0dp = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 ** 3);
const p0 = a0dp, q0 = AE + 120 / XKMPER, perigee = (p0 - AE) * XKMPER;
const s4 = S, qoms24 = QOMS2T, pinvsq = 1 / (a0dp * a0dp), tsi = 1 / (a0dp - s4), eta = 0;
const coef = qoms24 * (tsi ** 4), c2 = coef * n0 * (a0dp * (1 + 1.5 * eta * eta) + 0.75 * CK2 * tsi / a0dp * x3thm1 * (8 + 3 * eta * eta));
const c1 = 0, c4 = 2 * n0 * coef * a0dp * (2 * eta * (1 + eta * eta) + CK2 * tsi / (a0dp) * (-3 * x3thm1 * (1 - 2 * eta * eta)));
const c5 = 2 * coef * a0dp * (1 + 2.75 * eta * eta);
const theta4 = theta2 * theta2, temp1 = 3 * CK2 * pinvsq * n0, temp2 = temp1 * CK2 * pinvsq, temp3 = 1.25 * CK4 * pinvsq * pinvsq * n0;
const xmdot = n0 + 0.5 * temp1 * x3thm1 + 0.0625 * temp2 * (13 - 78 * theta2 + 137 * theta4);
const omgdot = -0.5 * temp1 * (1 - 5 * theta2) + 0.0625 * temp2 * (7 - 114 * theta2 + 395 * theta4) + temp3 * (3 - 36 * theta2 + 49 * theta4);
const xhdot1 = -temp1 * cosio, xnodot = xhdot1 + (0.5 * temp2 * (4 - 19 * theta2) + 2 * temp3 * (3 - 7 * theta2)) * cosio;
const xlcof = 0.125 * XJ3 / CK2 * sinio * (3 + 5 * cosio) / (1 + cosio), aycof = 0.25 * XJ3 / CK2 * sinio;

for (let p = 0; p < PLANES; p++) {
  for (let s = 0; s < SATS_PER_PLANE; s++) {
    const idx = s + p * SATS_PER_PLANE;
    const raan = (p * 30) * DEG;
    const ma = ((p * (360 / TOTAL_SATS) + s * (360 / SATS_PER_PLANE)) % 360) * DEG;
    SATS.push({ idx, plane: p, satInPlane: s, raan, ma });
  }
}

function getSatState(sat, tSec) {
  const tsince = tSec / 60, jd = JD_BASE + tSec / SEC_DAY;
  const xmp = sat.ma + xmdot * tsince, omega = omgdot * tsince, xnode = sat.raan + xnodot * tsince;
  const a = a0dp, e = 1e-6, xl = xmp + omega + xnode;
  const axn = e * Math.cos(omega), ayn = e * Math.sin(omega) + aycof / a, xlt = xl + xlcof * axn / a;
  const capu = fmod2p(xlt - xnode);
  let epw = capu;
  for (let i = 0; i < 6; i++) {
    const sinepw = Math.sin(epw), cosepw = Math.cos(epw);
    const f = capu - epw + axn * sinepw - ayn * cosepw;
    if (Math.abs(f) <= 1e-6) break;
    epw += f / (1 - axn * cosepw - ayn * sinepw);
  }
  const sinepw = Math.sin(epw), cosepw = Math.cos(epw);
  const ecose = axn * cosepw + ayn * sinepw, esine = axn * sinepw - ayn * cosepw;
  const elsq = axn * axn + ayn * ayn, pl = a * (1 - elsq), r = a * (1 - ecose);
  const rdot = XKE * Math.sqrt(a) * esine / r, rfdot = XKE * Math.sqrt(pl) / r;
  const cosu = a / r * (cosepw - axn + ayn * esine / (1 + Math.sqrt(1 - elsq)));
  const sinu = a / r * (sinepw - ayn - axn * esine / (1 + Math.sqrt(1 - elsq)));
  const u = actan(sinu, cosu), sin2u = 2 * sinu * cosu, cos2u = 2 * cosu * cosu - 1;
  const temp = 1 / pl, temp1c = CK2 * temp, temp2c = temp1c * temp;
  const rk = r + 0.5 * temp2c * x1mth2 * cos2u, uk = u - 0.25 * temp2c * x7thm1 * sin2u;
  const xnodek = xnode + 1.5 * temp2c * cosio * sin2u, xinck = incl + 1.5 * temp2c * cosio * sinio * cos2u;
  const sinuk = Math.sin(uk), cosuk = Math.cos(uk), sinik = Math.sin(xinck), cosik = Math.cos(xinck);
  const sinnok = Math.sin(xnodek), cosnok = Math.cos(xnodek);
  const xmx = -sinnok * cosik, xmy = cosnok * cosik;
  const ux = xmx * sinuk + cosnok * cosuk, uy = xmy * sinuk + sinnok * cosuk, uz = sinik * sinuk;
  const x = rk * ux * XKMPER, y = rk * uy * XKMPER, z = rk * uz * XKMPER;
  // ECI to Geo (cEci::toGeo)
  const theta = actan(y, x), gmst = toGMST(jd);
  let lon = (theta - gmst) % TWOPI;
  if (lon < 0) lon += TWOPI;
  if (lon > PI) lon -= TWOPI;
  const rxy = Math.sqrt(x * x + y * y), e2 = F * (2 - F);
  let lat = actan(z, rxy), c = 1;
  for (let i = 0; i < 4; i++) {
    const sLat = Math.sin(lat);
    c = 1 / Math.sqrt(1 - e2 * sLat * sLat);
    lat = actan(z + XKMPER * c * e2 * sLat, rxy);
  }
  const alt = rxy / Math.cos(lat) - XKMPER * c;
  return { idx: sat.idx, plane: sat.plane, satInPlane: sat.satInPlane, x, y, z, jd, gmst, lat: lat * RAD, lon: lon * RAD, alt };
}

function siteEci(latDeg, lonDeg, altKm, gmst) {
  const lat = latDeg * DEG, lon = lonDeg * DEG, theta = (gmst + lon) % TWOPI;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const c = 1 / Math.sqrt(1 - F * (2 - F) * sinLat * sinLat), sq = c * (1 - F) * (1 - F);
  const achcp = (XKMPER * c + altKm) * cosLat;
  return { x: achcp * Math.cos(theta), y: achcp * Math.sin(theta), z: (XKMPER * sq + altKm) * sinLat, lat, lon, theta, sinLat, cosLat };
}

function getElevationDeg(site, satState) {
  const dx = satState.x - site.x, dy = satState.y - site.y, dz = satState.z - site.z;
  const w = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const topZ = site.cosLat * Math.cos(site.theta) * dx + site.cosLat * Math.sin(site.theta) * dy + site.sinLat * dz;
  return Math.asin(topZ / w) * RAD;
}

// Stations (0..8 Fixed, 9..12 Mobile)
const STATIONS = [
  { id: 0, name: "Goldstone (DSN)", lat: 35.42667, lon: -116.89, alt: 0, mobile: false },
  { id: 1, name: "Madrid (DSN)", lat: 40.43139, lon: -4.24806, alt: 0, mobile: false },
  { id: 2, name: "Canberra (DSN)", lat: -35.40139, lon: 148.98167, alt: 0, mobile: false },
  { id: 3, name: "Redu (ESA)", lat: 50.0005, lon: 5.1453, alt: 0, mobile: false },
  { id: 4, name: "Maspalomas (ESA)", lat: 27.7629, lon: -15.6338, alt: 0, mobile: false },
  { id: 5, name: "Kourou (ESA)", lat: 5.2514, lon: -52.8047, alt: 0, mobile: false },
  { id: 6, name: "Malindi (ESA)", lat: -2.996, lon: 40.196, alt: 0, mobile: false },
  { id: 7, name: "Santiago (ESA)", lat: -33.151, lon: -70.668, alt: 0, mobile: false },
  { id: 8, name: "New Norcia (ESA)", lat: -31.0482, lon: 116.1915, alt: 0, mobile: false },
  { id: 9, name: "Flight FRA-JFK", speed: 250, alt: 11, start: 0.45, mobile: true, route: [[50.0333,8.5706],[40.6398,-73.7789]] },
  { id: 10, name: "Flight ICN-LAX", speed: 250, alt: 11, start: 0.5, mobile: true, route: [[37.4691,126.4505],[33.9425,-118.4081]] },
  { id: 11, name: "Ship Singapore-Suez", speed: 10.3, alt: 0, start: 0.5, mobile: true, route: [[1.20,103.80],[2.50,101.20],[5.80,97.50],[5.90,80.60],[12.00,52.00],[12.60,43.40]] },
  { id: 12, name: "Ship Busan-LongBeach", speed: 10.3, alt: 0, start: 0.3, mobile: true, route: [[35.05,129.10],[41.60,140.70],[47.50,165.00],[48.50,-170.00],[46.00,-140.00],[33.70,-118.25]] }
];

const R_EARTH = 6371000.0;
function gcDist(a, b) {
  const p1 = a[0] * DEG, l1 = a[1] * DEG, p2 = b[0] * DEG, l2 = b[1] * DEG;
  const s1 = Math.sin((p2 - p1) / 2), s2 = Math.sin((l2 - l1) / 2);
  const h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
  return 2 * R_EARTH * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function gcInterp(a, b, f) {
  const p1 = a[0] * DEG, l1 = a[1] * DEG, p2 = b[0] * DEG, l2 = b[1] * DEG;
  const s1 = Math.sin((p2 - p1) / 2), s2 = Math.sin((l2 - l1) / 2);
  const d = 2 * Math.atan2(Math.sqrt(s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2), Math.sqrt(Math.max(0, 1 - (s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2))));
  if (d < 1e-12) return { lat: a[0], lon: a[1] };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD, lon: Math.atan2(y, x) * RAD };
}
for (const st of STATIONS) {
  if (st.mobile) {
    st.cum = [0];
    for (let i = 1; i < st.route.length; i++) st.cum.push(st.cum[i - 1] + gcDist(st.route[i - 1], st.route[i]));
  }
}
function getStationPos(st, tSec) {
  if (!st.mobile) return { id: st.id, name: st.name, lat: st.lat, lon: st.lon, alt: st.alt, mobile: false };
  const L = st.cum[st.cum.length - 1], period = 2 * L;
  let d = (st.start * L + st.speed * tSec) % period;
  if (d < 0) d += period;
  if (d > L) d = period - d;
  for (let i = 1; i < st.route.length; i++) {
    if (d <= st.cum[i] || i === st.route.length - 1) {
      const seg = st.cum[i] - st.cum[i - 1];
      const pos = gcInterp(st.route[i - 1], st.route[i], seg > 0 ? (d - st.cum[i - 1]) / seg : 0);
      return { id: st.id, name: st.name, lat: pos.lat, lon: pos.lon, alt: st.alt, mobile: true, route: st.route };
    }
  }
}

if (typeof module !== "undefined") module.exports = { SATS, STATIONS, getSatState, siteEci, getElevationDeg, getStationPos };
