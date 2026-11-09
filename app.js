/* TripLedger — automatic mileage tracker & IRS-style logbook. All data stays in localStorage. */
'use strict';

const CATEGORIES = ['Business', 'Personal', 'Medical', 'Charity'];
const STORE_KEY = 'tripledger:v1';
const MPS_PER_MPH = 0.44704;
const PLACE_RADIUS_M = 150;
const MAX_ACCURACY_M = 50;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- State ---------- */
const defaultState = () => ({
  settings: {
    // IRS standard mileage rates for 2026 (business 72.5¢, medical 20.5¢, charity 14¢). Editable in Settings.
    rates: { Business: 0.725, Personal: 0, Medical: 0.205, Charity: 0.14 },
    autoTrack: false, autoSpeedMph: 15, stopMinutes: 5, holiday: false,
    workHours: { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' },
    reminder: 'off', lastReminder: '', driver: '', defaultVehicleId: null,
  },
  vehicles: [],
  places: [],
  trips: [],
  active: null,
});

let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) { const d = defaultState(); return { ...d, ...s, settings: { ...d.settings, ...s.settings, rates: { ...d.settings.rates, ...s.settings?.rates }, workHours: { ...d.settings.workHours, ...s.settings?.workHours } } }; }
  } catch { /* fall through */ }
  const s = defaultState();
  const v = { id: uid(), name: 'My car', plate: '', odometer: 0 };
  s.vehicles.push(v); s.settings.defaultVehicleId = v.id;
  return s;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save: storage is full or blocked.'); }
}

/* ---------- Helpers ---------- */
function haversineM(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const mToMi = m => m / 1609.344;
const fmtMi = mi => (Math.round(mi * 10) / 10).toFixed(1);
const money = n => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const vehicleName = id => state.vehicles.find(v => v.id === id)?.name || '—';
const rateFor = cat => state.settings.rates[cat] ?? 0;

function placeLabel(coord) {
  if (!coord) return 'Unknown location';
  let best = null, bestD = Infinity;
  for (const p of state.places) {
    const d = haversineM(coord, [p.lat, p.lng]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= PLACE_RADIUS_M ? best.name : `${coord[0].toFixed(5)}, ${coord[1].toFixed(5)}`;
}

function autoCategory(startMs) {
  const wh = state.settings.workHours;
  if (!wh.enabled) return 'Unclassified';
  const d = new Date(startMs), t = hhmm(d);
  return wh.days.includes(d.getDay()) && t >= wh.start && t < wh.end ? 'Business' : 'Personal';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- GPS tracking engine ---------- */
const tracker = { watchId: null, last: null, fastCount: 0, wakeLock: null, timer: null };

function needWatch() { return !!state.active || (state.settings.autoTrack && !state.settings.holiday); }

function syncWatch() {
  if (!('geolocation' in navigator)) { $('#trackHint').textContent = 'GPS is not available in this browser.'; return; }
  if (needWatch() && tracker.watchId == null) {
    tracker.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    requestWakeLock();
  } else if (!needWatch() && tracker.watchId != null) {
    navigator.geolocation.clearWatch(tracker.watchId);
    tracker.watchId = null; tracker.last = null; tracker.fastCount = 0;
    tracker.wakeLock?.release?.(); tracker.wakeLock = null;
  }
  renderStatus();
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) tracker.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tracker.watchId != null) requestWakeLock(); });

function onGeoError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    toast('Location permission denied. Enable it in your browser settings to track trips.');
    state.settings.autoTrack = false; $('#autoTrack').checked = false; save();
    if (state.active && !state.active.path.length) { state.active = null; save(); }
    syncWatch(); renderTrack();
  }
}

function onPosition(pos) {
  const { latitude, longitude, accuracy, speed } = pos.coords;
  if (accuracy > MAX_ACCURACY_M) return;
  const pt = [latitude, longitude], now = pos.timestamp || Date.now();
  let v = speed;
  if ((v == null || Number.isNaN(v)) && tracker.last) {
    const dt = (now - tracker.last.t) / 1000;
    v = dt > 0 ? haversineM(tracker.last.pt, pt) / dt : 0;
  }
  v = v || 0;
  tracker.last = { pt, t: now, v };
  $('#liveSpeed').textContent = Math.round(v / MPS_PER_MPH);

  const a = state.active;
  if (a) {
    if (!a.path.length) { a.path.push(pt); a.startCoord = pt; a.lastMoving = now; }
    const prev = a.path[a.path.length - 1];
    const d = haversineM(prev, pt);
    if (d > Math.max(accuracy, 15)) { a.path.push(pt); a.meters += d; }
    if (v > 2) a.lastMoving = now;
    if (a.auto && now - a.lastMoving > state.settings.stopMinutes * 60000) {
      finishTrip();
      return;
    }
    save(); renderLive();
  } else if (state.settings.autoTrack && !state.settings.holiday) {
    tracker.fastCount = v >= state.settings.autoSpeedMph * MPS_PER_MPH ? tracker.fastCount + 1 : 0;
    if (tracker.fastCount >= 2) { startTrip(true, pt); toast('Driving detected — trip started automatically.'); }
  }
}

function startTrip(auto = false, pt = null) {
  const now = Date.now();
  state.active = { id: uid(), start: now, auto, meters: 0, path: pt ? [pt] : [], startCoord: pt, lastMoving: now, vehicleId: state.settings.defaultVehicleId };
  tracker.fastCount = 0;
  save(); syncWatch(); renderTrack();
  clearInterval(tracker.timer); tracker.timer = setInterval(renderLive, 1000);
}

function finishTrip() {
  const a = state.active; if (!a) return;
  state.active = null;
  clearInterval(tracker.timer);
  const miles = mToMi(a.meters);
  if (miles < 0.1) { save(); syncWatch(); renderAll(); toast('Trip under 0.1 mi — discarded.'); return; }
  const endCoord = a.path[a.path.length - 1] || null;
  const end = a.auto ? a.lastMoving : Date.now();
  const v = state.vehicles.find(x => x.id === a.vehicleId);
  const odoStart = v && v.odometer ? v.odometer : null;
  const trip = {
    id: a.id, start: a.start, end, from: placeLabel(a.startCoord), to: placeLabel(endCoord),
    startCoord: a.startCoord, endCoord, path: simplifyPath(a.path), miles: +miles.toFixed(2),
    odoStart, odoEnd: odoStart != null ? +(odoStart + miles).toFixed(1) : null,
    category: autoCategory(a.start), vehicleId: a.vehicleId, purpose: '', workplace: '', tags: [], notes: '', source: a.auto ? 'auto' : 'gps',
  };
  if (v && odoStart != null) v.odometer = trip.odoEnd;
  state.trips.push(trip);
  save(); syncWatch(); renderAll();
  toast(`Trip saved: ${fmtMi(miles)} mi`);
}

// Keep at most ~300 points per trip so storage stays small.
function simplifyPath(path) {
  if (path.length <= 300) return path;
  const step = path.length / 300, out = [];
  for (let i = 0; i < path.length; i += step) out.push(path[Math.floor(i)]);
  out.push(path[path.length - 1]);
  return out;
}

/* ---------- Rendering ---------- */
function renderStatus() {
  const p = $('#statusPill');
  if (state.active) { p.textContent = state.active.auto ? '● Auto trip' : '● Recording'; p.classList.add('on'); }
  else if (state.settings.holiday) { p.textContent = 'Holiday mode'; p.classList.remove('on'); }
  else if (state.settings.autoTrack) { p.textContent = 'Auto-track on'; p.classList.remove('on'); }
  else { p.textContent = 'Idle'; p.classList.remove('on'); }
}

function renderLive() {
  const a = state.active;
  const secs = a ? Math.floor((Date.now() - a.start) / 1000) : 0;
  $('#liveMiles').textContent = fmtMi(a ? mToMi(a.meters) : 0);
  $('#liveTime').textContent = `${Math.floor(secs / 3600) ? Math.floor(secs / 3600) + ':' + pad(Math.floor(secs / 60) % 60) : Math.floor(secs / 60)}:${pad(secs % 60)}`;
}

function renderTrack() {
  const btn = $('#btnStartStop');
  btn.textContent = state.active ? 'STOP TRIP' : 'START TRIP';
  btn.classList.toggle('stop', !!state.active);
  $('#autoTrack').checked = state.settings.autoTrack;
  $('#autoSpeedLabel').textContent = state.settings.autoSpeedMph;
  if (!state.active) $('#liveSpeed').textContent = '0';
  renderLive(); renderStatus();

  const now = new Date();
  const monthTrips = state.trips.filter(t => { const d = new Date(t.start); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
  const yearBiz = state.trips.filter(t => new Date(t.start).getFullYear() === now.getFullYear() && t.category === 'Business');
  const sumMi = ts => ts.reduce((s, t) => s + t.miles, 0);
  const sumVal = ts => ts.reduce((s, t) => s + t.miles * rateFor(t.category), 0);
  $('#statMonthMiles').textContent = `${fmtMi(sumMi(monthTrips))} mi`;
  $('#statMonthValue').textContent = money(sumVal(monthTrips));
  $('#statYearMiles').textContent = `${fmtMi(sumMi(yearBiz))} mi`;
  $('#statYearValue').textContent = money(sumVal(yearBiz));

  const unc = state.trips.filter(t => t.category === 'Unclassified').sort((a, b) => b.start - a.start);
  $('#unclassifiedList').innerHTML = unc.length ? unc.slice(0, 10).map(t => tripRow(t, { quick: true })).join('') : '<div class="empty">All caught up ✓</div>';
}

function tripRow(t, { quick = false, select = false } = {}) {
  return `<div class="trip" data-id="${t.id}" data-cat="${esc(t.category)}">
    ${select ? `<input type="checkbox" class="sel" data-id="${t.id}" ${selected.has(t.id) ? 'checked' : ''}>` : '<span></span>'}
    <div style="min-width:0">
      <div class="where">${esc(t.from)} → ${esc(t.to)}</div>
      <div class="meta">${fmtDate(t.start)} · ${fmtTime(t.start)} · ${esc(t.category)} · ${esc(vehicleName(t.vehicleId))}${t.tags?.length ? ' · #' + t.tags.map(esc).join(' #') : ''}</div>
      ${quick ? `<div class="quick">${CATEGORIES.map(c => `<button data-quick="${c}" data-id="${t.id}">${c}</button>`).join('')}</div>` : ''}
    </div>
    <div class="mi">${fmtMi(t.miles)} mi<small>${money(t.miles * rateFor(t.category))}</small></div>
  </div>`;
}

function periodRange(p) {
  const n = new Date();
  if (p === 'month') return [new Date(n.getFullYear(), n.getMonth(), 1), new Date(n.getFullYear(), n.getMonth() + 1, 1)];
  if (p === 'lastmonth') return [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 1)];
  if (p === 'year') return [new Date(n.getFullYear(), 0, 1), new Date(n.getFullYear() + 1, 0, 1)];
  return [new Date(0), new Date(8.64e15)];
}

const selected = new Set();
function renderTrips() {
  const q = $('#fSearch').value.trim().toLowerCase();
  const cat = $('#fCategory').value, veh = $('#fVehicle').value;
  const [from, to] = periodRange($('#fPeriod').value);
  const list = state.trips.filter(t =>
    t.start >= +from && t.start < +to && (!cat || t.category === cat) && (!veh || t.vehicleId === veh) &&
    (!q || [t.from, t.to, t.notes, t.purpose, t.workplace, ...(t.tags || [])].join(' ').toLowerCase().includes(q))
  ).sort((a, b) => b.start - a.start);
  const total = list.reduce((s, t) => s + t.miles, 0);
  $('#tripList').innerHTML = list.length
    ? `<div class="meta" style="color:var(--muted)">${list.length} trips · ${fmtMi(total)} mi</div>` + list.map(t => tripRow(t, { select: true })).join('')
    : '<div class="empty">No trips match these filters.</div>';
  for (const id of [...selected]) if (!state.trips.some(t => t.id === id)) selected.delete(id);
  $('#bulkbar').hidden = selected.size === 0;
  $('#bulkCount').textContent = `${selected.size} selected`;
}

function fillSelects() {
  const catOpts = c => `<option value="${c}">${c}</option>`;
  $('#fCategory').innerHTML = '<option value="">All categories</option>' + ['Unclassified', ...CATEGORIES].map(catOpts).join('');
  $('#bulkCategory').innerHTML = '<option value="">Set category…</option>' + CATEGORIES.map(catOpts).join('');
  const vehOpts = state.vehicles.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  const keep = (sel, html) => { const el = $(sel), v = el.value; el.innerHTML = html; el.value = v; if (el.selectedIndex < 0) el.selectedIndex = 0; };
  keep('#fVehicle', '<option value="">All vehicles</option>' + vehOpts);
  keep('#rVehicle', '<option value="">All vehicles</option>' + vehOpts);
  $('#placeNames').innerHTML = state.places.map(p => `<option value="${esc(p.name)}">`).join('');
}

function renderSettings() {
  const s = state.settings;
  $('#vehicleList').innerHTML = state.vehicles.map(v => `
    <div class="list-item">
      <div><b>${esc(v.name)}</b>${v.id === s.defaultVehicleId ? ' <small>(default)</small>' : ''}<br>
      <small>${esc(v.plate || 'No plate')} · Odometer ${v.odometer ? fmtMi(v.odometer) : '—'}</small></div>
      <div class="btn-row" style="margin:0">
        ${v.id !== s.defaultVehicleId ? `<button class="btn small" data-vdefault="${v.id}">Default</button>` : ''}
        <button class="btn small" data-vedit="${v.id}">Edit</button>
        ${state.vehicles.length > 1 ? `<button class="btn small danger" data-vdel="${v.id}">✕</button>` : ''}
      </div>
    </div>`).join('');
  $('#rateInputs').innerHTML = CATEGORIES.map(c => `<label>${c} ($/mi)<input type="number" step="0.001" min="0" data-rate="${c}" value="${s.rates[c]}"></label>`).join('');
  $('#whEnabled').checked = s.workHours.enabled;
  $('#whDays').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) =>
    `<label><input type="checkbox" data-day="${i}" ${s.workHours.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('');
  $('#whStart').value = s.workHours.start; $('#whEnd').value = s.workHours.end;
  $('#autoSpeed').value = s.autoSpeedMph; $('#stopMinutes').value = s.stopMinutes;
  $('#holidayMode').checked = s.holiday; $('#reminder').value = s.reminder;
  $('#placeList').innerHTML = state.places.length ? state.places.map(p => `
    <div class="list-item"><div><b>${esc(p.name)}</b><br><small>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</small></div>
    <button class="btn small danger" data-pdel="${p.id}">✕</button></div>`).join('') : '<div class="empty">No saved places yet.</div>';
}

function renderReportForm() {
  if (!$('#rFrom').value) {
    const [a, b] = periodRange('lastmonth');
    $('#rFrom').value = isoDate(a); $('#rTo').value = isoDate(new Date(+b - 86400000));
  }
  $('#rDriver').value = state.settings.driver;
  if (!$('#rCategories').children.length) {
    $('#rCategories').innerHTML = CATEGORIES.map(c => `<label><input type="checkbox" value="${c}" ${c === 'Business' ? 'checked' : ''}>${c}</label>`).join('');
  }
  renderReportSummary();
}

function renderAll() { fillSelects(); renderTrack(); renderTrips(); renderSettings(); renderReportForm(); }

/* ---------- Reports ---------- */
function reportData() {
  const from = new Date($('#rFrom').value + 'T00:00'), to = new Date($('#rTo').value + 'T23:59:59.999');
  const veh = $('#rVehicle').value, wp = $('#rWorkplace').value.trim().toLowerCase();
  const cats = $$('#rCategories input:checked').map(i => i.value);
  const inPeriod = state.trips.filter(t => t.start >= +from && t.start <= +to && (!veh || t.vehicleId === veh)).sort((a, b) => a.start - b.start);
  const trips = inPeriod.filter(t => cats.includes(t.category) && (!wp || (t.workplace || '').toLowerCase().includes(wp)));
  const byCat = {};
  for (const c of [...CATEGORIES, 'Unclassified']) {
    const ts = inPeriod.filter(t => t.category === c);
    byCat[c] = { miles: ts.reduce((s, t) => s + t.miles, 0), count: ts.length };
  }
  const allMiles = inPeriod.reduce((s, t) => s + t.miles, 0);
  const total = trips.reduce((s, t) => s + t.miles, 0);
  const amount = trips.reduce((s, t) => s + t.miles * rateFor(t.category), 0);
  return { from, to, veh, cats, trips, byCat, allMiles, total, amount, unclassified: byCat.Unclassified.count };
}

function renderReportSummary() {
  if (!$('#rFrom').value || !$('#rTo').value) return;
  const r = reportData();
  const pct = c => r.allMiles ? (r.byCat[c].miles / r.allMiles * 100).toFixed(1) + '%' : '—';
  $('#reportSummary').innerHTML = `
    <h2>Summary</h2>
    <table class="summary">
      <tr><th>Category</th><th>Trips</th><th>Miles</th><th>Share</th></tr>
      ${[...CATEGORIES, 'Unclassified'].map(c => `<tr><td>${c}</td><td>${r.byCat[c].count}</td><td>${fmtMi(r.byCat[c].miles)}</td><td>${pct(c)}</td></tr>`).join('')}
      <tr><th>All driving</th><th></th><th>${fmtMi(r.allMiles)}</th><th>100%</th></tr>
    </table>
    <p><b>In report:</b> ${r.trips.length} trips · ${fmtMi(r.total)} mi · <b>${money(r.amount)}</b></p>
    ${r.unclassified ? `<p class="hint">⚠️ ${r.unclassified} unclassified trip(s) in this period — categorize them before reporting.</p>` : ''}
    <p class="hint">The share column is the business-use percentage you need for the actual-expenses method.</p>`;
}

function reportFilename(ext) { return `mileage-log_${$('#rFrom').value}_to_${$('#rTo').value}.${ext}`; }

function buildCsv() {
  const r = reportData();
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Start time', 'End time', 'Vehicle', 'From', 'To', 'Business purpose', 'Workplace/client', 'Category', 'Odometer start', 'Odometer end', 'Miles', 'Rate', 'Amount', 'Tags', 'Notes']];
  for (const t of r.trips) rows.push([
    isoDate(new Date(t.start)), fmtTime(t.start), t.end ? fmtTime(t.end) : '', vehicleName(t.vehicleId), t.from, t.to, t.purpose, t.workplace,
    t.category, t.odoStart ?? '', t.odoEnd ?? '', fmtMi(t.miles), rateFor(t.category), (t.miles * rateFor(t.category)).toFixed(2), (t.tags || []).join(' '), t.notes,
  ]);
  rows.push([]);
  rows.push(['Total', '', '', '', '', '', '', '', '', '', '', fmtMi(r.total), '', r.amount.toFixed(2)]);
  rows.push(['All miles driven in period', '', '', '', '', '', '', '', '', '', '', fmtMi(r.allMiles)]);
  for (const c of CATEGORIES) rows.push([`${c} share`, '', '', '', '', '', '', '', '', '', '', fmtMi(r.byCat[c].miles), r.allMiles ? (r.byCat[c].miles / r.allMiles * 100).toFixed(1) + '%' : '']);
  return '﻿' + rows.map(row => row.map(q).join(',')).join('\r\n');
}

function printReport() {
  const r = reportData();
  state.settings.driver = $('#rDriver').value.trim(); save();
  const vName = r.veh ? vehicleName(r.veh) : 'All vehicles';
  const v = state.vehicles.find(x => x.id === r.veh);
  $('#printArea').innerHTML = `
    <h1>Mileage Log</h1>
    <p><b>Driver:</b> ${esc(state.settings.driver || '________________')} &nbsp; <b>Vehicle:</b> ${esc(vName)}${v?.plate ? ' (' + esc(v.plate) + ')' : ''}
    &nbsp; <b>Period:</b> ${fmtDate(+r.from)} – ${fmtDate(+r.to)}${$('#rWorkplace').value ? ' &nbsp; <b>Workplace:</b> ' + esc($('#rWorkplace').value) : ''}</p>
    <table>
      <thead><tr><th>Date</th><th>Time</th><th>From</th><th>To</th><th>Business purpose</th><th>Category</th><th class="num">Odo start</th><th class="num">Odo end</th><th class="num">Miles</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${r.trips.map(t => `<tr><td>${isoDate(new Date(t.start))}</td><td>${fmtTime(t.start)}${t.end ? '–' + fmtTime(t.end) : ''}</td>
        <td>${esc(t.from)}</td><td>${esc(t.to)}</td><td>${esc(t.purpose || t.notes)}</td><td>${t.category}</td>
        <td class="num">${t.odoStart ?? ''}</td><td class="num">${t.odoEnd ?? ''}</td><td class="num">${fmtMi(t.miles)}</td>
        <td class="num">$${rateFor(t.category).toFixed(3)}</td><td class="num">${money(t.miles * rateFor(t.category))}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="8">Total (${r.trips.length} trips)</th><th class="num">${fmtMi(r.total)}</th><th></th><th class="num">${money(r.amount)}</th></tr></tfoot>
    </table>
    <p><b>Total miles driven in period (all purposes):</b> ${fmtMi(r.allMiles)} mi.
    ${CATEGORIES.map(c => `${c}: ${fmtMi(r.byCat[c].miles)} mi (${r.allMiles ? (r.byCat[c].miles / r.allMiles * 100).toFixed(1) : 0}%)`).join(' · ')}</p>
    <p style="font-size:8pt">Records kept contemporaneously with the TripLedger app. Generated ${new Date().toLocaleString()}.</p>
    <div class="sig"><div>Driver signature / date</div><div>Approved by / date</div></div>`;
  window.print();
}

async function shareReport() {
  const csv = buildCsv(), name = reportFilename('csv');
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Mileage log', text: `Mileage log ${$('#rFrom').value} – ${$('#rTo').value}` }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  download(name, csv, 'text/csv'); toast('Sharing not supported here — file downloaded instead.');
}

/* ---------- Trip editor ---------- */
let editingId = null;
function openTrip(id) {
  editingId = id;
  const t = id ? state.trips.find(x => x.id === id) : null;
  const f = $('#tripForm');
  f.category.innerHTML = ['Unclassified', ...CATEGORIES].map(c => `<option>${c}</option>`).join('');
  f.vehicleId.innerHTML = state.vehicles.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  const start = new Date(t ? t.start : Date.now());
  f.date.value = isoDate(start); f.time.value = hhmm(start);
  f.from.value = t?.from || ''; f.to.value = t?.to || '';
  f.odoStart.value = t?.odoStart ?? ''; f.odoEnd.value = t?.odoEnd ?? ''; f.miles.value = t ? fmtMi(t.miles) : '';
  f.category.value = t?.category || autoCategory(+start);
  f.vehicleId.value = t?.vehicleId || state.settings.defaultVehicleId;
  f.purpose.value = t?.purpose || ''; f.workplace.value = t?.workplace || '';
  f.tags.value = (t?.tags || []).join(', '); f.notes.value = t?.notes || '';
  $('#tripDialogTitle').textContent = t ? 'Edit trip' : 'New trip';
  $('#btnTripDelete').hidden = !t; $('#btnTripSplit').hidden = !t;
  drawRoute(t?.path);
  $('#tripDialog').showModal();
}

function drawRoute(path) {
  const el = $('#routeSketch');
  if (!path || path.length < 2) { el.className = 'route'; el.innerHTML = ''; return; }
  const lats = path.map(p => p[0]), lngs = path.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = Math.max((maxLng - minLng) * kx, 1e-6), h = Math.max(maxLat - minLat, 1e-6);
  const s = Math.min(280 / w, 100 / h), ox = (300 - w * s) / 2, oy = (120 - h * s) / 2;
  const xy = p => [ox + (p[1] - minLng) * kx * s, 120 - oy - (p[0] - minLat) * s];
  const pts = path.map(p => xy(p).map(n => n.toFixed(1)).join(',')).join(' ');
  const [sx, sy] = xy(path[0]), [ex, ey] = xy(path[path.length - 1]);
  el.className = 'route has';
  el.innerHTML = `<svg viewBox="0 0 300 120" aria-label="Route sketch"><polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx}" cy="${sy}" r="5" fill="#16a34a"/><circle cx="${ex}" cy="${ey}" r="5" fill="#dc2626"/></svg>`;
}

$('#tripForm').addEventListener('input', e => {
  const f = e.currentTarget;
  if ((e.target.name === 'odoStart' || e.target.name === 'odoEnd') && f.odoStart.value && f.odoEnd.value) {
    const d = +f.odoEnd.value - +f.odoStart.value; if (d >= 0) f.miles.value = d.toFixed(1);
  }
});

$('#tripDialog').addEventListener('close', () => {
  const action = $('#tripDialog').returnValue, f = $('#tripForm');
  const t = editingId ? state.trips.find(x => x.id === editingId) : null;
  if (action === 'delete' && t) {
    if (confirm('Delete this trip?')) { state.trips = state.trips.filter(x => x !== t); save(); renderAll(); toast('Trip deleted'); }
    return;
  }
  if (action === 'split' && t) { splitTrip(t); return; }
  if (action !== 'save') return;
  const start = new Date(`${f.date.value}T${f.time.value}`).getTime();
  const data = {
    start, from: f.from.value.trim(), to: f.to.value.trim(), miles: Math.max(0, +f.miles.value || 0),
    odoStart: f.odoStart.value === '' ? null : +f.odoStart.value, odoEnd: f.odoEnd.value === '' ? null : +f.odoEnd.value,
    category: f.category.value, vehicleId: f.vehicleId.value, purpose: f.purpose.value.trim(), workplace: f.workplace.value.trim(),
    tags: f.tags.value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean), notes: f.notes.value.trim(),
  };
  if (t) Object.assign(t, data);
  else {
    state.trips.push({ id: uid(), end: null, path: [], startCoord: null, endCoord: null, source: 'manual', ...data });
    const v = state.vehicles.find(x => x.id === data.vehicleId);
    if (v && data.odoEnd != null && data.odoEnd > (v.odometer || 0)) v.odometer = data.odoEnd;
  }
  save(); renderAll(); toast('Trip saved');
});

function splitTrip(t) {
  const stop = prompt('Split this trip into two. Name of the stop in between:', '');
  if (stop == null || !stop.trim()) return;
  const frac = Math.min(0.95, Math.max(0.05, (+prompt(`Miles driven on the first leg (total ${fmtMi(t.miles)}):`, fmtMi(t.miles / 2)) || t.miles / 2) / t.miles));
  const m1 = +(t.miles * frac).toFixed(2), m2 = +(t.miles - m1).toFixed(2);
  const cut = Math.floor((t.path?.length || 0) * frac);
  const mid = t.start + ((t.end || t.start) - t.start) * frac;
  const second = { ...t, id: uid(), start: Math.round(mid), from: stop.trim(), miles: m2, path: (t.path || []).slice(cut), tags: [...(t.tags || [])],
    odoStart: t.odoStart != null ? +(t.odoStart + m1).toFixed(1) : null };
  Object.assign(t, { to: stop.trim(), miles: m1, end: Math.round(mid), path: (t.path || []).slice(0, cut + 1), odoEnd: second.odoStart });
  state.trips.push(second); save(); renderAll(); toast('Trip split in two');
}

/* ---------- Events ---------- */
function goto(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.goto === view));
  if (view === 'reports') renderReportSummary();
  window.scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]'); if (g) { goto(g.dataset.goto); return; }
  const q = e.target.closest('[data-quick]');
  if (q) { const t = state.trips.find(x => x.id === q.dataset.id); t.category = q.dataset.quick; save(); renderAll(); return; }
  if (e.target.classList.contains('sel')) {
    e.target.checked ? selected.add(e.target.dataset.id) : selected.delete(e.target.dataset.id); renderTrips(); return;
  }
  const row = e.target.closest('.trip'); if (row) { openTrip(row.dataset.id); return; }

  const vd = e.target.closest('[data-vdefault]'); if (vd) { state.settings.defaultVehicleId = vd.dataset.vdefault; save(); renderAll(); return; }
  const ve = e.target.closest('[data-vedit]'); if (ve) { editVehicle(state.vehicles.find(v => v.id === ve.dataset.vedit)); return; }
  const vx = e.target.closest('[data-vdel]');
  if (vx) {
    const v = state.vehicles.find(x => x.id === vx.dataset.vdel);
    if (state.trips.some(t => t.vehicleId === v.id)) { toast('This vehicle has trips — reassign them first.'); return; }
    if (confirm(`Remove ${v.name}?`)) {
      state.vehicles = state.vehicles.filter(x => x !== v);
      if (state.settings.defaultVehicleId === v.id) state.settings.defaultVehicleId = state.vehicles[0].id;
      save(); renderAll();
    }
    return;
  }
  const px = e.target.closest('[data-pdel]'); if (px) { state.places = state.places.filter(p => p.id !== px.dataset.pdel); save(); renderAll(); }
});

function editVehicle(v) {
  const name = prompt('Vehicle name:', v?.name || ''); if (name == null || !name.trim()) return;
  const plate = prompt('License plate (optional):', v?.plate || '') ?? '';
  const odo = prompt('Current odometer reading (miles, optional — record it at the start of each year):', v?.odometer || '');
  const data = { name: name.trim(), plate: plate.trim(), odometer: odo === '' || odo == null ? (v?.odometer || 0) : +odo || 0 };
  if (v) Object.assign(v, data); else state.vehicles.push({ id: uid(), ...data });
  save(); renderAll();
}

$('#btnStartStop').addEventListener('click', () => {
  if (state.active) finishTrip();
  else { startTrip(false); toast('Recording — getting GPS fix…'); }
});
$('#autoTrack').addEventListener('change', e => {
  state.settings.autoTrack = e.target.checked; save(); syncWatch();
  if (e.target.checked) toast(state.settings.holiday ? 'Auto-track enabled, but holiday mode is on.' : 'Auto-track on — keep the app open while driving.');
});
['#btnAddManual', '#btnAddManual2'].forEach(s => $(s).addEventListener('click', () => openTrip(null)));
['#fSearch', '#fCategory', '#fVehicle', '#fPeriod'].forEach(s => $(s).addEventListener('input', renderTrips));
$('#bulkCategory').addEventListener('change', e => {
  if (!e.target.value) return;
  state.trips.forEach(t => { if (selected.has(t.id)) t.category = e.target.value; });
  toast(`${selected.size} trips set to ${e.target.value}`);
  selected.clear(); e.target.value = ''; save(); renderAll();
});
$('#bulkDelete').addEventListener('click', () => {
  if (!confirm(`Delete ${selected.size} trips?`)) return;
  state.trips = state.trips.filter(t => !selected.has(t.id)); selected.clear(); save(); renderAll();
});

// Reports
['#rFrom', '#rTo', '#rVehicle', '#rWorkplace'].forEach(s => $(s).addEventListener('input', renderReportSummary));
$('#rCategories').addEventListener('change', renderReportSummary);
$('#rDriver').addEventListener('change', e => { state.settings.driver = e.target.value.trim(); save(); });
$('#btnReportView').addEventListener('click', printReport);
$('#btnReportCsv').addEventListener('click', () => download(reportFilename('csv'), buildCsv(), 'text/csv'));
$('#btnReportShare').addEventListener('click', shareReport);

// Settings
$('#btnAddVehicle').addEventListener('click', () => editVehicle(null));
$('#rateInputs').addEventListener('change', e => { const c = e.target.dataset.rate; if (c) { state.settings.rates[c] = Math.max(0, +e.target.value || 0); save(); renderAll(); } });
$('#whEnabled').addEventListener('change', e => { state.settings.workHours.enabled = e.target.checked; save(); });
$('#whDays').addEventListener('change', () => { state.settings.workHours.days = $$('#whDays input:checked').map(i => +i.dataset.day); save(); });
$('#whStart').addEventListener('change', e => { state.settings.workHours.start = e.target.value; save(); });
$('#whEnd').addEventListener('change', e => { state.settings.workHours.end = e.target.value; save(); });
$('#autoSpeed').addEventListener('change', e => { state.settings.autoSpeedMph = Math.min(40, Math.max(5, +e.target.value || 15)); save(); renderAll(); });
$('#stopMinutes').addEventListener('change', e => { state.settings.stopMinutes = Math.min(30, Math.max(1, +e.target.value || 5)); save(); renderAll(); });
$('#holidayMode').addEventListener('change', e => { state.settings.holiday = e.target.checked; save(); syncWatch(); toast(e.target.checked ? 'Holiday mode on — auto-tracking paused.' : 'Holiday mode off.'); });
$('#reminder').addEventListener('change', async e => {
  state.settings.reminder = e.target.value; save();
  if (e.target.value !== 'off' && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignore */ } }
});
$('#btnAddPlace').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('GPS not available.');
  toast('Getting your location…');
  navigator.geolocation.getCurrentPosition(pos => {
    const name = prompt('Name this place (e.g. Office, Client – Smith):'); if (!name?.trim()) return;
    state.places.push({ id: uid(), name: name.trim(), lat: pos.coords.latitude, lng: pos.coords.longitude });
    // Relabel existing trips that start/end here.
    for (const t of state.trips) {
      if (t.startCoord && t.from === `${t.startCoord[0].toFixed(5)}, ${t.startCoord[1].toFixed(5)}`) t.from = placeLabel(t.startCoord);
      if (t.endCoord && t.to === `${t.endCoord[0].toFixed(5)}, ${t.endCoord[1].toFixed(5)}`) t.to = placeLabel(t.endCoord);
    }
    save(); renderAll(); toast('Place saved');
  }, () => toast('Could not get your location.'), { enableHighAccuracy: true, timeout: 20000 });
});
$('#btnBackup').addEventListener('click', () => download(`tripledger-backup-${isoDate(new Date())}.json`, JSON.stringify(state, null, 1), 'application/json'));
$('#fileRestore').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.trips) || !Array.isArray(data.vehicles)) throw new Error('bad file');
    if (!confirm(`Replace current data with backup (${data.trips.length} trips)?`)) return;
    localStorage.setItem(STORE_KEY, JSON.stringify(data)); state = load(); save(); renderAll(); syncWatch(); toast('Backup restored');
  } catch { toast('That file is not a valid TripLedger backup.'); }
  e.target.value = '';
});

/* ---------- Reminders ---------- */
function checkReminder() {
  const s = state.settings; if (s.reminder === 'off') return;
  const d = new Date(), key = isoDate(d);
  const due = (s.reminder === 'weekly' && d.getDay() === 1) || (s.reminder === 'monthly' && d.getDate() === 1);
  if (!due || s.lastReminder === key) return;
  s.lastReminder = key; save();
  const msg = 'Time to review your trips and send your mileage report.';
  toast('📋 ' + msg);
  if ('Notification' in window && Notification.permission === 'granted') { try { new Notification('TripLedger', { body: msg, icon: 'icons/icon.svg' }); } catch { /* some mobile browsers need SW notifications */ } }
}

/* ---------- Boot ---------- */
renderAll();
if (state.active) { tracker.timer = setInterval(renderLive, 1000); }
syncWatch();
checkReminder(); setInterval(checkReminder, 60 * 60 * 1000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
