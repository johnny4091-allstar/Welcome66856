/* Kestrel Player — a player for your own Xtream Codes / M3U playlist.
   Plain JS, no build step. In the Android app, video plays in the native (ExoPlayer) player;
   in a desktop browser it falls back to <video> + hls.js. */
'use strict';

// ---------------------------------------------------------------- platform
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const plugin = name => (NATIVE ? window.Capacitor.registerPlugin(name) : null);
const NativePlayer = plugin('NativePlayer');
const Updater = plugin('Updater');
const AppPlugin = plugin('App');
const UPDATE_MANIFEST = 'https://github.com/johnny4091-allstar/Welcome66856/releases/latest/download/version.json';

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem('kp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('kp.' + k, JSON.stringify(v)); } catch (e) { toast('Storage is full: ' + e.message); } },
  del(k) { try { localStorage.removeItem('kp.' + k); } catch {} },
};
const DEFAULT_SETTINGS = { liveFormat: 'ts', accent: '#f59e0b', pin: '', locked: {}, autoUpdate: true, lastUpdateCheck: 0 };
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);
let playlists = store.get('playlists', []);
const savePlaylists = () => store.set('playlists', playlists);
const activePlaylist = () => playlists.find(p => p.id === store.get('active')) || playlists[0] || null;
const pkey = k => `${k}.${activePlaylist()?.id || 'none'}`;

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const itemKey = it => `${it.kind}:${it.id}`;
const fmtTime = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const clock = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function b64(s) {
  if (!s) return '';
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); } catch { return s; }
}
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
}
async function getText(url) {
  let r;
  try { r = await withTimeout(fetch(url, { cache: 'no-store' }), 45000, 'Request'); }
  catch (e) { throw new Error(NATIVE ? `Couldn't reach the server (${e.message})` : `Couldn't reach the server. In a desktop browser most IPTV servers block this; use the Android app. (${e.message})`); }
  if (!r.ok) throw new Error(`Server answered HTTP ${r.status}`);
  return r.text();
}
async function getJSON(url) {
  const t = await getText(url);
  try { return JSON.parse(t); } catch { throw new Error('The server did not return valid data'); }
}
function normServer(s) {
  s = s.trim().replace(/\/(player_api\.php|get\.php|panel_api\.php).*$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}

// ---------------------------------------------------------------- sources
class XtreamSource {
  constructor(p) { this.p = p; this.base = p.server; this.cache = new Map(); }
  api(params = {}) {
    const q = new URLSearchParams({ username: this.p.user, password: this.p.pass, ...params });
    return getJSON(`${this.base}/player_api.php?${q}`);
  }
  async login() {
    const r = await this.api();
    if (!r || !r.user_info || String(r.user_info.auth) === '0') throw new Error('Login failed: check the server, username and password');
    return r;
  }
  async cached(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn().catch(e => { this.cache.delete(key); throw e; }));
    return this.cache.get(key);
  }
  categories(kind) {
    const action = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' }[kind];
    return this.cached('cats:' + kind, async () => {
      const r = await this.api({ action });
      return (Array.isArray(r) ? r : []).map(c => ({ id: String(c.category_id), name: c.category_name || 'Untitled' }));
    });
  }
  items(kind, cat = 'all') {
    const action = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' }[kind];
    return this.cached(`items:${kind}:${cat}`, async () => {
      const r = await this.api(cat === 'all' ? { action } : { action, category_id: cat });
      const list = Array.isArray(r) ? r : [];
      if (kind === 'live') return list.map(s => ({ kind, id: String(s.stream_id), name: s.name || '', logo: s.stream_icon || '', cat: String(s.category_id ?? ''), num: s.num, archive: +s.tv_archive || 0 }));
      if (kind === 'movie') return list.map(s => ({ kind, id: String(s.stream_id), name: s.name || '', poster: s.stream_icon || '', cat: String(s.category_id ?? ''), rating: s.rating || '', ext: s.container_extension || 'mp4' }));
      return list.map(s => ({ kind, id: String(s.series_id), name: s.name || '', poster: s.cover || '', cat: String(s.category_id ?? ''), rating: s.rating || '', year: (s.releaseDate || s.release_date || '').slice(0, 4) }));
    });
  }
  streamUrl(it) {
    const { user, pass } = this.p, u = encodeURIComponent(user), pw = encodeURIComponent(pass);
    if (it.kind === 'live') return `${this.base}/live/${u}/${pw}/${it.id}.${settings.liveFormat === 'm3u8' ? 'm3u8' : 'ts'}`;
    if (it.kind === 'movie') return `${this.base}/movie/${u}/${pw}/${it.id}.${it.ext || 'mp4'}`;
    if (it.kind === 'episode') return `${this.base}/series/${u}/${pw}/${it.id}.${it.ext || 'mp4'}`;
    return '';
  }
  movieInfo(id) { return this.api({ action: 'get_vod_info', vod_id: id }); }
  async seriesInfo(id) {
    const r = await this.api({ action: 'get_series_info', series_id: id });
    const eps = r?.episodes || {};
    const seasons = {};
    for (const [s, list] of Object.entries(Array.isArray(eps) ? Object.fromEntries(eps.map((l, i) => [i + 1, l])) : eps)) {
      seasons[s] = (list || []).map(e => ({ kind: 'episode', id: String(e.id), name: e.title || `Episode ${e.episode_num}`, ep: +e.episode_num || 0,
        season: +s || 0, ext: e.container_extension || 'mp4', plot: e.info?.plot || '', duration: e.info?.duration || '' }));
    }
    return { info: r?.info || {}, seasons };
  }
  async epg(it) {
    const r = await this.api({ action: 'get_short_epg', stream_id: it.id, limit: 4 });
    return (r?.epg_listings || []).map(e => ({ title: b64(e.title), desc: b64(e.description),
      start: +e.start_timestamp || Date.parse(e.start) / 1000, end: +e.stop_timestamp || Date.parse(e.end || e.stop) / 1000 }));
  }
}

class M3uSource {
  constructor(p) { this.p = p; this.data = null; }
  async load() {
    if (this.data) return this.data;
    if (!this.loading) this.loading = getText(this.p.url).then(t => (this.data = M3uSource.parse(t))).finally(() => (this.loading = null));
    return this.loading;
  }
  static parse(text) {
    if (!/#EXTM3U|#EXTINF/i.test(text.slice(0, 2000))) throw new Error("That URL didn't return an M3U playlist");
    const out = { live: [], movie: [] }, lines = text.split(/\r?\n/);
    let meta = null, n = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const attrs = {}; line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => (attrs[k.toLowerCase()] = v));
        const comma = line.lastIndexOf(',');
        meta = { name: (comma >= 0 ? line.slice(comma + 1) : '').trim() || attrs['tvg-name'] || 'Channel', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Other' };
      } else if (!line.startsWith('#') && meta) {
        const kind = /\/(movie|series)\//i.test(line) ? 'movie' : 'live';
        const it = { kind, id: String(n++), name: meta.name, cat: meta.group, url: line };
        if (kind === 'live') { it.logo = meta.logo; it.num = out.live.length + 1; } else it.poster = meta.logo;
        out[kind].push(it); meta = null;
      }
    }
    if (!out.live.length && !out.movie.length) throw new Error('The playlist is empty');
    return out;
  }
  async categories(kind) {
    const d = await this.load(); const list = d[kind] || [];
    return [...new Set(list.map(i => i.cat))].map(c => ({ id: c, name: c }));
  }
  async items(kind, cat = 'all') {
    const d = await this.load(); const list = d[kind] || [];
    return cat === 'all' ? list : list.filter(i => i.cat === cat);
  }
  streamUrl(it) { return it.url; }
  async epg() { return []; }
}

let source = null;
function makeSource() {
  const p = activePlaylist();
  source = !p ? null : p.type === 'xtream' ? new XtreamSource(p) : new M3uSource(p);
}

// ---------------------------------------------------------------- favourites / resume / recents
const favs = () => store.get(pkey('fav'), {});
const isFav = it => !!favs()[itemKey(it)];
function toggleFav(it) {
  const f = favs(), k = itemKey(it);
  if (f[k]) delete f[k]; else f[k] = { ...it, url: undefined };
  store.set(pkey('fav'), f);
  toast(f[k] ? '★ Added to favourites' : 'Removed from favourites');
  return !!f[k];
}
const resumes = () => store.get(pkey('resume'), {});
function saveResume(it, pos, dur) {
  const r = resumes(), k = itemKey(it);
  if (pos > 30 && (!dur || pos < dur - 90)) r[k] = { pos, dur, t: Date.now(), item: { ...it, url: undefined } };
  else delete r[k];
  const keys = Object.keys(r).sort((a, b) => r[b].t - r[a].t);
  keys.slice(60).forEach(x => delete r[x]);
  store.set(pkey('resume'), r);
}
function pushRecentLive(it) {
  const list = store.get(pkey('recent'), []).filter(x => x.id !== it.id);
  list.unshift({ ...it, url: undefined });
  store.set(pkey('recent'), list.slice(0, 30));
}

// ---------------------------------------------------------------- parental lock
const unlocked = new Set();
const lockKey = (kind, cat) => `${activePlaylist()?.id}:${kind}:${cat}`;
const isLocked = (kind, cat) => !!settings.locked[lockKey(kind, cat)] && !unlocked.has(lockKey(kind, cat));
const lockedAtAll = (kind, cat) => !!settings.locked[lockKey(kind, cat)];
async function ensureUnlocked(kind, cat) {
  if (!isLocked(kind, cat)) return true;
  if (await askPin('This category is locked')) { unlocked.add(lockKey(kind, cat)); return true; }
  return false;
}
function askPin(title, { setNew = false } = {}) {
  return new Promise(resolve => {
    openModal(`<h2 style="margin-top:0">${esc(title)}</h2>
      <p class="muted">${setNew ? 'Choose a 4-digit PIN.' : 'Enter your PIN.'}</p>
      <div class="field"><input id="pinIn" class="pin-input" inputmode="numeric" type="password" maxlength="4" autocomplete="off"></div>
      <div class="btn-row"><button class="btn primary" id="pinOk">OK</button><button class="btn" id="pinCancel">Cancel</button></div>`, () => resolve(false));
    const inp = $('#pinIn'); setTimeout(() => inp.focus(), 50);
    const ok = () => {
      const v = inp.value.trim();
      if (setNew) { if (!/^\d{4}$/.test(v)) return toast('Use exactly 4 digits'); closeModal(true); return resolve(v); }
      if (v === settings.pin) { closeModal(true); resolve(true); } else { inp.value = ''; toast('Wrong PIN'); }
    };
    $('#pinOk').onclick = ok;
    inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    inp.oninput = () => { if (!setNew && inp.value.length === 4) ok(); };
    $('#pinCancel').onclick = () => { closeModal(true); resolve(false); };
  });
}

// ---------------------------------------------------------------- modal
let modalOnClose = null;
function openModal(html, onClose) {
  $('#modalBody').innerHTML = html; $('#modal').hidden = false; modalOnClose = onClose || null;
  setTimeout(() => $('#modal').querySelector('button, input, select')?.focus(), 30);
}
function closeModal(silent) {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true; $('#modalBody').innerHTML = '';
  const cb = modalOnClose; modalOnClose = null;
  if (!silent && cb) cb();
  restoreFocus();
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ---------------------------------------------------------------- player
let lastFocus = null;
function restoreFocus() { if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); }

async function play(items, index = 0, { live = false, start = 0 } = {}) {
  lastFocus = document.activeElement;
  let from = 0, list = items;
  if (items.length > 300) { from = Math.max(0, Math.min(index - 150, items.length - 300)); list = items.slice(from, from + 300); }
  const payload = list.map(x => ({ url: source.streamUrl(x), title: x.title || x.name, subtitle: x.subtitle || '' }));
  if (NATIVE) {
    try {
      const r = await NativePlayer.play({ items: payload, index: index - from, live, startPosition: start });
      return { ...r, index: (r.index || 0) + from };
    } catch (e) { toast('Player error: ' + e.message); return { position: 0, duration: 0, index }; }
  }
  return webPlay(payload, index - from, start).then(r => ({ ...r, index: r.index + from }));
}

let hls = null;
function webPlay(list, idx, start) {
  return new Promise(resolve => {
    const wrap = $('#webPlayer'), v = $('#webVideo');
    const load = i => {
      const it = list[i]; $('#webPlayerTitle').textContent = it.title;
      if (hls) { hls.destroy(); hls = null; }
      if (/\.m3u8/i.test(it.url) && window.Hls?.isSupported()) { hls = new Hls(); hls.loadSource(it.url); hls.attachMedia(v); }
      else v.src = it.url;
      v.onloadedmetadata = () => { if (start) { v.currentTime = start; start = 0; } };
      v.onerror = () => toast("This stream can't play in a desktop browser. Try the Android app, or set Live format to HLS in Settings.", 6000);
      v.play().catch(() => {});
    };
    let i = idx;
    const close = () => {
      const r = { position: v.currentTime || 0, duration: isFinite(v.duration) ? v.duration : 0, index: i, ended: v.ended };
      if (hls) { hls.destroy(); hls = null; }
      v.pause(); v.removeAttribute('src'); v.load();
      wrap.hidden = true; document.removeEventListener('keydown', keys, true); webPlayerClose = null;
      restoreFocus(); resolve(r);
    };
    const keys = e => {
      if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); close(); }
      else if (list.length > 1 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); i = (i + (e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length; load(i); }
    };
    webPlayerClose = close;
    $('#webPlayerClose').onclick = close;
    v.onended = () => { if (list.length === 1) close(); };
    document.addEventListener('keydown', keys, true);
    wrap.hidden = false; load(i);
  });
}
let webPlayerClose = null;

async function playLive(list, index) {
  if (!list.length) return;
  const r = await play(list, index, { live: true });
  const it = list[r.index] || list[index];
  if (it) pushRecentLive(it);
  if (state.view === 'live') highlightChannel(r.index);
}
async function playVod(it, opts = {}) {
  const start = opts.fromStart ? 0 : (resumes()[itemKey(it)]?.pos || 0);
  const r = await play([{ ...it, title: it.title || it.name }], 0, { start });
  saveResume(it, r.position, r.duration);
  return r;
}

// ---------------------------------------------------------------- windowed lists
let observers = [];
function windowed(container, items, renderItem, chunk = 120) {
  let i = 0;
  const sentinel = document.createElement('div'); sentinel.style.cssText = 'height:1px;grid-column:1/-1';
  const more = () => {
    const html = items.slice(i, i + chunk).map((it, k) => renderItem(it, i + k)).join('');
    sentinel.insertAdjacentHTML('beforebegin', html); i += chunk;
    if (i >= items.length) { io.disconnect(); sentinel.remove(); }
  };
  container.appendChild(sentinel);
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: '800px' });
  observers.push(io); more(); if (i < items.length) io.observe(sentinel);
}

// ---------------------------------------------------------------- router
const state = { view: 'live', liveCat: null, liveList: [], vodCat: {}, favTab: 'live', lockEdit: false, seq: 0 };
const view = () => $('#view');
function go(name) {
  observers.forEach(o => o.disconnect()); observers = [];
  state.view = name; state.lockEdit = false; state.seq++;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#main').scrollTop = 0;
  if (!activePlaylist() && name !== 'settings' && name !== 'add') return renderWelcome();
  ({ live: renderLive, movies: () => renderVod('movie'), series: () => renderVod('series'), favorites: renderFavs,
    search: renderSearch, settings: renderSettings, add: renderAddPlaylist })[name]?.();
}
document.querySelectorAll('.nav-btn').forEach(b => (b.onclick = () => go(b.dataset.view)));
const spinner = '<div class="spinner" role="status" aria-label="Loading"></div>';
const errorBox = (e, retry = true) => `<div class="empty">⚠️ ${esc(e.message || e)}${retry ? '<div class="btn-row" style="justify-content:center"><button class="btn" data-retry>Try again</button></div>' : ''}</div>`;
function bindRetry(el, fn) { el.querySelector('[data-retry]')?.addEventListener('click', fn); }

// ---------------------------------------------------------------- welcome / add playlist
function renderWelcome() {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  view().innerHTML = `<div class="welcome">
    <img class="logo" src="icons/icon.svg" alt="">
    <h1>Welcome to Kestrel Player</h1>
    <p>Kestrel plays your own IPTV playlist: an Xtream Codes login or an M3U link from your provider.
       It doesn't come with any channels or content.</p>
    <div class="btn-row"><button class="btn primary" id="wAdd">＋ Add a playlist</button></div></div>`;
  $('#wAdd').onclick = () => go('add'); $('#wAdd').focus();
}

function renderAddPlaylist(edit) {
  const p = edit || { type: 'xtream', name: '', server: '', user: '', pass: '', url: '' };
  let type = p.type;
  view().innerHTML = `<div class="settings">
    <h1>${edit ? 'Edit playlist' : 'Add a playlist'}</h1>
    <div class="seg" role="tablist"><button data-t="xtream">Xtream Codes</button><button data-t="m3u">M3U link</button></div>
    <div class="panel">
      <div class="field"><label for="fName">Name</label><input id="fName" placeholder="My TV" value="${esc(p.name)}"></div>
      <div data-for="xtream">
        <div class="field"><label for="fServer">Server URL</label><input id="fServer" inputmode="url" autocapitalize="off" placeholder="http://example.com:8080" value="${esc(p.server)}"></div>
        <div class="field"><label for="fUser">Username</label><input id="fUser" autocapitalize="off" autocomplete="off" value="${esc(p.user)}"></div>
        <div class="field"><label for="fPass">Password</label><input id="fPass" type="password" autocomplete="off" value="${esc(p.pass)}"></div>
      </div>
      <div data-for="m3u">
        <div class="field"><label for="fUrl">M3U playlist URL</label><input id="fUrl" inputmode="url" autocapitalize="off" placeholder="http://example.com/get.php?username=…&type=m3u_plus" value="${esc(p.url)}"></div>
      </div>
      <div id="fMsg"></div>
      <div class="btn-row"><button class="btn primary" id="fSave">${edit ? 'Save' : 'Add and load'}</button>
        <button class="btn" id="fCancel">Cancel</button></div>
    </div>
    <p class="muted small">Your login is stored only on this device.</p></div>`;
  const setType = t => { type = t; view().querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    view().querySelectorAll('[data-for]').forEach(d => (d.hidden = d.dataset.for !== t)); };
  view().querySelectorAll('.seg button').forEach(b => (b.onclick = () => setType(b.dataset.t)));
  setType(type);
  $('#fCancel').onclick = () => go(activePlaylist() ? 'settings' : 'live');
  $('#fSave').onclick = async () => {
    const np = { id: edit?.id || 'p' + Date.now().toString(36), type, name: $('#fName').value.trim() };
    if (type === 'xtream') {
      Object.assign(np, { server: normServer($('#fServer').value), user: $('#fUser').value.trim(), pass: $('#fPass').value });
      if (!$('#fServer').value.trim() || !np.user) return toast('Fill in the server URL and username');
      np.name ||= np.server.replace(/^https?:\/\//, '');
    } else {
      np.url = $('#fUrl').value.trim();
      if (!/^https?:\/\//i.test(np.url)) return toast('Enter a link starting with http:// or https://');
      np.name ||= 'M3U playlist';
    }
    const msg = $('#fMsg'); msg.innerHTML = spinner; $('#fSave').disabled = true;
    try {
      if (type === 'xtream') await new XtreamSource(np).login(); else await new M3uSource(np).load();
      commit();
    } catch (e) {
      msg.innerHTML = `<p style="color:#fca5a5">⚠️ ${esc(e.message)}</p><button class="btn sm" id="fAnyway">Save anyway</button>`;
      $('#fAnyway').onclick = commit; $('#fSave').disabled = false;
    }
    function commit() {
      const i = playlists.findIndex(x => x.id === np.id);
      if (i >= 0) playlists[i] = np; else playlists.push(np);
      savePlaylists(); store.set('active', np.id); makeSource(); toast('Playlist saved'); go('live');
    }
  };
  setTimeout(() => view().querySelector('input')?.focus(), 30);
}

// ---------------------------------------------------------------- live TV
async function renderLive() {
  const seq = state.seq;
  view().innerHTML = `<div class="live" id="live">
    <section class="pane cats"><div class="pane-title"><span>Categories</span><button class="btn sm" id="lockBtn" title="Lock categories">🔒</button></div><div id="catList">${spinner}</div></section>
    <section class="pane chans"><div class="pane-title"><button class="btn sm back-link" id="backCats">‹ Categories</button><span id="chanTitle">Channels</span><span id="chanCount"></span></div><div id="chanList"></div></section>
    <aside class="pane info" id="info"><div class="empty">Pick a channel</div></aside></div>`;
  $('#backCats').onclick = () => $('#live').classList.remove('show-channels');
  $('#lockBtn').onclick = toggleLockEdit;
  let cats;
  try { cats = await source.categories('live'); } catch (e) {
    if (seq !== state.seq) return; $('#catList').innerHTML = errorBox(e); bindRetry($('#catList'), renderLive); return;
  }
  if (seq !== state.seq) return;
  const special = [{ id: '__fav', name: '★ Favourites' }, { id: '__recent', name: '🕘 Recently watched' }, { id: 'all', name: 'All channels' }];
  const all = [...special, ...cats];
  $('#catList').innerHTML = all.map(c => `<button class="row cat" data-cat="${esc(c.id)}"><span class="name">${esc(c.name)}</span>${lockedAtAll('live', c.id) ? '<span class="tag">🔒</span>' : ''}</button>`).join('')
    || '<div class="empty">No categories</div>';
  $('#catList').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) selectLiveCat(b.dataset.cat, all.find(c => c.id === b.dataset.cat)?.name); };
  const first = state.liveCat && all.some(c => c.id === state.liveCat) ? state.liveCat : (cats[0]?.id || 'all');
  const isPhone = matchMedia('(max-width: 900px)').matches;
  if (!isPhone || state.liveCat) selectLiveCat(first, all.find(c => c.id === first)?.name, true);
  else $('#catList').querySelector('[data-cat]')?.focus();
}

async function toggleLockEdit() {
  if (!settings.pin) return toast('Set a PIN in Settings first');
  if (!state.lockEdit && !(await askPin('Manage locked categories'))) return;
  state.lockEdit = !state.lockEdit;
  toast(state.lockEdit ? 'Select categories to lock or unlock. Press 🔒 again when done.' : 'Done', 4000);
  document.querySelectorAll('#lockBtn, #vodLock').forEach(b => b.classList.toggle('primary', state.lockEdit));
}
function toggleCatLock(kind, cat, el) {
  const k = lockKey(kind, cat);
  if (settings.locked[k]) delete settings.locked[k]; else settings.locked[k] = true;
  saveSettings();
  if (el) { el.querySelector('.tag')?.remove(); if (settings.locked[k]) el.insertAdjacentHTML('beforeend', '<span class="tag">🔒</span>'); }
}

async function selectLiveCat(cat, name, initial) {
  if (state.lockEdit && !cat.startsWith('__') && cat !== 'all') return toggleCatLock('live', cat, $(`#catList [data-cat="${CSS.escape(cat)}"]`));
  if (!(await ensureUnlocked('live', cat))) return;
  const seq = state.seq;
  state.liveCat = cat;
  document.querySelectorAll('#catList .row').forEach(r => r.classList.toggle('on', r.dataset.cat === cat));
  $('#live').classList.add('show-channels');
  $('#chanTitle').textContent = name || '';
  const box = $('#chanList'); box.innerHTML = spinner; $('#chanCount').textContent = '';
  let list;
  try {
    if (cat === '__fav') list = Object.values(favs()).filter(i => i.kind === 'live');
    else if (cat === '__recent') list = store.get(pkey('recent'), []);
    else {
      list = await source.items('live', cat);
      if (cat === 'all') list = list.filter(i => !isLocked('live', i.cat));
    }
  } catch (e) { if (seq === state.seq) { box.innerHTML = errorBox(e); bindRetry(box, () => selectLiveCat(cat, name)); } return; }
  if (seq !== state.seq || state.liveCat !== cat) return;
  state.liveList = list;
  box.innerHTML = list.length ? '' : `<div class="empty">${cat === '__fav' ? 'No favourite channels yet. Press ★ on a channel to add it.' : 'No channels here'}</div>`;
  $('#chanCount').textContent = list.length ? list.length : '';
  windowed(box, list, (it, i) => `<button class="row ch" data-i="${i}"><span class="num">${esc(it.num ?? i + 1)}</span>
      ${it.logo ? `<img class="logo" loading="lazy" src="${esc(it.logo)}" alt="">` : '<span class="logo"></span>'}
      <span class="name">${esc(it.name)}</span>${isFav(it) ? '<span class="tag">★</span>' : ''}</button>`);
  box.onclick = e => { const b = e.target.closest('[data-i]'); if (b) playLive(state.liveList, +b.dataset.i); };
  box.onfocusin = e => { const b = e.target.closest('[data-i]'); if (b) showInfoSoon(+b.dataset.i); };
  if (list.length) showInfo(0);
  if (!initial) box.querySelector('[data-i]')?.focus();
}

function highlightChannel(i) {
  const b = $(`#chanList [data-i="${i}"]`);
  if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'nearest' }); }
}
const showInfoSoon = debounce(i => showInfo(i), 250);
async function showInfo(i) {
  const it = state.liveList[i], box = $('#info');
  if (!it || !box || getComputedStyle(box).display === 'none') return;
  box.innerHTML = `${it.logo ? `<img class="big-logo" src="${esc(it.logo)}" alt="">` : ''}
    <h2>${esc(it.name)}</h2><div class="btn-row"><button class="btn primary" id="iPlay">▶ Watch</button>
    <button class="btn" id="iFav">${isFav(it) ? '★ Favourite' : '☆ Favourite'}</button></div><div id="epg">${spinner}</div>`;
  $('#iPlay').onclick = () => playLive(state.liveList, i);
  $('#iFav').onclick = () => { const on = toggleFav(it); $('#iFav').textContent = on ? '★ Favourite' : '☆ Favourite';
    const row = $(`#chanList [data-i="${i}"]`); row?.querySelector('.tag')?.remove(); if (on) row?.insertAdjacentHTML('beforeend', '<span class="tag">★</span>'); };
  let epg = [];
  try { epg = await source.epg(it); } catch {}
  if (state.liveList[i] !== it || !$('#epg')) return;
  const now = Date.now() / 1000;
  $('#epg').innerHTML = epg.length ? epg.map(e => {
    const pct = e.start <= now && now < e.end ? Math.round(100 * (now - e.start) / (e.end - e.start)) : -1;
    return `<div class="epg-item"><div class="time">${pct >= 0 ? 'NOW · ' : ''}${clock(e.start)} – ${clock(e.end)}</div>
      <div><b>${esc(e.title)}</b></div>${pct >= 0 ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      ${e.desc && pct >= 0 ? `<div class="muted small" style="margin-top:6px">${esc(e.desc.slice(0, 260))}</div>` : ''}</div>`;
  }).join('') : '<p class="muted small">No guide information for this channel.</p>';
}

// ---------------------------------------------------------------- movies & series
const posterCard = (it, i, extra = '') => `<button class="card" data-i="${i}">
  ${it.poster ? `<img class="poster" loading="lazy" src="${esc(it.poster)}" alt="">` : `<div class="poster noimg">${it.kind === 'series' ? '🎞️' : '🎬'}</div>`}
  <div class="meta"><div class="t">${esc(it.name)}</div><div class="s">${esc([it.year, it.rating && '★ ' + it.rating].filter(Boolean).join(' · '))}${extra}</div></div>
  ${(() => { const r = resumes()[itemKey(it)]; return r?.dur ? `<div class="bar"><i style="width:${Math.min(100, 100 * r.pos / r.dur)}%"></i></div>` : ''; })()}</button>`;

function continueRail(kind) {
  const r = Object.values(resumes()).filter(x => (kind === 'movie' ? x.item.kind === 'movie' : x.item.kind === 'episode')).sort((a, b) => b.t - a.t).slice(0, 20);
  if (!r.length) return '';
  return `<h2>Continue watching</h2><div class="rail" id="rail">${r.map((x, i) => {
    const it = x.item, label = it.kind === 'episode' ? `S${it.season} E${it.ep}` : fmtTime(x.pos);
    const card = posterCard({ ...it, name: it.seriesName || it.name, kind: it.kind === 'episode' ? 'series' : 'movie', year: '', rating: '' }, i, esc(label));
    return x.dur ? card.replace('</button>', `<div class="bar"><i style="width:${Math.min(100, 100 * x.pos / x.dur)}%"></i></div></button>`) : card;
  }).join('')}</div>`;
}

async function renderVod(kind) {
  const seq = state.seq, title = kind === 'movie' ? 'Movies' : 'Series';
  view().innerHTML = `<div class="header-row"><h1>${title}</h1></div><div id="cont">${continueRail(kind)}</div>
    <div class="chips" id="chips">${spinner}</div><div id="vodGrid" class="grid"></div>`;
  const railItems = Object.values(resumes()).filter(x => (kind === 'movie' ? x.item.kind === 'movie' : x.item.kind === 'episode')).sort((a, b) => b.t - a.t).slice(0, 20);
  $('#rail')?.addEventListener('click', e => {
    const b = e.target.closest('[data-i]'); if (!b) return; const it = railItems[+b.dataset.i].item;
    if (it.kind === 'movie') openMovie(it); else openSeries({ kind: 'series', id: it.seriesId, name: it.seriesName, poster: it.poster }, it.season);
  });
  let cats;
  try { cats = await source.categories(kind); } catch (e) {
    if (seq === state.seq) { $('#chips').innerHTML = ''; $('#vodGrid').innerHTML = errorBox(e); bindRetry($('#vodGrid'), () => renderVod(kind)); } return;
  }
  if (seq !== state.seq) return;
  if (!cats.length) { $('#chips').innerHTML = ''; $('#vodGrid').innerHTML = `<div class="empty">This playlist has no ${title.toLowerCase()}.</div>`; return; }
  $('#chips').innerHTML = cats.map(c => `<button class="chip" data-cat="${esc(c.id)}">${lockedAtAll(kind, c.id) ? '🔒 ' : ''}${esc(c.name)}</button>`).join('')
    + '<button class="chip" id="vodLock" title="Lock categories">🔒</button>';
  $('#vodLock').onclick = toggleLockEdit;
  $('#chips').onclick = e => { const b = e.target.closest('[data-cat]'); if (b) selectVodCat(kind, b.dataset.cat, b); };
  const cur = state.vodCat[kind] && cats.some(c => c.id === state.vodCat[kind]) ? state.vodCat[kind] : cats.find(c => !lockedAtAll(kind, c.id))?.id || cats[0].id;
  selectVodCat(kind, cur, $(`#chips [data-cat="${CSS.escape(cur)}"]`), true);
}

async function selectVodCat(kind, cat, chip, initial) {
  if (state.lockEdit) {
    const k = lockKey(kind, cat); if (settings.locked[k]) delete settings.locked[k]; else settings.locked[k] = true; saveSettings();
    if (chip) chip.textContent = (settings.locked[k] ? '🔒 ' : '') + chip.textContent.replace(/^🔒 /, ''); return;
  }
  if (!(await ensureUnlocked(kind, cat))) return;
  const seq = state.seq; state.vodCat[kind] = cat;
  document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('on', c.dataset.cat === cat));
  if (initial) chip?.scrollIntoView({ inline: 'center', block: 'nearest' });
  const grid = $('#vodGrid'); grid.innerHTML = spinner;
  let list;
  try { list = await source.items(kind, cat); } catch (e) { if (seq === state.seq) { grid.innerHTML = errorBox(e); bindRetry(grid, () => selectVodCat(kind, cat, chip)); } return; }
  if (seq !== state.seq || state.vodCat[kind] !== cat) return;
  grid.innerHTML = list.length ? '' : '<div class="empty">Nothing in this category</div>';
  windowed(grid, list, (it, i) => posterCard(it, i));
  grid.onclick = e => { const b = e.target.closest('[data-i]'); if (b) (kind === 'movie' ? openMovie : openSeries)(list[+b.dataset.i]); };
}

async function openMovie(it) {
  lastFocus = document.activeElement;
  openModal(spinner);
  let info = {};
  if (source.movieInfo) { try { info = (await source.movieInfo(it.id))?.info || {}; } catch {} }
  if ($('#modal').hidden) return;
  const res = resumes()[itemKey(it)];
  const facts = [info.releasedate || info.release_date, info.duration, info.genre, (info.rating || it.rating) && '★ ' + (info.rating || it.rating)].filter(Boolean).join(' · ');
  $('#modalBody').innerHTML = `<div class="details">
    ${info.movie_image || it.poster ? `<img class="poster" src="${esc(info.movie_image || it.poster)}" alt="">` : '<div class="poster noimg">🎬</div>'}
    <div><h1>${esc(info.name || it.name)}</h1><div class="facts">${esc(facts)}</div>
      <div class="plot">${esc(info.plot || info.description || '')}</div>
      ${info.cast ? `<p class="muted small">Cast: ${esc(info.cast)}</p>` : ''}${info.director ? `<p class="muted small">Director: ${esc(info.director)}</p>` : ''}
      <div class="btn-row">
        ${res ? `<button class="btn primary" id="mResume">▶ Resume ${fmtTime(res.pos)}</button><button class="btn" id="mStart">↺ From start</button>` : '<button class="btn primary" id="mPlay">▶ Play</button>'}
        <button class="btn" id="mFav">${isFav(it) ? '★ Favourite' : '☆ Favourite'}</button><button class="btn" id="mClose">Close</button></div></div></div>`;
  const doPlay = async fromStart => { closeModal(true); await playVod({ ...it, poster: it.poster || info.movie_image }, { fromStart }); if (state.view === 'movies') refreshBars(); };
  $('#mPlay') && ($('#mPlay').onclick = () => doPlay(true));
  $('#mResume') && ($('#mResume').onclick = () => doPlay(false));
  $('#mStart') && ($('#mStart').onclick = () => doPlay(true));
  $('#mFav').onclick = () => ($('#mFav').textContent = toggleFav(it) ? '★ Favourite' : '☆ Favourite');
  $('#mClose').onclick = () => closeModal();
  $('#modalBody').querySelector('.btn.primary')?.focus();
}

async function openSeries(it, season) {
  if ($('#modal').hidden) lastFocus = document.activeElement;
  openModal(spinner);
  let data;
  try { data = await source.seriesInfo(it.id); } catch (e) { $('#modalBody').innerHTML = errorBox(e, false) + '<div class="btn-row"><button class="btn" id="sClose">Close</button></div>'; $('#sClose').onclick = () => closeModal(); return; }
  if ($('#modal').hidden) return;
  const info = data.info, seasons = Object.keys(data.seasons).sort((a, b) => a - b);
  const poster = info.cover || it.poster;
  let cur = season != null && data.seasons[season] ? String(season) : seasons[0];
  const facts = [info.releaseDate || info.release_date, info.genre, info.rating && '★ ' + info.rating].filter(Boolean).join(' · ');
  $('#modalBody').innerHTML = `<div class="details">
    ${poster ? `<img class="poster" src="${esc(poster)}" alt="">` : '<div class="poster noimg">🎞️</div>'}
    <div><h1>${esc(info.name || it.name)}</h1><div class="facts">${esc(facts)}</div><div class="plot">${esc(info.plot || '')}</div>
      <div class="btn-row"><button class="btn" id="sFav">${isFav(it) ? '★ Favourite' : '☆ Favourite'}</button><button class="btn" id="sClose">Close</button></div></div></div>
    <div class="episodes">${seasons.length ? `<div class="chips" id="seasons">${seasons.map(s => `<button class="chip" data-s="${esc(s)}">Season ${esc(s)}</button>`).join('')}</div>` : '<p class="muted">No episodes found.</p>'}
    <div id="eps"></div></div>`;
  $('#sFav').onclick = () => ($('#sFav').textContent = toggleFav(it) ? '★ Favourite' : '☆ Favourite');
  $('#sClose').onclick = () => closeModal();
  const showSeason = s => {
    cur = s;
    document.querySelectorAll('#seasons .chip').forEach(c => c.classList.toggle('on', c.dataset.s === s));
    const eps = data.seasons[s] || [];
    $('#eps').innerHTML = eps.map((e, i) => { const r = resumes()[itemKey(e)];
      return `<button class="row ep" data-e="${i}"><span class="epn">E${e.ep || i + 1}</span><span class="name">${esc(e.name)}</span>
        <span class="tag">${r ? '⏸ ' + fmtTime(r.pos) : esc(e.duration || '')}</span></button>`; }).join('');
  };
  $('#seasons')?.addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) showSeason(b.dataset.s); });
  $('#eps').onclick = async e => {
    const b = e.target.closest('[data-e]'); if (!b) return;
    let i = +b.dataset.e;
    const seriesName = info.name || it.name;
    closeModal(true);
    for (;;) {
      const list = data.seasons[cur], ep = list[i];
      const full = { ...ep, title: `${seriesName} · S${ep.season} E${ep.ep}`, subtitle: ep.name, seriesId: it.id, seriesName, poster };
      const r = await playVod(full);
      if (!r.ended || !list[i + 1]) break;
      i++; toast(`Up next: E${list[i].ep} ${list[i].name}`);
    }
    openSeries(it, cur);
  };
  if (cur) showSeason(cur);
  (document.querySelector(`#eps [data-e]`) || $('#sFav')).focus();
}

function refreshBars() {
  // Cheap refresh of resume bars after playback: re-render the current view.
  const y = $('#main').scrollTop; go(state.view); $('#main').scrollTop = y;
}

// ---------------------------------------------------------------- favourites
function renderFavs() {
  const f = Object.values(favs());
  const tabs = [['live', 'Channels'], ['movie', 'Movies'], ['series', 'Series']];
  view().innerHTML = `<h1>Favourites</h1><div class="seg">${tabs.map(([k, l]) => `<button data-t="${k}" class="${state.favTab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="favBody"></div>`;
  view().querySelectorAll('.seg button').forEach(b => (b.onclick = () => { state.favTab = b.dataset.t; renderFavs(); view().querySelector(`.seg [data-t="${b.dataset.t}"]`).focus(); }));
  const list = f.filter(i => i.kind === state.favTab), body = $('#favBody');
  if (!list.length) { body.innerHTML = '<div class="empty">Nothing here yet. Press ☆ Favourite on a channel, movie or series.</div>'; return; }
  if (state.favTab === 'live') {
    body.innerHTML = `<div class="pane">${list.map((it, i) => `<button class="row" data-i="${i}">${it.logo ? `<img class="logo" loading="lazy" src="${esc(it.logo)}" alt="">` : '<span class="logo"></span>'}<span class="name">${esc(it.name)}</span></button>`).join('')}</div>`;
    body.onclick = e => { const b = e.target.closest('[data-i]'); if (b) playLive(list, +b.dataset.i); };
  } else {
    body.innerHTML = `<div class="grid">${list.map((it, i) => posterCard(it, i)).join('')}</div>`;
    body.onclick = e => { const b = e.target.closest('[data-i]'); if (b) (state.favTab === 'movie' ? openMovie : openSeries)(list[+b.dataset.i]); };
  }
}

// ---------------------------------------------------------------- search
let searchData = null;
function renderSearch() {
  view().innerHTML = `<h1>Search</h1><div class="field"><input id="q" type="search" placeholder="Channels, movies, series…" autocomplete="off"></div><div id="sRes"></div>`;
  const q = $('#q'), out = $('#sRes'); q.focus();
  const run = debounce(async () => {
    const term = q.value.trim().toLowerCase();
    if (term.length < 2) { out.innerHTML = '<p class="muted">Type at least 2 letters.</p>'; return; }
    if (!searchData) {
      out.innerHTML = spinner + '<p class="muted" style="text-align:center">Loading the whole playlist the first time…</p>';
      try {
        const [live, movie, series] = await Promise.all(['live', 'movie', 'series'].map(k => source.items(k, 'all').catch(() => [])));
        searchData = { live, movie, series };
      } catch (e) { out.innerHTML = errorBox(e, false); return; }
    }
    if (q.value.trim().toLowerCase() !== term || state.view !== 'search') return;
    const match = (k, max) => searchData[k].filter(i => i.name.toLowerCase().includes(term) && !isLocked(k, i.cat)).slice(0, max);
    const L = match('live', 60), M = match('movie', 60), S = match('series', 60);
    out.innerHTML = (!L.length && !M.length && !S.length) ? '<div class="empty">No results</div>' :
      (L.length ? `<h2>Channels</h2><div class="pane" id="sL">${L.map((it, i) => `<button class="row" data-i="${i}">${it.logo ? `<img class="logo" loading="lazy" src="${esc(it.logo)}" alt="">` : '<span class="logo"></span>'}<span class="name">${esc(it.name)}</span></button>`).join('')}</div>` : '')
      + (M.length ? `<h2>Movies</h2><div class="grid" id="sM">${M.map((it, i) => posterCard(it, i)).join('')}</div>` : '')
      + (S.length ? `<h2>Series</h2><div class="grid" id="sS">${S.map((it, i) => posterCard(it, i)).join('')}</div>` : '');
    $('#sL')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) playLive(L, +b.dataset.i); });
    $('#sM')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) openMovie(M[+b.dataset.i]); });
    $('#sS')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) openSeries(S[+b.dataset.i]); });
  }, 350);
  q.oninput = run;
  q.onkeydown = e => { if (e.key === 'Enter') { run(); q.blur(); } };
}

// ---------------------------------------------------------------- settings
const ACCENTS = ['#f59e0b', '#38bdf8', '#22c55e', '#f43f5e', '#a78bfa', '#f97316', '#14b8a6', '#eab308'];
function applyAccent() {
  document.documentElement.style.setProperty('--accent', settings.accent);
  const c = settings.accent.replace('#', ''), [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
  document.documentElement.style.setProperty('--accent-ink', (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#14100a' : '#ffffff');
}

async function renderSettings() {
  const act = activePlaylist();
  view().innerHTML = `<div class="settings"><h1>Settings</h1>
    <h2>Playlists</h2><div class="panel">
      ${playlists.map(p => `<div class="list-item"><div class="grow"><b>${esc(p.name)}</b>${p.id === act?.id ? ' <span class="muted small">· in use</span>' : ''}
        <div class="muted small">${p.type === 'xtream' ? 'Xtream Codes · ' + esc(p.server) : 'M3U link'}</div></div>
        ${p.id !== act?.id ? `<button class="btn sm" data-use="${p.id}">Use</button>` : ''}
        <button class="btn sm" data-edit="${p.id}">Edit</button><button class="btn sm danger" data-del="${p.id}">Remove</button></div>`).join('') || '<p class="muted">No playlists yet.</p>'}
      <div class="btn-row"><button class="btn primary" id="addPl">＋ Add playlist</button>${act ? '<button class="btn" id="reloadPl">⟳ Reload playlist</button>' : ''}</div>
      <div id="acct" class="muted small" style="margin-top:12px"></div></div>

    <h2>Playback</h2><div class="panel">
      <div class="list-item"><div class="grow"><b>Live TV stream format</b><div class="muted small">Try HLS if some channels won't play (Xtream only).</div></div>
        <div class="seg" style="margin:0"><button data-fmt="ts" class="${settings.liveFormat === 'ts' ? 'on' : ''}">MPEG-TS</button><button data-fmt="m3u8" class="${settings.liveFormat === 'm3u8' ? 'on' : ''}">HLS</button></div></div></div>

    <h2>Parental lock</h2><div class="panel">
      <div class="list-item"><div class="grow"><b>PIN</b><div class="muted small">${settings.pin ? 'PIN is set. Lock categories with the 🔒 button in Live TV, Movies or Series.' : 'Set a PIN to lock categories.'}</div></div>
        <button class="btn sm" id="pinSet">${settings.pin ? 'Change PIN' : 'Set PIN'}</button>${settings.pin ? '<button class="btn sm danger" id="pinDel">Remove</button>' : ''}</div></div>

    <h2>Appearance</h2><div class="panel"><div class="swatches">${ACCENTS.map(c => `<button class="swatch ${c === settings.accent ? 'on' : ''}" data-acc="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div></div>

    <h2>Updates</h2><div class="panel">
      <div class="list-item"><div class="grow"><b>Version <span id="ver">${NATIVE ? '…' : 'web preview'}</span></b><div class="muted small">New versions come from the project's GitHub releases.</div></div>
        <button class="btn sm" id="chkUpd">Check now</button></div>
      <div class="list-item"><div class="grow">Check automatically when the app opens</div><button class="btn sm" id="autoUpd">${settings.autoUpdate ? 'On' : 'Off'}</button></div></div>

    <p class="muted small" style="margin-top:24px">Kestrel Player is a player only. It doesn't provide, host or sell any channels or content; use playlists you're entitled to.</p></div>`;

  const v = view();
  v.querySelectorAll('[data-use]').forEach(b => (b.onclick = () => { store.set('active', b.dataset.use); makeSource(); searchData = null; state.liveCat = null; state.vodCat = {}; toast('Switched playlist'); go('live'); }));
  v.querySelectorAll('[data-edit]').forEach(b => (b.onclick = () => renderAddPlaylist(playlists.find(p => p.id === b.dataset.edit))));
  v.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => {
    const p = playlists.find(x => x.id === b.dataset.del);
    openModal(`<h2 style="margin-top:0">Remove “${esc(p.name)}”?</h2><p class="muted">Its favourites and watch history on this device are removed too.</p>
      <div class="btn-row"><button class="btn danger" id="yes">Remove</button><button class="btn" id="no">Cancel</button></div>`);
    $('#no').onclick = () => closeModal();
    $('#yes').onclick = () => {
      playlists = playlists.filter(x => x.id !== p.id); savePlaylists();
      ['fav', 'resume', 'recent'].forEach(k => store.del(`${k}.${p.id}`));
      if (store.get('active') === p.id) store.set('active', playlists[0]?.id || null);
      makeSource(); searchData = null; state.liveCat = null; closeModal(true); renderSettings();
    };
  }));
  $('#addPl').onclick = () => renderAddPlaylist();
  $('#reloadPl') && ($('#reloadPl').onclick = () => { makeSource(); searchData = null; toast('Playlist will reload'); go('live'); });
  v.querySelectorAll('[data-fmt]').forEach(b => (b.onclick = () => { settings.liveFormat = b.dataset.fmt; saveSettings(); v.querySelectorAll('[data-fmt]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#pinSet').onclick = async () => {
    if (settings.pin && !(await askPin('Enter your current PIN'))) return;
    const n = await askPin('New PIN', { setNew: true }); if (!n) return;
    settings.pin = n; saveSettings(); toast('PIN saved'); renderSettings();
  };
  $('#pinDel') && ($('#pinDel').onclick = async () => {
    if (!(await askPin('Enter your PIN to remove it'))) return;
    settings.pin = ''; settings.locked = {}; saveSettings(); toast('PIN and locks removed'); renderSettings();
  });
  v.querySelectorAll('[data-acc]').forEach(b => (b.onclick = () => { settings.accent = b.dataset.acc; saveSettings(); applyAccent();
    v.querySelectorAll('[data-acc]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#chkUpd').onclick = () => checkForUpdate(true);
  $('#autoUpd').onclick = () => { settings.autoUpdate = !settings.autoUpdate; saveSettings(); $('#autoUpd').textContent = settings.autoUpdate ? 'On' : 'Off'; };
  if (NATIVE) Updater.getInfo().then(i => $('#ver') && ($('#ver').textContent = i.versionName)).catch(() => {});
  if (act?.type === 'xtream' && source?.login) {
    try {
      const u = (await source.cached('login', () => source.login())).user_info;
      const exp = u.exp_date ? new Date(u.exp_date * 1000).toLocaleDateString() : 'never';
      if ($('#acct')) $('#acct').textContent = `Account: ${u.status || 'active'} · expires ${exp} · connections ${u.active_cons ?? '?'}/${u.max_connections ?? '?'}`;
    } catch (e) { if ($('#acct')) $('#acct').textContent = 'Account info unavailable: ' + e.message; }
  }
}

// ---------------------------------------------------------------- updates
async function checkForUpdate(manual) {
  if (!NATIVE) { if (manual) toast('Updates apply to the Android app'); return; }
  let info, m;
  try {
    info = await Updater.getInfo();
    m = await getJSON(UPDATE_MANIFEST);
  } catch (e) { if (manual) toast("Couldn't check for updates: " + e.message, 5000); return; }
  settings.lastUpdateCheck = Date.now(); saveSettings();
  if (!(m && +m.versionCode > +info.versionCode)) { if (manual) toast(`You have the latest version (${info.versionName})`); return; }
  const bar = $('#updateBar');
  bar.innerHTML = `<div class="grow"><b>Update available: ${esc(m.versionName)}</b><div class="small">${esc(m.notes || '')}</div><div class="small" id="updProg"></div></div>
    <button class="btn primary sm" id="updGo">Update now</button><button class="btn sm" id="updLater">Later</button>`;
  bar.hidden = false;
  $('#updLater').onclick = () => (bar.hidden = true);
  $('#updGo').onclick = async () => {
    const prog = $('#updProg'), btn = $('#updGo'); btn.disabled = true; prog.textContent = 'Downloading…';
    const sub = await Updater.addListener('progress', p => (prog.textContent = p.percent >= 0 ? `Downloading… ${p.percent}%` : `Downloading… ${(p.bytes / 1e6).toFixed(1)} MB`));
    try { await Updater.downloadAndInstall({ url: m.url, sha256: m.sha256 }); prog.textContent = 'Follow Android\'s prompt to install.'; }
    catch (e) {
      if (e.code === 'NEED_PERMISSION') {
        prog.innerHTML = 'Android needs your OK to let Kestrel install updates. <button class="btn sm" id="updPerm">Open setting</button> then press Update now again.';
        $('#updPerm').onclick = () => Updater.openInstallPermission();
      } else prog.textContent = '⚠️ ' + e.message;
    } finally { btn.disabled = false; sub.remove(); }
  };
  if (manual) $('#updGo').focus();
}

// ---------------------------------------------------------------- TV remote: spatial navigation & back
function focusables(scope) {
  return [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), select, [tabindex="0"]')]
    .filter(el => { if (el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
}
document.addEventListener('keydown', e => {
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
  if (!dir) return;
  document.body.classList.add('kb');
  const a = document.activeElement;
  if (a?.tagName === 'INPUT' && (dir === 'left' || dir === 'right') && a.value) return;
  const scope = !$('#modal').hidden ? $('#modal') : document;
  const els = focusables(scope);
  e.preventDefault();
  if (!a || a === document.body || !scope.contains(a)) { els[0]?.focus(); return; }
  const r = a.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of els) {
    if (el === a) continue;
    const q = el.getBoundingClientRect(), qx = q.left + q.width / 2, qy = q.top + q.height / 2;
    let main, cross;
    if (dir === 'down') { if (q.top < r.bottom - 4) continue; main = q.top - r.bottom; cross = Math.abs(qx - cx); }
    else if (dir === 'up') { if (q.bottom > r.top + 4) continue; main = r.top - q.bottom; cross = Math.abs(qx - cx); }
    else if (dir === 'right') { if (q.left < r.right - 4) continue; main = q.left - r.right; cross = Math.abs(qy - cy); }
    else { if (q.right > r.left + 4) continue; main = r.left - q.right; cross = Math.abs(qy - cy); }
    const score = Math.max(0, main) + cross * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
});
document.addEventListener('pointerdown', () => document.body.classList.remove('kb'));

function goBack() {
  if (webPlayerClose) return webPlayerClose(), true;
  if (!$('#modal').hidden) return closeModal(), true;
  const live = $('#live');
  if (live?.classList.contains('show-channels') && matchMedia('(max-width: 900px)').matches) { live.classList.remove('show-channels'); return true; }
  if (document.activeElement && !document.activeElement.closest('#sidebar') && document.body.classList.contains('kb')) {
    $(`.nav-btn[data-view="${state.view}"]`)?.focus(); return true;   // TV: Back jumps to the menu first
  }
  if (state.view !== 'live' && activePlaylist()) { go('live'); return true; }
  return false;
}
if (AppPlugin) AppPlugin.addListener('backButton', () => { if (!goBack()) AppPlugin.exitApp(); });
document.addEventListener('keydown', e => {
  if ((e.key === 'Escape' || (e.key === 'Backspace' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName))) && !webPlayerClose) { e.preventDefault(); goBack(); }
});

// ---------------------------------------------------------------- start
document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
applyAccent();
makeSource();
go('live');
if (settings.autoUpdate && Date.now() - settings.lastUpdateCheck > 6 * 3600e3) setTimeout(() => checkForUpdate(false), 2500);
