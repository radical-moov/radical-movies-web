// Admin API auth is now session-based (an admin cookie is sent automatically on
// same-origin requests). Access is gated server-side by requireAdmin.

const socket = io({ transports: ['polling'] });
const connDot = document.getElementById('connDot');

socket.on('connect',    () => connDot.classList.add('connected'));
socket.on('disconnect', () => connDot.classList.remove('connected'));
socket.on('connect', () => socket.emit('admin:join'));

socket.on('admin:stats', (data) => render(data));

// R2 storage map: key → { size, lastModified }
let r2Objects = new Map();
let _lastJobs    = [];
let _lastStreams  = [];

async function fetchR2Objects() {
  try {
    const list = await fetch('/api/admin/r2').then(r => r.json());
    r2Objects = new Map(list.map(o => [o.key, o]));
  } catch {}
}
fetchR2Objects();
setInterval(fetchR2Objects, 60000);

// ── Tabs ────────────────────────────────────────────────────────────────────
const tabBtns  = document.querySelectorAll('.tab-btn');
const tabPanes = {
  overview: document.getElementById('tab-overview'),
  users:    document.getElementById('tab-users'),
  jobs:     document.getElementById('tab-jobs'),
  codes:    document.getElementById('tab-codes'),
  feedback: document.getElementById('tab-feedback'),
  log:      document.getElementById('tab-log'),
};

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    Object.entries(tabPanes).forEach(([key, pane]) => {
      pane.hidden = key !== btn.dataset.tab;
    });
    if (btn.dataset.tab === 'codes') fetchCodes();
    if (btn.dataset.tab === 'users') { refreshUsersData(); loadInviteOnlySetting(); }
    if (btn.dataset.tab === 'feedback') { loadFeedback(); loadClientLogs(); loadWatchHistory(); }
  });
});

// ── Feedback ─────────────────────────────────────────────────────────────────
const FB_META = { feature: ['💡', 'Feature', 'var(--green)'], feedback: ['💬', 'Feedback', 'var(--blue)'], bug: ['🐞', 'Bug', 'var(--red)'] };
async function loadFeedback() {
  const list = document.getElementById('feedbackList');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading…</div>';
  let items = [];
  try { items = await fetch('/api/admin/feedback').then(r => r.json()); } catch { list.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  const badge = document.getElementById('feedbackBadge');
  if (badge) { badge.textContent = items.length; badge.hidden = items.length === 0; }
  if (!items.length) { list.innerHTML = '<div class="empty">No feedback yet</div>'; return; }
  list.innerHTML = '';
  for (const f of items) {
    const [icon, label, color] = FB_META[f.type] || FB_META.feedback;
    const when = f.created_at ? timeAgo(f.created_at) : '';
    const row = document.createElement('div');
    row.style.cssText = 'background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:12px 14px';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;font-weight:700;color:${color}">${icon} ${label}</span>
        <span style="font-size:11px;color:#666">${esc(f.username || 'anon')} · ${when}</span>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--red)" data-fb-del="${f.id}">✕</button>
      </div>
      <div style="font-size:13px;color:#ddd;white-space:pre-wrap;word-break:break-word">${esc(f.message || '')}</div>
      ${f.image ? `<a href="${esc(f.image)}" target="_blank" rel="noopener"><img src="${esc(f.image)}" alt="attachment" style="max-height:200px;max-width:100%;margin-top:8px;border-radius:6px;border:1px solid #333;display:block"></a>` : ''}`;
    row.querySelector('[data-fb-del]').addEventListener('click', async (e) => {
      await fetch(`/api/admin/feedback/${e.currentTarget.dataset.fbDel}`, { method: 'DELETE' }).catch(() => {});
      loadFeedback();
    });
    list.appendChild(row);
  }
}
document.getElementById('btnRefreshFeedback')?.addEventListener('click', loadFeedback);

// ── Client devices & issues ──────────────────────────────────────────────────
let _clientData   = { devices: [], errors: [] };
let _deviceFilter = null; // click a device tile to filter the issues list

async function loadClientLogs() {
  const devBox = document.getElementById('clientDevices');
  const errBox = document.getElementById('clientErrors');
  if (!devBox || !errBox) return;
  try { _clientData = await fetch('/api/admin/client-logs').then(r => r.json()); }
  catch { errBox.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  renderClientLogs();
}

function renderClientLogs() {
  const devBox = document.getElementById('clientDevices');
  const errBox = document.getElementById('clientErrors');
  if (!devBox || !errBox) return;
  const devices = _clientData.devices || [];
  const errors  = _clientData.errors  || [];
  const isTv = (d) => /TV/i.test(d || '');
  devBox.innerHTML = devices.length ? devices.map(d => {
    const tv = isTv(d.device);
    const on = _deviceFilter === d.device;
    const border = on ? 'var(--blue,#3b82f6)' : (tv ? 'rgba(255,0,153,.3)' : '#2a2a2a');
    const bg     = on ? 'rgba(59,130,246,.14)' : (tv ? 'rgba(255,0,153,.08)' : '#1a1a1a');
    return `<div data-device="${esc(d.device || '')}" title="Click to filter issues by this device" style="cursor:pointer;background:${bg};border:1px solid ${border};border-radius:8px;padding:8px 12px;min-width:150px;transition:border-color .15s,background .15s">
      <div style="font-size:12px;font-weight:700;color:${tv ? 'var(--red)' : '#ddd'}">${tv ? '📺 ' : ''}${esc(d.device || 'Unknown')}</div>
      <div style="font-size:10px;color:#666;margin-top:3px">${d.users} user${d.users !== 1 ? 's' : ''} · ${d.hits} hits · ${d.last ? timeAgo(d.last) : ''}</div>
    </div>`;
  }).join('') : '<div class="empty">No device data yet</div>';

  const shown = _deviceFilter ? errors.filter(e => e.device === _deviceFilter) : errors;
  const filterBar = _deviceFilter
    ? `<div style="font-size:10px;color:#888;margin-bottom:4px">Filtered by <strong style="color:#ddd">${esc(_deviceFilter)}</strong> · <span data-clear-devfilter style="color:var(--blue,#3b82f6);cursor:pointer">clear ✕</span></div>`
    : '';
  errBox.innerHTML = shown.length
    ? filterBar + shown.map(e => `
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:8px 10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="color:var(--red);font-size:11px;font-weight:700">${esc(e.message || '')}</span>
          <span style="font-size:10px;color:#666">${esc(e.username || 'anon')} · ${esc(e.device || '')} · ${e.ts ? timeAgo(e.ts) : ''}</span>
        </div>
        ${e.context ? `<div style="font-size:10px;color:#555;margin-top:3px;word-break:break-all">${esc(e.context)}</div>` : ''}
      </div>`).join('')
    : filterBar + `<div class="empty">${_deviceFilter ? 'No issues for this device 🎉' : 'No client errors 🎉'}</div>`;

  renderSharedIps();
}

// IPs used by 2+ accounts — flags shared devices / households / multi-accounting.
function renderSharedIps() {
  const box = document.getElementById('sharedIps');
  if (!box) return;
  const shared = _clientData.sharedIps || [];
  box.innerHTML = shared.length ? shared.map(s => {
    const users = String(s.usernames || '').split(',').filter(Boolean);
    const hot = s.users >= 3;
    return `<div style="background:#1a1a1a;border:1px solid ${hot ? 'rgba(255,0,153,.4)' : '#2a2a2a'};border-radius:6px;padding:8px 10px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="font-family:monospace;color:#ddd;font-size:11px;font-weight:700">${esc(s.ip)}</span>
        <span style="font-size:10px;font-weight:700;color:${hot ? 'var(--red)' : '#f0a020'}">${s.users} accounts</span>
        <span style="font-size:10px;color:#666">${(s.hits || 0).toLocaleString()} hits · ${s.last ? timeAgo(s.last) : ''}</span>
      </div>
      <div style="margin-top:4px">${users.map(u => `<span style="display:inline-block;background:#222;color:#bbb;border-radius:4px;padding:1px 6px;margin:2px 4px 0 0;font-size:11px">${esc(u)}</span>`).join('')}</div>
    </div>`;
  }).join('') : '<div class="empty">No IPs shared across accounts 👍</div>';
}

// ── Watch activity: what users watched, when, and for how long ────────────────
let _watchUser = null;
function fmtDur(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
async function loadWatchHistory(user = _watchUser) {
  const box = document.getElementById('watchHistory');
  if (!box) return;
  _watchUser = user || null;
  let data;
  try { data = await fetch('/api/admin/watch-history' + (_watchUser ? `?user=${encodeURIComponent(_watchUser)}` : '')).then(r => r.json()); }
  catch { box.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  _watchUser ? renderWatchUser(box, data) : renderWatchOverview(box, data);
}
function watchRow(r) {
  const pctW = r.duration ? Math.round(r.watched_seconds / r.duration * 100) : null;
  return `<div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:7px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <span data-watch-user="${esc(r.username || '')}" style="cursor:pointer;color:var(--blue,#3b82f6);font-weight:700;font-size:11px">${esc(r.username || 'anon')}</span>
    <span style="color:#ddd;font-size:12px">${esc(r.title || '—')}</span>
    <span style="font-size:10px;color:#666">${r.started_at ? timeAgo(r.started_at) : ''} · streamed ${fmtDur(r.streamed_ms)}${pctW != null ? ` · ${pctW}% watched` : ''}</span>
  </div>`;
}
function renderWatchOverview(box, data) {
  const summary = data.summary || [], recent = data.recent || [];
  const top = summary.length ? `<div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Top watchers · 30 days</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${summary.slice(0, 24).map(s =>
      `<span data-watch-user="${esc(s.username)}" style="cursor:pointer;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:4px 8px">
        <strong style="color:#ddd">${esc(s.username)}</strong> <span style="color:#888">${fmtDur(s.streamed_ms)} · ${s.sessions} sess</span></span>`).join('')}</div>` : '';
  const feed = recent.length
    ? `<div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Recent sessions</div>` + recent.map(watchRow).join('')
    : '<div class="empty">No streaming sessions recorded yet — this fills in with accurate durations as people watch. Click a user to see their history.</div>';
  box.innerHTML = top + feed;
}
function renderWatchUser(box, data) {
  const sessions = data.sessions || [], prog = data.progress || [];
  const back = `<div style="margin-bottom:2px"><span data-watch-back style="color:var(--blue,#3b82f6);cursor:pointer;font-size:11px">← all users</span> · <strong style="color:#ddd">${esc(data.user)}</strong></div>`;
  const sess = sessions.length
    ? `<div style="font-size:10px;color:#666;text-transform:uppercase;margin:6px 0 4px">Sessions (${sessions.length})</div>` + sessions.map(watchRow).join('')
    : '<div class="empty" style="margin:4px 0">No recorded sessions yet.</div>';
  const progHtml = prog.length
    ? `<div style="font-size:10px;color:#666;text-transform:uppercase;margin:10px 0 4px">Progress / last watched (${prog.length})</div>` + prog.slice(0, 100).map(p =>
      `<div style="background:#161616;border:1px solid #232323;border-radius:6px;padding:6px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="color:#ddd;font-size:12px">${esc(p.title || '—')}</span>
        <span style="font-size:10px;color:#666">${p.updatedAt ? timeAgo(p.updatedAt) : ''} · ${p.pct || 0}% · ${fmtDur((p.position || 0) * 1000)} / ${fmtDur((p.duration || 0) * 1000)}</span>
      </div>`).join('') : '';
  box.innerHTML = back + sess + progHtml;
}
document.getElementById('watchHistory')?.addEventListener('click', (e) => {
  const u = e.target.closest('[data-watch-user]');
  if (u) { loadWatchHistory(u.dataset.watchUser); return; }
  if (e.target.closest('[data-watch-back]')) loadWatchHistory(null);
});
document.getElementById('btnRefreshWatch')?.addEventListener('click', () => loadWatchHistory());
document.getElementById('watchUserSearch')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = e.target.value.trim(); loadWatchHistory(v || null); }
});

document.getElementById('btnRefreshClient')?.addEventListener('click', loadClientLogs);
document.getElementById('clientDevices')?.addEventListener('click', (e) => {
  const tile = e.target.closest('[data-device]');
  if (!tile) return;
  const dev = tile.dataset.device;
  _deviceFilter = _deviceFilter === dev ? null : dev; // toggle
  renderClientLogs();
});
document.getElementById('clientErrors')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-clear-devfilter]')) { _deviceFilter = null; renderClientLogs(); }
});

// ── Render ──────────────────────────────────────────────────────────────────
function render({ jobs, streams, disk, server, seedbox, workersReqToday, activity, subtitles, cfEgress }) {
  _lastJobs = jobs;
  renderStats(jobs, streams, disk, server, workersReqToday, activity, subtitles);
  renderEgress(cfEgress);
  renderHealth(seedbox || {});
  renderWorkersHealth(workersReqToday);
  renderStreams(streams);
  renderUsers(jobs, streams);
  renderJobs(jobs);
  renderSysbar(server);
}

const fmtGb = (gb) => gb >= 1000 ? (gb / 1000).toFixed(2) + ' TB' : (gb || 0).toFixed(2) + ' GB';
let _egressCf = null;
let _egressRange = 7; // days: 1 | 7 | 30

function renderEgress(cf) {
  _egressCf = cf;
  const val = document.getElementById('statEgress');
  const sub = document.getElementById('statEgressSub');
  if (val) {
    if (!cf) { val.textContent = '—'; sub.textContent = 'set CLOUDFLARE_ANALYTICS_TOKEN'; }
    else if (cf.error) { val.textContent = '—'; sub.textContent = 'analytics error: ' + cf.error.slice(0, 40); }
    else {
      val.textContent = fmtGb(cf.gbMtd || 0);
      sub.textContent = `today ${fmtGb(cf.gbToday || 0)} · ${(cf.reqMtd || 0).toLocaleString()} reqs MTD`;
    }
  }
  renderEgressDetail();
}

// Time-ranged egress broken down per day, each day tied to its active-user count.
function renderEgressDetail() {
  const summ  = document.getElementById('egressSummary');
  const daily = document.getElementById('egressDaily');
  if (!summ || !daily) return;
  const cf = _egressCf;
  if (!cf || cf.error || !Array.isArray(cf.series) || !cf.series.length) {
    summ.innerHTML = '';
    daily.innerHTML = `<div class="empty">${cf?.error ? 'analytics error: ' + cf.error.slice(0, 40) : 'no egress data yet'}</div>`;
    return;
  }
  const days     = cf.series.slice(-_egressRange);
  const avail    = days.filter(d => !d.missing);               // days CF still retains
  const missing  = days.length - avail.length;
  const totGb    = avail.reduce((a, d) => a + d.gb, 0);
  const totReq   = avail.reduce((a, d) => a + d.requests, 0);
  const userDays = avail.reduce((a, d) => a + d.users, 0);      // sum of "active users that day"
  const avgUsers = avail.length ? Math.round(userDays / avail.length * 10) / 10 : 0;
  const perUser  = userDays ? totGb / userDays : 0;             // GB per active-user-day

  const stat = (label, v) => `<div style="min-width:96px">
    <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em">${label}</div>
    <div style="font-size:18px;font-weight:700;color:#e5e5e5">${v}</div></div>`;
  summ.innerHTML =
    stat('Egress', fmtGb(totGb)) +
    stat('Requests', totReq.toLocaleString()) +
    stat('Avg users/day', avgUsers) +
    stat('GB / user-day', perUser.toFixed(2)) +
    (missing ? `<div style="align-self:center;font-size:10px;color:#666">${missing} day${missing !== 1 ? 's' : ''} beyond CF's ~2-week analytics retention</div>` : '');

  const maxGb = Math.max(...avail.map(d => d.gb), 0.01);
  daily.innerHTML = days.slice().reverse().map(d => {
    if (d.missing) {
      return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;opacity:.4">
        <span style="width:52px;color:#888;font-family:monospace">${d.date.slice(5)}</span>
        <div style="flex:1;color:#666;font-size:10px">no data (retention)</div>
      </div>`;
    }
    const pct = Math.max(2, Math.round(d.gb / maxGb * 100));
    const per = d.users ? (d.gb / d.users).toFixed(2) : '—';
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11px">
      <span style="width:52px;color:#888;font-family:monospace">${d.date.slice(5)}</span>
      <div style="flex:1;background:#161616;border-radius:4px;overflow:hidden;height:16px">
        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,rgba(59,130,246,.45),rgba(59,130,246,.9))"></div>
      </div>
      <span style="width:74px;text-align:right;color:#e5e5e5">${fmtGb(d.gb)}</span>
      <span style="width:64px;text-align:right;color:#888">${d.users} user${d.users !== 1 ? 's' : ''}</span>
      <span style="width:66px;text-align:right;color:#666">${per} GB/u</span>
    </div>`;
  }).join('');
}

document.getElementById('egressRange')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-egr]');
  if (!btn) return;
  _egressRange = Number(btn.dataset.egr);
  document.querySelectorAll('#egressRange [data-egr]').forEach(b => b.classList.toggle('active', b === btn));
  renderEgressDetail();
});

function renderStats(jobs, streams, disk, server, workersReqToday, activity, subtitles) {
  if (activity) {
    document.getElementById('statDau').textContent    = activity.dau;
    document.getElementById('statDauSub').textContent = `WAU ${activity.wau} · MAU ${activity.mau}`;
  }
  if (subtitles) {
    const s    = subtitles;
    const val  = document.getElementById('statSubs');
    const sub  = document.getElementById('statSubsSub');
    const card = document.getElementById('statSubsCard');
    const ago  = s.lastFinishedAt ? timeAgo(s.lastFinishedAt) : 'never';
    if (s.stalled) {
      val.textContent = `⚠ ${s.pct}%`;
      val.style.color = 'var(--red)';
      card.style.borderColor = 'rgba(239,68,68,.5)';
      sub.textContent = `STALLED: ${s.stallReason} · ${s.missing} missing`;
      sub.style.color = 'var(--red)';
    } else {
      val.textContent = `${s.pct}%`;
      val.style.color = s.missing === 0 ? 'var(--green)' : '';
      card.style.borderColor = '';
      sub.style.color = '';
      sub.textContent = s.missing === 0
        ? `all ${s.movies} movies covered · backfill ${ago}`
        : `${s.missing} missing · backfill ${ago} (+${s.lastAdded ?? 0})`;
    }
  }
  const active  = jobs.filter(j => !['ready','error'].includes(j.status));
  const ready   = jobs.filter(j => j.status === 'ready');
  const dlJobs  = jobs.filter(j => j.status === 'downloading');
  const speed   = dlJobs.map(j => j.speed).filter(Boolean).join(' · ') || '';

  // Update users badge
  const humanUsers = new Set(jobs.filter(j => j.user && j.user !== 'system').map(j => j.user));
  const badge = document.getElementById('usersBadge');
  if (humanUsers.size > 0) {
    badge.textContent = humanUsers.size;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  document.getElementById('statActive').textContent      = active.length;
  document.getElementById('statActiveSpeed').textContent = speed;
  document.getElementById('statReady').textContent       = ready.length;
  document.getElementById('statTotal').textContent       = `${jobs.length} total jobs`;
  document.getElementById('statStreams').textContent     = streams.length;
  document.getElementById('statStreamDetail').textContent =
    streams.length ? streams.map(s => s.title).join(', ').slice(0, 40) : 'none';

  if (disk.free !== null) {
    document.getElementById('statDisk').textContent    = `${disk.free} GB`;
    document.getElementById('statDiskSub').textContent = `${disk.used} / ${disk.total} GB used`;
  }

  document.getElementById('statMem').textContent    = `${server.memUsed} MB`;
  document.getElementById('statUptime').textContent  = `up ${fmtUptime(server.uptime)}`;

  // R2 storage — computed from the polled r2Objects map
  const r2Bytes = [...r2Objects.values()].reduce((acc, o) => acc + (o.size || 0), 0);
  const r2Gb    = r2Bytes / 1e9;
  const r2Cost  = Math.max(0, r2Gb - 10) * 0.015; // $0.015/GB, first 10 GB free
  const r2Label = r2Gb >= 1000
    ? `${(r2Gb / 1000).toFixed(2)} TB`
    : `${r2Gb.toFixed(1)} GB`;
  document.getElementById('statR2Size').textContent = r2Label;
  document.getElementById('statR2Sub').textContent  =
    `${r2Objects.size} files · ~$${r2Cost.toFixed(2)}/mo · egress free`;

  // Cost breakdown
  const r2Gb1 = r2Gb.toFixed(1);
  const el = (id) => document.getElementById(id);
  const eurTotal  = 12.98 + 39.99;
  const usdTotal  = 5 + r2Cost;
  const runRateAud = 20 + (usdTotal * 1.55) + (eurTotal * 1.75); // VPS + USD→AUD + EUR→AUD
  const audSub    = 20 + (usdTotal * 1.55); // AUD-denominated sub-total (VPS + USD converted)
  if (el('costR2Note'))    el('costR2Note').textContent   = `${r2Gb1} GB`;
  if (el('costR2Value'))   el('costR2Value').textContent  = `US$${r2Cost.toFixed(2)}`;
  if (el('costTotalEur'))  el('costTotalEur').textContent = `€${eurTotal.toFixed(2)}`;
  if (el('costTotalUsd'))  el('costTotalUsd').textContent = `US$${usdTotal.toFixed(2)}`;
  if (el('costTotalAud'))  el('costTotalAud').textContent = `A$${audSub.toFixed(2)}`;
  if (el('costRunRate'))   el('costRunRate').textContent  = `A$${runRateAud.toFixed(2)}`;
}

function renderStreams(streams) {
  const grid = document.getElementById('streamsGrid');
  if (!streams.length) {
    grid.innerHTML = '<div class="empty">No active streams</div>';
    return;
  }
  grid.innerHTML = streams.map(s => {
    const wallDur  = Math.floor((Date.now() - s.startedAt) / 1000);
    const pct      = s.size && s.bytesSent ? Math.round(s.bytesSent / s.size * 100)
                   : s.duration > 0        ? Math.round(s.currentTime / s.duration * 100)
                   : 0;
    const pos      = s.currentTime != null ? fmtUptime(Math.floor(s.currentTime)) : null;
    const total    = s.duration    != null ? fmtUptime(Math.floor(s.duration))    : null;
    const mbTotal  = s.size ? (s.size / 1e9).toFixed(2) + ' GB' : '—';
    return `
      <div class="stream-card">
        <div>
          <div class="stream-title">${esc(s.title)}</div>
          <div class="stream-meta">
            <span>IP: ${esc(s.ip)}</span>
            <span>Wall: ${fmtUptime(wallDur)}</span>
            ${pos ? `<span>Position: ${pos} / ${total}</span>` : ''}
            <span>File: ${mbTotal}</span>
          </div>
        </div>
        <div class="stream-progress">
          <div class="stream-pct">${pct}%</div>
          <div class="stream-bytes">${pos || '—'}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Users ────────────────────────────────────────────────────────────────────
// ── Unified Users data cache ─────────────────────────────────────────────────
let _gamifData    = [];
let _accountsData = [];
let _userSort   = 'newest';
let _userAccess = 'all';
let _userSearch = '';

async function refreshUsersData() {
  try {
    [_gamifData, _accountsData] = await Promise.all([
      fetch('/api/admin/gamification').then(r => r.json()),
      fetch('/api/admin/users').then(r => r.json()),
    ]);
    renderGamifSummary(_gamifData);
    renderUsers(_lastJobs || [], _lastStreams || []);
  } catch (e) { appendLog(`[ERR] refreshUsersData: ${e.message}`); }
}

function renderGamifSummary(rows) {
  const summary = document.getElementById('gamifSummary');
  if (!summary) return;
  const totalRefs    = rows.reduce((s, r) => s + r.referralCount, 0);
  const totalWatched = rows.reduce((s, r) => s + r.watchTotal, 0);
  const tiered       = rows.filter(r => r.tier).length;
  const activeNow    = rows.filter(r => r.paid && (!r.accessExpiresAt || r.accessExpiresAt > Date.now())).length;
  // Active-user counts from last-seen analytics (accounts data carries lastSeen).
  const now = Date.now(), DAY = 86400000;
  const accts = _accountsData || [];
  const since = ms => accts.filter(a => a.lastSeen && a.lastSeen >= now - ms).length;
  summary.innerHTML = [
    ['Users',         rows.length,   ''],
    ['Active Access', activeNow,     'green'],
    ['DAU',           since(DAY),        'green'],
    ['WAU',           since(7 * DAY),    ''],
    ['MAU',           since(30 * DAY),   ''],
    ['Referrals',     totalRefs,     ''],
    ['Films Watched', totalWatched,  ''],
    ['With Tier',     tiered,        ''],
  ].map(([label, val, cls]) => `
    <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:10px 16px;min-width:110px">
      <div style="font-size:20px;font-weight:700;color:${cls === 'green' ? 'var(--green)' : '#fff'}">${val}</div>
      <div style="font-size:10px;color:#555;margin-top:2px;text-transform:uppercase;letter-spacing:.6px">${label}</div>
    </div>`).join('');
}

function renderUsers(jobs, streams) {
  _lastStreams = streams;
  const tbody = document.getElementById('usersTbody');

  // Preserve any in-progress grant-duration selections across this re-render.
  // The table rebuilds on every admin:stats push; without this, a selection
  // (e.g. "1 month") silently reverts to the default "7 days" before Grant is
  // clicked if a push lands in between.
  const priorGrant = {};
  tbody.querySelectorAll('select[data-grant-user]').forEach(s => {
    priorGrant[s.dataset.grantUser] = s.value;
  });

  // Build per-user activity from jobs
  const actMap = new Map();
  for (const j of jobs) {
    const u = j.user || 'anonymous';
    if (u === 'system') continue;
    if (!actMap.has(u)) actMap.set(u, { ips: new Set(), allJobs: [], activeJobs: [], readyJobs: [], lastActive: 0, streams: [] });
    const d = actMap.get(u);
    d.allJobs.push(j);
    if (j.ip) d.ips.add(j.ip);
    if (['queued','searching','downloading','uploading','processing'].includes(j.status)) d.activeJobs.push(j);
    if (j.status === 'ready') d.readyJobs.push(j);
    if ((j.createdAt || 0) > d.lastActive) d.lastActive = j.createdAt || 0;
  }
  for (const s of streams) {
    const job = jobs.find(j => j.id === s.jobId);
    const u   = job?.user || 'anonymous';
    if (u === 'system') continue;
    if (!actMap.has(u)) actMap.set(u, { ips: new Set(), allJobs: [], activeJobs: [], readyJobs: [], lastActive: 0, streams: [] });
    actMap.get(u).streams.push({ ...s, streamIp: s.ip });
  }

  // Merge all sources by username
  const allUsernames = new Set([
    ..._accountsData.map(u => u.username),
    ..._gamifData.map(r => r.username),
    ...actMap.keys(),
  ]);

  if (!allUsernames.size) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No users yet</td></tr>';
    return;
  }

  const TIER_COLORS = { 'Mogul': '#ff0099', 'A-Lister': '#9b59b6', 'Scene Stealer': '#3498db', 'Extra': '#888' };

  const rows = [...allUsernames].map(username => {
    const acc  = _accountsData.find(u => u.username === username) || {};
    const gam  = _gamifData.find(r => r.username === username)   || {};
    const act  = actMap.get(username) || { ips: new Set(), allJobs: [], activeJobs: [], readyJobs: [], lastActive: 0, streams: [] };
    return { username, acc, gam, act };
  });

  // ── Filter + sort (driven by the controls above the table) ───────────────
  const now = Date.now();
  const expiryOf = ({ gam, acc }) => gam.accessExpiresAt || acc.accessExpiresAt || null;
  const isPaid    = (r) => (r.gam.paid ?? r.acc.paid) && (!expiryOf(r) || expiryOf(r) > now);
  const isExpired = (r) => { const e = expiryOf(r); return !!(e && e <= now); };
  const lastActiveOf = (r) => Math.max(r.act.lastActive || 0, r.acc.lastSeen || 0);

  let filtered = rows;
  if (_userSearch) {
    const q = _userSearch.toLowerCase();
    filtered = filtered.filter(r => r.username.toLowerCase().includes(q) || (r.acc.email || '').toLowerCase().includes(q));
  }
  if (_userAccess === 'paid')    filtered = filtered.filter(isPaid);
  else if (_userAccess === 'free')    filtered = filtered.filter(r => !isPaid(r) && !isExpired(r));
  else if (_userAccess === 'expired') filtered = filtered.filter(isExpired);

  const cmp = {
    newest:    (a, b) => (b.acc.createdAt || 0) - (a.acc.createdAt || 0),
    oldest:    (a, b) => (a.acc.createdAt || 0) - (b.acc.createdAt || 0),
    active:    (a, b) => lastActiveOf(b) - lastActiveOf(a),
    watched:   (a, b) => (b.gam.watchTotal || 0) - (a.gam.watchTotal || 0),
    referrals: (a, b) => (b.gam.referralCount || 0) - (a.gam.referralCount || 0),
    name:      (a, b) => a.username.localeCompare(b.username),
  };
  filtered = filtered.slice().sort(cmp[_userSort] || cmp.newest);

  const countEl = document.getElementById('userCount');
  if (countEl) countEl.textContent = filtered.length === rows.length
    ? `${rows.length} users`
    : `${filtered.length} of ${rows.length} users`;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No matching users</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(({ username, acc, gam, act }) => {
    const rowClass = act.streams.length ? 'user-row-streaming' : '';

    // User cell: username + email + since
    const sinceStr = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString() : '';
    const userHtml = `<div>
      <strong>${esc(username)}</strong>
      ${acc.password ? `<span class="user-ip-pill mono" style="margin-left:4px">${esc(acc.password)}</span>` : ''}
    </div>
    <div style="font-size:10px;color:#555;margin-top:3px">
      ${acc.email ? `<span style="color:#888">${esc(acc.email)}</span> · ` : ''}${sinceStr}
    </div>`;

    // Access cell: type, source, expiry
    const now = Date.now();
    const exp = gam.accessExpiresAt || acc.accessExpiresAt || null;
    const paid = gam.paid;
    let accessHtml;
    if (!paid && !exp) {
      accessHtml = `<span style="color:#444;font-size:11px">no access</span>`;
    } else if (exp && now > exp) {
      accessHtml = `<span style="color:var(--red);font-size:11px;font-weight:600">expired</span>
        <div style="font-size:10px;color:#555">${timeAgo(exp)}</div>`;
    } else {
      const typeLabel = acc.accessType === 'admin' ? 'admin grant' : acc.accessType === 'invite' ? 'invite' : acc.accessType === 'stripe' ? 'stripe' : paid ? 'active' : '—';
      const typeColor = acc.accessType === 'stripe' ? 'var(--blue)' : acc.accessType === 'admin' ? '#a855f7' : acc.accessType === 'invite' ? '#ff0099' : 'var(--green)';
      const expiryLine = exp
        ? `<div style="font-size:10px;color:#666">exp ${timeAgo(exp)}</div>`
        : '';
      const codePill = acc.inviteCode
        ? `<span style="font-size:10px;color:#ff0099;background:rgba(255,0,153,.08);border:1px solid rgba(255,0,153,.2);border-radius:3px;padding:1px 5px;display:inline-block;margin-top:2px">${esc(acc.inviteCode)}</span>`
        : '';
      accessHtml = `<span style="font-size:11px;font-weight:600;color:${typeColor}">${typeLabel}</span>${expiryLine}${codePill ? '<div>' + codePill + '</div>' : ''}`;
    }

    // Activity cell: streaming or active jobs or last seen
    let activityHtml;
    if (act.streams.length) {
      activityHtml = act.streams.map(s => `
        <div class="user-now">
          <span class="now-dot"></span>
          <span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</span>
        </div>`).join('');
    } else if (act.activeJobs.length) {
      const j = act.activeJobs[0];
      const pct = j.progress ? ` ${j.progress}%` : '';
      const statusColor = j.status === 'downloading' ? 'var(--yellow)' : j.status === 'uploading' ? 'var(--blue)' : '#888';
      activityHtml = `<span style="font-size:11px"><span style="color:var(--text)">${esc(shortTitle(j))}</span> <span style="color:${statusColor}">${j.status}${pct}</span></span>`;
    } else {
      const seenTs = Math.max(act.lastActive || 0, acc.lastSeen || 0);
      activityHtml = `<span class="muted" style="font-size:11px">${seenTs ? timeAgo(seenTs) : '—'}</span>`;
    }

    // Library cell: ready/total + watched
    const libraryHtml = `<span class="mono" style="font-size:11px">${act.readyJobs.length}/${act.allJobs.length} req</span>
      ${gam.watchTotal > 0 ? `<div style="font-size:10px;color:#666">${gam.watchTotal} watched</div>` : ''}`;

    // Referral cell: code + count + tier
    const tierHtml = gam.tier
      ? `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;background:${TIER_COLORS[gam.tier] || '#888'}22;color:${TIER_COLORS[gam.tier] || '#888'};border:1px solid ${TIER_COLORS[gam.tier] || '#888'}33;display:inline-block;margin-top:2px">${esc(gam.tier)}</span>`
      : '';
    const refCodeHtml = gam.referralCode
      ? `<span class="mono" style="font-size:11px;color:#ff0099">${esc(gam.referralCode)}</span>`
      : '<span class="muted" style="font-size:11px">—</span>';
    const refCountHtml = gam.referralCount > 0
      ? `<span style="font-size:10px;color:#aaa">${gam.referralCount} ref${gam.referralCount !== 1 ? 's' : ''}</span>`
      : '';
    const referralHtml = `${refCodeHtml}${refCountHtml ? ' · ' + refCountHtml : ''}${tierHtml ? '<div>' + tierHtml + '</div>' : ''}`;

    // Grant Access select + button. Re-select whatever the admin had chosen
    // before the last re-render (defaults to 7 days for a fresh row).
    const savedGrant = priorGrant[username] ?? '604800000';
    const grantOpt = (v, label) => `<option value="${v}"${String(savedGrant) === v ? ' selected' : ''}>${label}</option>`;
    const grantHtml = `<div style="display:flex;gap:4px;align-items:center">
      <select data-grant-user="${esc(username)}" style="padding:3px 6px;background:#1a1a1a;border:1px solid #333;color:#e5e5e5;font-family:inherit;font-size:11px;border-radius:4px;outline:none">
        ${grantOpt('604800000', '7 days')}
        ${grantOpt('2592000000', '1 month')}
        ${grantOpt('7776000000', '3 months')}
        ${grantOpt('15552000000', '6 months')}
        ${grantOpt('31536000000', '1 year')}
        ${grantOpt('0', 'Lifetime')}
      </select>
      <button class="btn btn-ghost btn-sm" data-grant-btn="${esc(username)}" style="color:var(--green);border-color:rgba(34,197,94,.3)">Grant</button>
    </div>`;

    return `<tr class="${rowClass}">
      <td>${userHtml}</td>
      <td>${accessHtml}</td>
      <td>${activityHtml}</td>
      <td>${libraryHtml}</td>
      <td>${referralHtml}</td>
      <td>${grantHtml}</td>
      <td><button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del-user="${esc(username)}">✕</button></td>
    </tr>`;
  }).join('');
}

function shortTitle(j) {
  const t = j.showTitle || j.title || '';
  const ep = j.season && j.episode
    ? ` S${String(j.season).padStart(2,'0')}E${String(j.episode).padStart(2,'0')}`
    : '';
  return (t + ep).slice(0, 40);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const future = diff < 0;
  const s = Math.abs(Math.floor(diff / 1000));
  let str;
  if (s < 60)    str = `${s}s`;
  else if (s < 3600)  str = `${Math.floor(s/60)}m`;
  else if (s < 86400) str = `${Math.floor(s/3600)}h`;
  else                str = `${Math.floor(s/86400)}d`;
  return future ? `in ${str}` : `${str} ago`;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────
function getJobFilter() {
  return {
    search: (document.getElementById('jobSearch')?.value || '').toLowerCase(),
    status: document.getElementById('jobStatusFilter')?.value || '',
    type:   document.getElementById('jobTypeFilter')?.value || '',
  };
}

function renderJobs(jobs) {
  const { search, status, type } = getJobFilter();
  let filtered = jobs;

  if (search) {
    filtered = filtered.filter(j =>
      (j.title    || '').toLowerCase().includes(search) ||
      (j.showTitle || '').toLowerCase().includes(search) ||
      (j.user      || '').toLowerCase().includes(search)
    );
  }
  if (status) filtered = filtered.filter(j => j.status === status);
  if (type === 'catalog')  filtered = filtered.filter(j => j.catalog);
  else if (type === 'user') filtered = filtered.filter(j => !j.catalog);
  else if (type === 'movie') filtered = filtered.filter(j => j.type === 'movie');
  else if (type === 'tv')    filtered = filtered.filter(j => j.type === 'tv');

  const countEl = document.getElementById('jobFilterCount');
  if (countEl) {
    countEl.textContent = (search || status || type)
      ? `${filtered.length} of ${jobs.length} jobs`
      : `${jobs.length} jobs`;
  }

  const tbody = document.getElementById('jobsTbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty">${(search || status || type) ? 'No matching jobs' : 'No jobs yet'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(j => {
    const age = Math.floor((Date.now() - j.createdAt) / 1000);
    const pct = j.progress ?? 0;
    const isDone = j.status === 'ready';
    const isErr  = j.status === 'error';

    const prog = (j.status === 'downloading' || isDone || isErr) ? `
      <div class="prog-wrap">
        <div class="prog-bar"><div class="prog-fill ${isDone ? 'done' : ''}" style="width:${pct}%"></div></div>
        <div class="prog-text">${pct}%${j.eta ? ' · ' + fmtEta(j.eta) : ''}</div>
      </div>` : '<span class="muted mono">—</span>';

    const streamBtn = isDone && j.streamUrl
      ? `<a href="${j.streamUrl}" target="_blank" class="btn btn-ghost btn-sm">▶ Play</a>`
      : '';
    const retryBtn = isErr
      ? `<button class="btn btn-ghost btn-sm" style="color:var(--yellow)" data-retry="${j.id}">↺ Retry</button>`
      : '';

    const subMsg = j.status === 'error'
      ? (j.error || j.message || '').slice(0, 80)
      : (j.message || '').slice(0, 60);

    const dlTime = j.downloadedAt ? fmtDuration(j.downloadedAt - j.createdAt)   : '—';
    const upTime = j.readyAt && j.downloadedAt ? fmtDuration(j.readyAt - j.downloadedAt) : '—';

    let r2Cell = '<span class="muted mono">—</span>';
    if (j.r2Key) {
      const r2obj = r2Objects.get(j.r2Key);
      if (r2obj) {
        const gb = (r2obj.size / 1e9).toFixed(2);
        r2Cell = `<span class="green mono" title="${esc(j.r2Key)}">✓ ${gb} GB</span>`;
      } else if (j.status === 'ready') {
        r2Cell = `<span style="color:#f97316" class="mono" title="${esc(j.r2Key)}">⚠ missing</span>`;
      }
    } else if (j.status === 'ready' && j.streamUrl) {
      r2Cell = `<span class="green mono">✓ ready</span>`;
    }

    const userLabel = j.user === 'system'
      ? '<span class="muted" style="font-size:10px">catalog</span>'
      : `<span style="color:#aaa">${esc(j.user || '—')}</span>`;

    return `<tr data-job-id="${j.id}">
      <td><input type="checkbox" class="job-chk" data-id="${j.id}"></td>
      <td>
        <div class="title-cell">${esc(j.title)}</div>
        <div class="title-year">${j.year || ''}${subMsg ? ' · <span style="color:' + (j.status==='error'?'var(--red)':'#888') + '">' + esc(subMsg) + '</span>' : ''}</div>
      </td>
      <td>${userLabel}</td>
      <td><span class="badge badge-${j.status}">${j.status}</span></td>
      <td>${prog}</td>
      <td><span class="mono">${j.quality || '—'}</span></td>
      <td><span class="mono muted">${fmtSize(j.size)}</span></td>
      <td>${r2Cell}</td>
      <td><span class="mono muted">${j.speed || '—'}</span></td>
      <td><span class="mono muted">${fmtUptime(age)}</span></td>
      <td><span class="mono ${j.downloadedAt ? 'green' : 'muted'}">${dlTime}</span></td>
      <td><span class="mono ${j.readyAt ? 'green' : 'muted'}">${upTime}</span></td>
      <td style="display:flex;gap:6px;align-items:center">
        ${streamBtn}
        ${retryBtn}
        <button class="btn btn-ghost btn-sm" data-delete="${j.id}">✕</button>
      </td>
    </tr>`;
  }).join('');
}

function renderHealth({ activeSeedboxOps = 0, cooldownSecsLeft = 0, diskFreeGb = null, monthlyUploadGb = 0, monthlyLimitGb = 20000, diskTotalGb = 4000, qbitTransfer = null } = {}) {
  function setCard(cardId, valueId, barId, subId, value, pct, level, valueTxt, subTxt) {
    const card = document.getElementById(cardId);
    const val  = document.getElementById(valueId);
    const bar  = document.getElementById(barId);
    const sub  = document.getElementById(subId);
    card.className = `health-card${level === 'warn' ? ' warn' : level === 'crit' ? ' crit' : ''}`;
    val.className  = `health-value ${level}`;
    val.textContent = valueTxt;
    if (bar) { bar.style.width = Math.min(100, pct) + '%'; bar.className = `health-bar-fill ${level}`; }
    if (sub) sub.textContent = subTxt;
  }

  // Concurrent ops (warn ≥3, crit ≥6 out of 25 max jobs)
  const opsLevel = activeSeedboxOps >= 6 ? 'crit' : activeSeedboxOps >= 3 ? 'warn' : 'ok';
  setCard('hcOps','hOps','hOpsBar','hOpsSub',
    activeSeedboxOps, activeSeedboxOps / 10 * 100, opsLevel,
    String(activeSeedboxOps),
    activeSeedboxOps === 1 ? '1 active ffmpeg session' : `${activeSeedboxOps} active ffmpeg sessions`);

  // Monthly bandwidth — use real qBit total (dl+up) if available, fall back to our R2 upload counter
  const bwGb    = qbitTransfer ? qbitTransfer.totalGb : monthlyUploadGb;
  const bwPct   = monthlyLimitGb > 0 ? bwGb / monthlyLimitGb * 100 : 0;
  const bwLevel = bwPct >= 90 ? 'crit' : bwPct >= 75 ? 'warn' : 'ok';
  const bwTxt   = bwGb >= 1000 ? `${(bwGb/1000).toFixed(2)} TB` : `${bwGb} GB`;
  setCard('hcBw','hBw','hBwBar','hBwSub',
    bwPct, bwPct, bwLevel,
    bwTxt,
    qbitTransfer ? `${bwPct.toFixed(1)}% of 20 TB · ↓${qbitTransfer.dlGb >= 1000 ? (qbitTransfer.dlGb/1000).toFixed(1)+'TB' : qbitTransfer.dlGb+'GB'} ↑${qbitTransfer.upGb >= 1000 ? (qbitTransfer.upGb/1000).toFixed(1)+'TB' : qbitTransfer.upGb+'GB'}`
    : `${bwPct.toFixed(1)}% of 20 TB limit`);

  // Seedbox disk free (warn <1 TB, crit <500 GB)
  if (diskFreeGb !== null) {
    const diskUsedGb = diskTotalGb - diskFreeGb;
    const diskPct    = diskTotalGb > 0 ? diskUsedGb / diskTotalGb * 100 : 0;
    const diskLevel  = diskFreeGb < 500 ? 'crit' : diskFreeGb < 1000 ? 'warn' : 'ok';
    const diskTxt    = diskFreeGb >= 1000 ? `${(diskFreeGb/1000).toFixed(1)} TB` : `${diskFreeGb} GB`;
    setCard('hcDisk','hDisk','hDiskBar','hDiskSub',
      diskPct, diskPct, diskLevel, diskTxt,
      `free — ${diskPct.toFixed(0)}% used of ${(diskTotalGb/1000).toFixed(0)} TB`);
  } else {
    document.getElementById('hDisk').textContent = '—';
    document.getElementById('hDiskSub').textContent = 'unavailable';
  }

  // qBit status
  const qbtCard = document.getElementById('hcQbt');
  const qbtVal  = document.getElementById('hQbt');
  const qbtSub  = document.getElementById('hQbtSub');
  if (cooldownSecsLeft > 0) {
    qbtCard.className = 'health-card crit';
    qbtVal.className  = 'health-value crit';
    qbtVal.textContent = 'COOLDOWN';
    const mins = Math.ceil(cooldownSecsLeft / 60);
    qbtSub.innerHTML = `${mins}m remaining — <button id="clearCooldownBtn" style="background:var(--red);border:none;color:#fff;font-family:inherit;font-size:11px;font-weight:700;padding:2px 10px;border-radius:3px;cursor:pointer;letter-spacing:.3px">Clear Now</button>`;
    document.getElementById('clearCooldownBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('clearCooldownBtn');
      btn.textContent = '…'; btn.disabled = true;
      await fetch('/api/admin/clear-cooldown', { method: 'POST' });
      appendLog('[LOG] qBittorrent cooldown cleared');
    });
  } else {
    qbtCard.className = 'health-card';
    qbtVal.className  = 'health-value ok';
    qbtVal.textContent = 'OK';
    qbtSub.textContent = 'session active';
  }
}

function renderWorkersHealth(reqToday) {
  const LIMIT = 10_000_000;
  const card  = document.getElementById('hcWorkers');
  const val   = document.getElementById('hWorkers');
  const bar   = document.getElementById('hWorkersBar');
  const sub   = document.getElementById('hWorkersSub');
  if (!card) return;
  if (reqToday === null || reqToday === undefined) {
    val.textContent = '—';
    sub.textContent = 'today · 10M/day limit';
    return;
  }
  const pct   = reqToday / LIMIT * 100;
  const level = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  const fmt   = reqToday >= 1_000_000
    ? `${(reqToday / 1_000_000).toFixed(2)}M`
    : reqToday >= 1000
    ? `${(reqToday / 1000).toFixed(1)}k`
    : String(reqToday);
  card.className = `health-card${level === 'warn' ? ' warn' : level === 'crit' ? ' crit' : ''}`;
  val.className  = `health-value ${level}`;
  val.textContent = fmt;
  bar.style.width = Math.min(100, pct) + '%';
  bar.className  = `health-bar-fill ${level}`;
  sub.textContent = `${pct.toFixed(2)}% of 10M/day · $5/mo paid plan`;
}

function renderSysbar(server) {
  document.getElementById('dotR2').className      = `dot ${server.r2     ? 'dot-on' : 'dot-off'}`;
  document.getElementById('dotFfmpeg').className  = `dot ${server.ffmpeg ? 'dot-on' : 'dot-off'}`;
  document.getElementById('sysUptime').textContent = `uptime: ${fmtUptime(server.uptime)} · mem: ${server.memUsed} MB`;
}

// ── Accounts ─────────────────────────────────────────────────────────────────
// ── Invite-only toggle ────────────────────────────────────────────────────────
async function loadInviteOnlySetting() {
  try {
    const { inviteOnly } = await fetch('/api/admin/settings').then(r => r.json());
    document.getElementById('inviteOnlyToggle')?.classList.toggle('on', inviteOnly);
  } catch {}
}

document.getElementById('inviteOnlyToggle')?.addEventListener('click', async () => {
  const el = document.getElementById('inviteOnlyToggle');
  const current = el.classList.contains('on');
  const { inviteOnly } = await fetch('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteOnly: !current }),
  }).then(r => r.json()).catch(() => ({ inviteOnly: current }));
  el.classList.toggle('on', inviteOnly);
  appendLog(`[admin] signup mode → ${inviteOnly ? 'invite-only' : 'open'}`);
});

// Users tab actions (grant access, delete)
document.getElementById('usersTbody').addEventListener('click', async (e) => {
  const grantBtn = e.target.closest('[data-grant-btn]');
  if (grantBtn) {
    const username = grantBtn.dataset.grantBtn;
    const select   = grantBtn.closest('div').querySelector(`select[data-grant-user]`);
    const durationMs = Number(select?.value || 0);
    await fetch(`/api/admin/user/${encodeURIComponent(username)}/access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs }),
    });
    appendLog(`[admin] granted access to ${username}${durationMs ? ` for ${select.options[select.selectedIndex].text}` : ' (lifetime)'}`);
    await refreshUsersData();
    return;
  }
  const delBtn = e.target.closest('[data-del-user]');
  if (!delBtn) return;
  await fetch(`/api/admin/user/${encodeURIComponent(delBtn.dataset.delUser)}`, { method: 'DELETE' });
  await refreshUsersData();
});

document.getElementById('btnAddUser')?.addEventListener('click', () => {
  const form = document.getElementById('addUserForm');
  form.hidden = !form.hidden;
  form.style.display = form.hidden ? '' : 'flex';
});

document.getElementById('btnCreateUser')?.addEventListener('click', async () => {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value.trim();
  if (!username || !password) return;
  const res = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.ok) {
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('addUserForm').hidden = true;
    await refreshUsersData();
  } else {
    const d = await res.json();
    appendLog(`[ERR] Create user failed: ${d.error}`);
  }
});

document.getElementById('btnRefreshUsers')?.addEventListener('click', refreshUsersData);

// User sort / filter / search — re-render from cached data (no refetch needed).
const _rerenderUsers = () => renderUsers(_lastJobs || [], _lastStreams || []);
document.getElementById('userSort')?.addEventListener('change',   e => { _userSort   = e.target.value; _rerenderUsers(); });
document.getElementById('userAccess')?.addEventListener('change', e => { _userAccess = e.target.value; _rerenderUsers(); });
document.getElementById('userSearch')?.addEventListener('input',  e => { _userSearch = e.target.value.trim(); _rerenderUsers(); });

// ── Invite Codes ─────────────────────────────────────────────────────────────
function fmtCodeDuration(ms) {
  if (!ms) return '<span class="muted">Lifetime</span>';
  const days = Math.round(ms / 86400000);
  if (days === 7)   return '7 days';
  if (days === 30)  return '1 month';
  if (days === 90)  return '3 months';
  if (days === 180) return '6 months';
  if (days === 365) return '1 year';
  return `${days}d`;
}

async function fetchCodes() {
  try {
    const codes = await fetch('/api/admin/invite-codes').then(r => r.json());
    const tbody = document.getElementById('codesTbody');
    if (!codes.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No codes yet — click Generate Code to create one</td></tr>'; return; }
    tbody.innerHTML = codes.map(c => {
      const active  = c.active !== false;
      const uses    = c.uses || 0;
      const usesStr = c.maxUses ? `${uses} / ${c.maxUses}` : `${uses}`;
      const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—';
      const copyBtn   = `<button class="btn btn-ghost btn-sm" data-copy-code="${esc(c.code)}" title="Copy code">⎘</button>`;
      const toggleBtn = `<button class="btn btn-ghost btn-sm" data-toggle-code="${esc(c.code)}" title="${active ? 'Disable' : 'Enable'}" style="color:${active ? 'var(--green)' : '#555'}">${active ? '●' : '○'}</button>`;
      const delBtn    = `<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-del-code="${esc(c.code)}" title="Delete">✕</button>`;
      return `<tr style="${active ? '' : 'opacity:.45'}">
        <td><strong class="mono" style="letter-spacing:1px;color:#ff0099">${esc(c.code)}</strong></td>
        <td class="muted" style="font-size:11px">${esc(c.notes || '—')}</td>
        <td style="font-size:11px">${fmtCodeDuration(c.durationMs)}</td>
        <td class="mono" style="font-size:12px">${usesStr}</td>
        <td style="font-size:11px">${active ? '<span style="color:var(--green)">Active</span>' : '<span class="muted">Off</span>'}</td>
        <td class="muted mono" style="font-size:11px">${created}</td>
        <td style="display:flex;gap:4px">${copyBtn}${toggleBtn}${delBtn}</td>
      </tr>`;
    }).join('');
  } catch (e) { appendLog(`[ERR] fetchCodes: ${e.message}`); }
}

document.getElementById('btnGenCode')?.addEventListener('click', () => {
  const form = document.getElementById('codeCreateForm');
  form.hidden = !form.hidden;
});

document.getElementById('btnCreateCode')?.addEventListener('click', async () => {
  const code       = document.getElementById('codeInput').value.trim().toUpperCase();
  const notes      = document.getElementById('codeNotes').value.trim();
  const durationMs = parseInt(document.getElementById('codeDuration').value) || null;
  const maxUses    = parseInt(document.getElementById('codeMaxUses').value)  || null;
  const res = await fetch('/api/admin/invite-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code || undefined, notes, durationMs, maxUses }),
  });
  const data = await res.json();
  if (res.ok) {
    appendLog(`[LOG] Invite code created: ${data.code}`);
    document.getElementById('codeInput').value    = '';
    document.getElementById('codeNotes').value    = '';
    document.getElementById('codeDuration').value = '';
    document.getElementById('codeMaxUses').value  = '';
    document.getElementById('codeCreateForm').hidden = true;
    fetchCodes();
  } else {
    appendLog(`[ERR] Create code failed: ${data.error}`);
  }
});

document.getElementById('codesTbody')?.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy-code]');
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copyCode).catch(() => {});
    const orig = copy.textContent;
    copy.textContent = '✓'; setTimeout(() => { copy.textContent = orig; }, 1200);
    return;
  }
  const toggle = e.target.closest('[data-toggle-code]');
  if (toggle) {
    await fetch(`/api/admin/invite-codes/${encodeURIComponent(toggle.dataset.toggleCode)}`, { method: 'PATCH' });
    fetchCodes();
    return;
  }
  const del = e.target.closest('[data-del-code]');
  if (del) {
    await fetch(`/api/admin/invite-codes/${encodeURIComponent(del.dataset.delCode)}`, { method: 'DELETE' });
    fetchCodes();
  }
});

// ── Job actions ───────────────────────────────────────────────────────────────
async function deleteJob(id) {
  await fetch(`/api/admin/job/${id}`, { method: 'DELETE' });
}

async function clearCompleted() {
  await fetch('/api/admin/jobs/completed', { method: 'DELETE' });
}

async function cleanupDisk() {
  await fetch('/api/admin/cleanup-disk', { method: 'POST' });
  appendLog('[LOG] manual disk cleanup triggered');
}

document.getElementById('btnClearDone')?.addEventListener('click', clearCompleted);
document.getElementById('btnCleanDisk')?.addEventListener('click', cleanupDisk);
document.getElementById('btnClearLog')?.addEventListener('click', clearLog);
document.getElementById('btnCatalogSync')?.addEventListener('click', async () => {
  await fetch('/api/admin/catalog/sync', { method: 'POST' });
  appendLog('[LOG] Catalog sync triggered');
});
document.getElementById('btnCatalogRetry')?.addEventListener('click', async () => {
  await fetch('/api/admin/catalog/retry', { method: 'POST' });
  appendLog('[LOG] Catalog retry (cooldown cleared) triggered');
});

document.getElementById('chkAll')?.addEventListener('change', (e) => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = e.target.checked; });
  updateSelectionUI();
});
document.getElementById('btnSelectAll')?.addEventListener('click', () => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = true; });
  updateSelectionUI();
});
document.getElementById('btnSelectNone')?.addEventListener('click', () => {
  document.querySelectorAll('.job-chk').forEach(c => { c.checked = false; });
  updateSelectionUI();
});
document.getElementById('btnDeleteSelected')?.addEventListener('click', async () => {
  const ids = getCheckedIds();
  if (!ids.length) return;
  const btn = document.getElementById('btnDeleteSelected');
  btn.textContent = `Deleting ${ids.length}…`;
  btn.disabled = true;
  await Promise.all(ids.map(id => fetch(`/api/admin/job/${id}`, { method: 'DELETE' })));
  btn.textContent = '🗑 Delete Selected';
  btn.disabled = false;
  appendLog(`[LOG] Deleted ${ids.length} jobs`);
});

['jobSearch', 'jobStatusFilter', 'jobTypeFilter'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => renderJobs(_lastJobs));
});

document.getElementById('jobsTbody').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete]');
  if (del) { deleteJob(del.dataset.delete); return; }
  const retry = e.target.closest('[data-retry]');
  if (retry) {
    retry.textContent = '…';
    retry.disabled = true;
    await fetch(`/api/admin/job/${retry.dataset.retry}/retry`, { method: 'POST' });
    appendLog(`[LOG] Retrying job ${retry.dataset.retry}`);
  }
});
document.getElementById('jobsTbody').addEventListener('change', (e) => {
  if (e.target.classList.contains('job-chk')) updateSelectionUI();
});

// ── Util ──────────────────────────────────────────────────────────────────────
function fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function fmtEta(s) {
  if (!s) return '';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s/60)}m`;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtSize(s) {
  if (!s || s === '?') return '—';
  const n = typeof s === 'number' ? s : (typeof s === 'string' && /^\d+$/.test(s.trim()) ? parseInt(s) : null);
  if (n !== null) {
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
    if (n >= 1e9)  return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6)  return `${(n / 1e6).toFixed(0)} MB`;
    return `${n} B`;
  }
  return String(s);
}

const logBox = document.getElementById('logBox');
const MAX_LOG_LINES = 200;
let logLines = [];

function appendLog(line) {
  const ts = new Date().toLocaleTimeString('en-AU', { hour12: false });
  const colored = line.startsWith('[ERR]')
    ? `<span style="color:#ff0099">${esc(line)}</span>`
    : line.startsWith('[WARN]')
      ? `<span style="color:#eab308">${esc(line)}</span>`
      : `<span style="color:#666">${esc(ts)}</span> ${esc(line)}`;
  logLines.push(colored);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (logBox) { logBox.innerHTML = logLines.join('\n'); logBox.scrollTop = logBox.scrollHeight; }
}

function clearLog() { logLines = []; if (logBox) logBox.innerHTML = ''; }

function connectLogStream() {
  const es = new EventSource('/api/admin/logs');
  es.onmessage = (e) => appendLog(e.data);
  es.onerror   = () => {
    appendLog('[WARN] log stream disconnected — reconnecting…');
    setTimeout(connectLogStream, 3000);
    es.close();
  };
}
connectLogStream();

function getCheckedIds() {
  return [...document.querySelectorAll('.job-chk:checked')].map(c => c.dataset.id);
}

function updateSelectionUI() {
  const ids   = getCheckedIds();
  const total = document.querySelectorAll('.job-chk').length;
  const selCount = document.getElementById('selCount');
  const btnSel   = document.getElementById('btnSelectAll');
  const btnNone  = document.getElementById('btnSelectNone');
  const btnDel   = document.getElementById('btnDeleteSelected');
  const chkAll   = document.getElementById('chkAll');
  if (ids.length === 0) {
    if (selCount) selCount.textContent = '';
    if (btnSel)  btnSel.hidden  = false;
    if (btnNone) btnNone.hidden = true;
    if (btnDel)  btnDel.hidden  = true;
    if (chkAll)  { chkAll.checked = false; chkAll.indeterminate = false; }
  } else {
    if (selCount) selCount.textContent = `(${ids.length} selected)`;
    if (btnSel)  btnSel.hidden  = ids.length === total;
    if (btnNone) btnNone.hidden = false;
    if (btnDel)  btnDel.hidden  = false;
    if (chkAll)  { chkAll.checked = ids.length === total; chkAll.indeterminate = ids.length < total; }
  }
}

