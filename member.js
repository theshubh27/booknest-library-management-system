/* ============================================================
   BookNest — member accounts, seat booking, Wi-Fi, personal dashboard

   Members have their own login (member / student ID + password).
   Every rule (one seat per member, who may see the Wi-Fi password,
   hold timers) is enforced by the database functions in setup.sql —
   this file only draws the screens and calls them.

   Until Supabase is set up (config.js), the same calls are answered
   by a small in-memory demo at the bottom of this file, so you can
   try everything straight away. Demo members: S1001 … S1009,
   password demo1234.
   ============================================================ */

let mbUser = null;            // {id, name, memberNo} while a member is logged in
let mbToken = '';             // login token (random, checked by the database)
let mbBookings = [];          // [seat, status, booked, arrived, ended] — newest first
let mbWifi = null;            // {ssid, password} while the member holds a seat
let mbWifiShown = false;
let mbWifiRetry = false;
let mbHadSeat = false;
let mbLoading = false;
const MB_KEY = 'booknest-member';
const MB_HOLD_MIN = 15;

function mbEl(id){ return document.getElementById(id); }
function mbTime(){ return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }

/* ---------- small shared helpers (also used by admin.js) ---------- */
function fmtMins(min){
  min = Math.max(0, Math.round(min));
  if(min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtWhen(ms){
  return new Date(ms).toLocaleString(undefined, {weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
}
/* a simple bar chart made of divs: items = [{label, value, text, title}] */
function barsHtml(items, opts){
  opts = opts || {};
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="bars ${opts.dense ? 'dense' : ''}">` + items.map((it, i) => {
    const h = Math.round(it.value / max * 100);
    const tip = it.title || `${it.label}: ${it.text}`;
    return `<div class="bar ${opts.peak === i ? 'peak' : ''}" title="${escapeAttr(tip)}">
      <div class="col"><b>${escapeHtml(it.text)}</b><i style="height:${h}%"></i></div>
      <span>${escapeHtml(it.label)}</span></div>`;
  }).join('') + '</div>';
}
/* horizontal bars: rows = [{name, value}] */
function hrowsHtml(rows, total){
  const max = Math.max(1, ...rows.map(r => r.value));
  if(!rows.length) return '<p class="sub" style="margin:0">Nothing to show yet.</p>';
  return rows.map(r => `
    <div class="hrow">
      <div class="nm" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</div>
      <div class="track"><div class="fill" style="width:${Math.round(r.value / max * 100)}%"></div></div>
      <div class="ct">${r.value}</div>
    </div>`).join('');
}

/* ---------- login token storage ---------- */
function mbStoreGet(){
  try{ return localStorage.getItem(MB_KEY) || sessionStorage.getItem(MB_KEY) || ''; }catch(e){ return ''; }
}
function mbStoreSet(tok, remember){
  try{
    localStorage.removeItem(MB_KEY); sessionStorage.removeItem(MB_KEY);
    if(tok) (remember ? localStorage : sessionStorage).setItem(MB_KEY, tok);
  }catch(e){}
}

/* ---------- talking to the database (or the demo) ---------- */
async function mbApi(name, args){
  return CONFIGURED ? rpc(name, args) : demoRpc(name, args || {});
}
/* a call made as the logged-in member; if the session is gone, sign out */
async function mbCall(name, args){
  const r = await mbApi(name, Object.assign({p_token: mbToken}, args || {}));
  if(r && r.auth) mbSignedOut('Your session ended — please log in again');
  return r;
}

function mbMySeat(){
  return mbUser ? (seats.find(s => s.memberId === mbUser.id && s.occupant) || null) : null;
}

/* ---------- session ---------- */
function mbSetSession(token, user, remember){
  mbToken = token; mbUser = user;
  mbStoreSet(token, remember);
  applyMemberRole();
}
function mbSignedOut(msg){
  mbUser = null; mbToken = ''; mbBookings = []; mbWifi = null;
  mbWifiShown = false; mbHadSeat = false;
  mbStoreSet('');
  applyMemberRole();
  if(msg) showToast(msg);
}
async function mbSignOut(){
  const t = mbToken;
  mbSignedOut('Logged out');
  if(t){ try{ await mbApi('member_logout', {p_token: t}); }catch(e){} }
}
function applyMemberRole(){
  document.body.classList.toggle('is-member', !!mbUser);
  const btn = mbEl('memberBtn');
  if(btn) btn.textContent = mbUser ? 'Member · Log out' : 'Member login';
  const active = document.querySelector('.tab-btn.active');
  if(active && active.classList.contains('member-only') && !mbUser) goTab('overview');
  renderMember();
  renderSeatHelp();
  renderSeats();
}
async function mbRestore(){
  if(!CONFIGURED) return;
  const tok = mbStoreGet();
  if(!tok) return;
  try{
    const r = await rpc('member_me', {p_token: tok});
    if(r.ok){
      mbToken = tok; mbUser = r.member; mbBookings = r.bookings || [];
      applyMemberRole();
      mbRefresh();
    }else if(r.auth){
      mbStoreSet('');
    }
  }catch(e){ /* offline: they can log in again */ }
}

/* ---------- login / create account ---------- */
function openMemberAuth(mode){
  const reg = mode === 'register';
  openFormModal({
    title: reg ? 'Create your account' : 'Member login',
    sub: reg ? 'Use your library or student ID — you will use it to log in.'
             : 'Log in to book a seat, get the Wi‑Fi password and see your dashboard.',
    body: reg ? `
      <input type="text" id="mbName" placeholder="Full name" autocomplete="name" maxlength="60">
      <input type="text" id="mbNo" placeholder="Member / student ID" autocomplete="username" maxlength="30" autocapitalize="off" spellcheck="false">
      <p class="hint">3–30 letters, numbers, dots, dashes or @.</p>
      <input type="password" id="mbPass" placeholder="Password (6+ characters)" autocomplete="new-password">
      <input type="password" id="mbPass2" placeholder="Repeat password" autocomplete="new-password">`
    : `
      <input type="text" id="mbNo" placeholder="Member / student ID" autocomplete="username" maxlength="30" autocapitalize="off" spellcheck="false">
      <input type="password" id="mbPass" placeholder="Password" autocomplete="current-password">
      <label class="check"><input type="checkbox" id="mbRemember" checked> Keep me logged in on this device</label>`,
    confirmText: reg ? 'Create account' : 'Log in',
    extra: [{
      label: reg ? 'I have an account' : 'Create account',
      cls: 'ghost',
      onClick: () => { setTimeout(() => openMemberAuth(reg ? 'login' : 'register'), 0); }
    }],
    onConfirm: async () => {
      const no = mbEl('mbNo').value.trim();
      const pass = mbEl('mbPass').value;
      let r;
      try{
        if(reg){
          const name = mbEl('mbName').value.trim();
          if(name.length < 2){ setFormError('Enter your full name'); return false; }
          if(!/^[A-Za-z0-9._@-]{3,30}$/.test(no)){ setFormError('ID: 3–30 letters, numbers, . - _ or @'); return false; }
          if(pass.length < 6){ setFormError('Password must be at least 6 characters'); return false; }
          if(pass !== mbEl('mbPass2').value){ setFormError('The two passwords do not match'); return false; }
          r = await mbApi('member_register', {p_member_no: no, p_name: name, p_pass: pass});
        }else{
          if(!no || !pass){ setFormError('Enter your ID and password'); return false; }
          r = await mbApi('member_login', {p_member_no: no, p_pass: pass});
        }
      }catch(e){
        setFormError("Couldn't reach the server — check your connection (and that setup.sql has been run again)");
        return false;
      }
      if(r.locked){ setFormError('Too many wrong attempts. Please try again in 10 minutes.'); return false; }
      if(!r.ok){
        const msg = {
          bad: 'Wrong ID or password',
          disabled: 'This account is switched off — please ask library staff',
          taken: 'That ID is already registered — try logging in',
          busy: 'Too many sign-ups right now — please try again later',
          name: 'Enter your full name',
          id: 'ID: 3–30 letters, numbers, . - _ or @',
          pass: 'Password must be at least 6 characters'
        }[r.error] || 'Something went wrong — please try again';
        setFormError(msg);
        return false;
      }
      const remember = reg ? true : mbEl('mbRemember').checked;
      mbSetSession(r.token, r.member, remember);
      showToast(reg ? `Welcome, ${r.member.name}!` : `Welcome back, ${r.member.name}`);
      goTab('dashboard');
      mbRefresh();
    }
  });
}

/* ---------- booking ---------- */
function memberSeatClick(num){
  if(!mbUser){
    showToast('Log in as a member to book a seat');
    openMemberAuth('login');
    return;
  }
  const s = seats.find(x => x.number === num);
  const mine = mbMySeat();
  if(s && s.occupant){
    if(mine && mine.number === num) goTab('dashboard');
    else showToast(`Seat ${num} is taken`);
    return;
  }
  if(mine){ showToast(`You already have seat ${mine.number} — release it first`); return; }
  openBookSeat(num);
}
function openBookSeat(num){
  openFormModal({
    title: `Book seat ${num}`,
    sub: num <= 50 ? 'Quiet zone' : 'Group tables',
    body: `<p style="margin:0 0 16px;font-size:.9rem;">We'll hold it for <strong>${MB_HOLD_MIN} minutes</strong>. Scan the QR code on the seat when you arrive to confirm it — otherwise it goes back to everyone else. Your Wi‑Fi password appears on your dashboard as soon as it's booked.</p>`,
    confirmText: 'Book seat',
    onConfirm: () => mbBook(num, true)
  });
}
async function mbBook(num, fromModal){
  const fail = msg => { if(fromModal) setFormError(msg); else showToast(msg); return false; };
  let r;
  try{
    r = await mbCall('member_book_seat', {p_seat: num, p_hold: MB_HOLD_MIN, p_time: mbTime()});
  }catch(e){
    return fail("Couldn't book — check your connection");
  }
  if(r && r.auth) return true;                      // signed out; mbCall already told them
  if(!r || !r.ok){
    if(r && (r.error === 'taken' || r.error === 'already')){ if(CONFIGURED) syncFromServer(); }
    return fail({
      taken: 'Someone just took that seat — please pick another.',
      already: `You already have seat ${r && r.seat}. Release it first.`,
      not_ready: "Seat booking isn't ready yet — ask library staff to log in once to set it up.",
      bad_seat: 'That seat does not exist.'
    }[r && r.error] || "Couldn't book that seat — please try again.");
  }
  await memberAfterChange();
  goTab('dashboard');
  showToast(`Seat ${num} is yours for ${MB_HOLD_MIN} min — Wi‑Fi details are below`);
  return true;
}
async function mbBookFromPick(){
  const sel = mbEl('mbSeatPick');
  const n = Number(sel && sel.value);
  if(!n){ showToast('Choose a seat first'); return; }
  await mbBook(n, false);
}
async function mbRelease(){
  const mine = mbMySeat();
  if(!mine) return;
  if(!confirm(`Release seat ${mine.number}? Someone else will be able to take it.`)) return;
  try{
    const r = await mbCall('member_release_seat', {p_time: mbTime()});
    if(r && r.auth) return;
    showToast(r && r.ok ? `Seat ${mine.number} released` : 'You do not have a seat to release');
  }catch(e){
    showToast("Couldn't release — check your connection");
    return;
  }
  mbWifi = null; mbWifiShown = false;
  await memberAfterChange();
}
/* called after anything that changes a member's seat (also by script.js after a QR check-in) */
async function memberAfterChange(){
  if(CONFIGURED) await syncFromServer();
  await mbRefresh();
}

/* ---------- loading the member's own data ---------- */
async function mbRefresh(){
  if(!mbUser || mbLoading) return;
  mbLoading = true;
  try{
    const r = await mbCall('member_me', {});
    if(r && r.ok){ mbUser = r.member; mbBookings = r.bookings || []; }
    if(mbToken){
      const w = await mbCall('member_wifi', {});
      mbWifi = (w && w.ok) ? {ssid: w.ssid || '', password: w.password || ''} : null;
    }
  }catch(e){ /* keep showing what we have */ }
  finally{ mbLoading = false; }
  renderMember();
  renderSeatHelp();
}
function dashOpened(){ mbRefresh(); }

/* ---------- screens ---------- */
function renderSeatHelp(){
  const el = mbEl('seatHelp');
  if(!el) return;
  const mine = mbMySeat();
  let t = '';
  if(mbUser && mine) t = `You have seat ${mine.number}. Your Wi‑Fi details are on your dashboard.`;
  else if(mbUser) t = `Tap a free seat to book it — we hold it for ${MB_HOLD_MIN} minutes.`;
  else if(!isStaff) t = 'Log in as a member to book a seat and get the Wi‑Fi password.';
  el.textContent = t;
  el.style.display = t ? '' : 'none';
}

function mbStats(rows){
  const now = Date.now();
  const sess = rows.filter(r => r[3]);                         // sessions that actually started
  const dur = r => Math.max(0, (r[4] || now) - r[3]);
  const total = sess.reduce((a, r) => a + dur(r), 0);
  const counts = {};
  sess.forEach(r => { counts[r[0]] = (counts[r[0]] || 0) + 1; });
  let fav = null, best = 0;
  Object.keys(counts).forEach(k => { if(counts[k] > best){ best = counts[k]; fav = k; } });
  const days = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    days.push({start: d.getTime(), mins: 0, label: d.toLocaleDateString(undefined, {weekday:'short'})});
  }
  sess.forEach(r => {
    for(let i = days.length - 1; i >= 0; i--){
      if(r[3] >= days[i].start){ days[i].mins += dur(r) / 60000; break; }
    }
  });
  return {
    visits: sess.length,
    totalMin: Math.round(total / 60000),
    avgMin: sess.length ? Math.round(total / 60000 / sess.length) : 0,
    fav, noShows: rows.filter(r => r[1] === 'expired').length, days
  };
}

const MB_PILL = {
  completed: ['avail', 'Completed'],
  active:    ['out',   'In seat'],
  held:      ['out',   'Held'],
  expired:   ['warn',  'No-show'],
  cancelled: ['muted', 'Cancelled']
};

function renderMember(){
  const host = mbEl('dashBody');
  if(!host) return;
  if(!mbUser){
    host.innerHTML = `<div class="empty">Log in as a member to see your seat, the Wi‑Fi password and your study history.</div>`;
    return;
  }
  const keepPick = (mbEl('mbSeatPick') || {}).value;
  const mine = mbMySeat();
  const st = mbStats(mbBookings);
  const zone = n => n <= 50 ? 'Quiet zone' : 'Group tables';

  /* seat card */
  let seatCard;
  if(mine && mine.reservedUntil){
    const ms = mine.reservedUntil - Date.now();
    seatCard = `<h4>Your seat</h4>
      <div class="seat-line">
        <div class="big-seat">${mine.number}<small>${zone(mine.number)}</small></div>
        <div class="hold-timer ${ms <= 60000 ? 'urgent' : ''}" id="mbHold">${formatCountdown(ms)}<small>Held for you</small></div>
      </div>
      <p class="sub">Scan the QR code on the seat when you arrive to confirm it. If you don't, it is released when the timer ends.</p>
      <div class="btn-row">
        <button class="btn" data-act="scan">Scan QR to confirm</button>
        <button class="btn ghost" data-act="release">Release seat</button>
      </div>`;
  }else if(mine){
    seatCard = `<h4>Your seat</h4>
      <div class="seat-line">
        <div class="big-seat">${mine.number}<small>${zone(mine.number)}</small></div>
        <span class="status-pill avail">Checked in${mine.since ? ' · ' + escapeHtml(mine.since) : ''}</span>
      </div>
      <p class="sub">Enjoy your session. Please release the seat when you leave so someone else can use it.</p>
      <div class="btn-row"><button class="btn ghost" data-act="release">I'm leaving — release seat</button></div>`;
  }else{
    const free = seats.filter(s => !s.occupant);
    const opt = s => `<option value="${s.number}">Seat ${s.number}</option>`;
    seatCard = `<h4>Book a seat</h4>
      <p class="sub">${free.length} of ${seats.length} seats are free. Pick one here or tap it on the Seating tab — we hold it for ${MB_HOLD_MIN} minutes while you get there.</p>` +
      (free.length ? `<div class="book-pick">
        <select id="mbSeatPick" aria-label="Choose a seat">
          <optgroup label="Quiet zone">${free.filter(s => s.number <= 50).map(opt).join('')}</optgroup>
          <optgroup label="Group tables">${free.filter(s => s.number > 50).map(opt).join('')}</optgroup>
        </select>
        <button class="btn" data-act="book">Book seat</button>
      </div>` : `<div class="empty">Every seat is taken right now.</div>`);
  }

  /* wi-fi card */
  let wifiCard;
  if(!mine){
    wifiCard = `<h4>Wi‑Fi</h4>
      <div class="wifi-locked">
        <div class="lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
        Book a seat to unlock the library Wi‑Fi password.
      </div>`;
  }else if(mbWifi && (mbWifi.ssid || mbWifi.password)){
    wifiCard = `<h4>Wi‑Fi</h4>
      <div class="wifi-row">
        <div><div class="k">Network</div><div class="v">${escapeHtml(mbWifi.ssid || '—')}</div></div>
        <div class="btns"><button class="btn ghost small" data-act="copy" data-val="${escapeAttr(mbWifi.ssid)}">Copy</button></div>
      </div>
      <div class="wifi-row">
        <div><div class="k">Password</div><div class="v">${mbWifiShown ? escapeHtml(mbWifi.password || '—') : '••••••••••'}</div></div>
        <div class="btns">
          <button class="btn ghost small" data-act="reveal">${mbWifiShown ? 'Hide' : 'Show'}</button>
          <button class="btn ghost small" data-act="copy" data-val="${escapeAttr(mbWifi.password)}">Copy</button>
        </div>
      </div>
      <p class="sub" style="margin:8px 0 0">Only for members with a booked seat — please don't share it.</p>`;
  }else if(mbWifi){
    wifiCard = `<h4>Wi‑Fi</h4><div class="wifi-locked">Wi‑Fi details haven't been added yet — please ask library staff.</div>`;
  }else{
    wifiCard = `<h4>Wi‑Fi</h4><div class="wifi-locked">Loading Wi‑Fi details…</div>`;
    if(!mbWifiRetry){ mbWifiRetry = true; setTimeout(() => { mbWifiRetry = false; mbRefresh(); }, 3000); }
  }

  /* history */
  const hist = mbBookings.slice(0, 10).map(r => {
    const [seatNo, status, booked, arrived, ended] = r;
    const p = MB_PILL[status] || ['muted', status];
    const d = arrived ? fmtMins(((ended || Date.now()) - arrived) / 60000) : '—';
    return `<tr><td>${escapeHtml(fmtWhen(booked))}</td><td>Seat ${seatNo}</td><td class="num">${d}</td><td><span class="status-pill ${p[0]}">${p[1]}</span></td></tr>`;
  }).join('');

  host.innerHTML = `
    <div class="dash-hello">
      <h3>Hi, ${escapeHtml(mbUser.name)}</h3>
      <span class="chip">ID ${escapeHtml(mbUser.memberNo)}</span>
    </div>

    <div class="dash-grid">
      <div class="card">${seatCard}</div>
      <div class="card">${wifiCard}</div>
    </div>

    <div class="stat-row">
      <div class="stat"><div class="n">${st.visits}</div><div class="l">Visits</div></div>
      <div class="stat"><div class="n">${fmtMins(st.totalMin)}</div><div class="l">Time studied</div></div>
      <div class="stat"><div class="n">${st.visits ? fmtMins(st.avgMin) : '—'}</div><div class="l">Average visit</div></div>
      <div class="stat"><div class="n">${st.fav ? 'Seat ' + st.fav : '—'}</div><div class="l">Favourite seat</div></div>
      <div class="stat"><div class="n">${st.noShows}</div><div class="l">Missed holds</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h4>Your week</h4>
      ${barsHtml(st.days.map(d => ({label: d.label, value: d.mins, text: d.mins ? fmtMins(d.mins) : '', title: `${d.label}: ${fmtMins(d.mins)}`})))}
    </div>

    <div class="card">
      <h4>Recent bookings</h4>
      ${hist ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Seat</th><th class="num">Time in seat</th><th>Status</th></tr></thead>
        <tbody>${hist}</tbody></table></div>`
        : `<div class="empty">No bookings yet — pick a seat above to get started.</div>`}
    </div>`;

  const pick = mbEl('mbSeatPick');
  if(pick && keepPick && [...pick.options].some(o => o.value === keepPick)) pick.value = keepPick;
}

function mbCopy(text){
  const fallback = () => {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try{ document.execCommand('copy'); showToast('Copied'); }catch(e){ showToast("Couldn't copy"); }
    t.remove();
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => showToast('Copied'), fallback);
  }else fallback();
}

/* runs every second (from tickSeats in script.js) */
function mbTick(){
  if(!mbUser) return;
  const mine = mbMySeat();
  const has = !!mine;
  if(mbHadSeat && !has){ mbHadSeat = false; mbRefresh(); }     // hold ran out, or staff freed it
  mbHadSeat = has;
  const el = mbEl('mbHold');
  if(el && mine && mine.reservedUntil){
    const ms = mine.reservedUntil - Date.now();
    el.firstChild.nodeValue = formatCountdown(ms);
    el.classList.toggle('urgent', ms <= 60000);
  }
}

function initMemberUI(){
  mbEl('memberBtn').addEventListener('click', () => {
    if(mbUser) mbSignOut(); else openMemberAuth('login');
  });
  mbEl('dashRefresh').addEventListener('click', () => { mbRefresh(); showToast('Refreshed'); });
  mbEl('dashBody').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if(!b) return;
    const act = b.dataset.act;
    if(act === 'book') mbBookFromPick();
    else if(act === 'release') mbRelease();
    else if(act === 'scan'){ const m = mbMySeat(); if(m) openScanner(m.number); }
    else if(act === 'reveal'){ mbWifiShown = !mbWifiShown; renderMember(); }
    else if(act === 'copy') mbCopy(b.dataset.val || '');
  });
  setInterval(() => {
    if(mbUser && mbEl('dashboard').classList.contains('active')) mbRefresh();
  }, 20000);
  renderSeatHelp();
}

/* ============================================================
   In-memory demo backend (used only while config.js is not filled in).
   It answers the same calls the database functions do.
   ============================================================ */
const DEMO = {
  members: [], bookings: [], sessions: {}, nextId: 1, seeded: false,
  wifi: {ssid: 'BookNest-Guest', password: 'quietpages2026'}
};
function demoRand(seed){
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function demoSeed(){
  if(DEMO.seeded) return;
  DEMO.seeded = true;
  const names = ['Aarav Menon','Diya Kapoor','Rohan Iyer','Meera Nair','Kabir Shah','Anaya Das','Vihaan Rao','Isha Verma','Devesh Rao'];
  names.forEach((n, i) => DEMO.members.push({
    id: i + 1, name: n, memberNo: 'S' + (1001 + i), pass: 'demo1234', active: true,
    created: Date.now() - (45 - i * 4) * 86400000
  }));
  DEMO.nextId = names.length + 1;
  const rnd = demoRand(42);
  const weights = [1,2,4,5,4,2,2,3,4,5,5,4,2,1];               // hours 8 … 21
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pickHour = () => { let x = rnd() * wsum, i = 0; while(x > weights[i]){ x -= weights[i]; i++; } return 8 + i; };
  for(let d = 29; d >= 0; d--){
    const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const n = Math.round((weekend ? 3 : 9) + rnd() * (weekend ? 4 : 8));
    for(let k = 0; k < n; k++){
      const booked = day.getTime() + pickHour() * 3600000 + Math.floor(rnd() * 3600000);
      if(booked > Date.now() - 3600000) continue;
      const seat = (rnd() < 0.4 ? 50 : 0) + 1 + Math.floor(Math.pow(rnd(), 1.6) * 50);
      const m = 1 + Math.floor(rnd() * DEMO.members.length);
      const roll = rnd();
      const b = {m, seat, status: 'completed', booked, heldUntil: booked + 15 * 60000, arrived: null, ended: null};
      if(roll < 0.10){ b.status = 'expired'; b.ended = b.heldUntil; }
      else if(roll < 0.16){ b.status = 'cancelled'; b.ended = booked + 120000; }
      else{
        b.arrived = booked + (3 + Math.floor(rnd() * 9)) * 60000;
        b.ended = b.arrived + (30 + Math.floor(rnd() * 180)) * 60000;
      }
      DEMO.bookings.push(b);
    }
  }
}
/* same housekeeping as bn_sweep() in setup.sql */
function demoSweep(){
  const now = Date.now();
  seats.forEach(s => {
    if(s.reservedUntil && s.reservedUntil <= now){
      s.occupant = null; s.since = null; s.reservedUntil = null; s.memberId = null;
    }
  });
  DEMO.bookings.forEach(b => {
    if(b.status !== 'held' && b.status !== 'active') return;
    const s = seats.find(x => x.number === b.seat);
    const mine = !!(s && s.occupant && s.memberId === b.m);
    if(b.status === 'held' && mine && !s.reservedUntil){ b.status = 'active'; b.arrived = now; }
    else if(!mine){
      if(b.status === 'active'){ b.status = 'completed'; b.ended = now; }
      else if(b.heldUntil <= now){ b.status = 'expired'; b.ended = b.heldUntil; }
      else{ b.status = 'cancelled'; b.ended = now; }
    }
  });
}
async function demoRpc(name, a){
  demoSeed();
  demoSweep();
  const me = () => {
    const id = DEMO.sessions[a.p_token];
    return id ? DEMO.members.find(x => x.id === id && x.active) || null : null;
  };
  const pub = m => ({id: m.id, name: m.name, memberNo: m.memberNo});
  const newTok = m => {
    const t = 'demo' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    DEMO.sessions[t] = m.id;
    return t;
  };
  const rowsOf = list => list.slice().sort((x, y) => y.booked - x.booked)
    .map(b => [b.seat, b.status, b.booked, b.arrived, b.ended]);

  switch(name){
    case 'member_register': {
      const no = String(a.p_member_no || '').trim(), nm = String(a.p_name || '').trim(), pw = String(a.p_pass || '');
      if(nm.length < 2 || nm.length > 60) return {ok: false, error: 'name'};
      if(!/^[A-Za-z0-9._@-]{3,30}$/.test(no)) return {ok: false, error: 'id'};
      if(pw.length < 6) return {ok: false, error: 'pass'};
      if(DEMO.members.some(x => x.memberNo.toLowerCase() === no.toLowerCase())) return {ok: false, error: 'taken'};
      const m = {id: DEMO.nextId++, name: nm, memberNo: no, pass: pw, active: true, created: Date.now()};
      DEMO.members.push(m);
      return {ok: true, token: newTok(m), member: pub(m)};
    }
    case 'member_login': {
      const m = DEMO.members.find(x => x.memberNo.toLowerCase() === String(a.p_member_no || '').trim().toLowerCase());
      if(!m || m.pass !== a.p_pass) return {ok: false, error: 'bad'};
      if(!m.active) return {ok: false, error: 'disabled'};
      return {ok: true, token: newTok(m), member: pub(m)};
    }
    case 'member_logout': delete DEMO.sessions[a.p_token]; return {ok: true};
    case 'member_me': {
      const m = me(); if(!m) return {ok: false, auth: true};
      return {ok: true, member: pub(m), bookings: rowsOf(DEMO.bookings.filter(b => b.m === m.id)).slice(0, 200)};
    }
    case 'member_book_seat': {
      const m = me(); if(!m) return {ok: false, auth: true};
      const n = Number(a.p_seat), s = seats.find(x => x.number === n);
      if(!s) return {ok: false, error: 'bad_seat'};
      const cur = seats.find(x => x.memberId === m.id && x.occupant);
      if(cur) return {ok: false, error: 'already', seat: cur.number};
      if(s.occupant) return {ok: false, error: 'taken'};
      const hold = Math.max(5, Math.min(30, a.p_hold || 15));
      s.occupant = m.name; s.since = null; s.reservedUntil = Date.now() + hold * 60000; s.memberId = m.id;
      DEMO.bookings.push({m: m.id, seat: n, status: 'held', booked: Date.now(), heldUntil: s.reservedUntil, arrived: null, ended: null});
      logActivity(`${m.name} booked seat ${n} for ${hold} min`);
      renderAll();
      return {ok: true, seat: n, reservedUntil: s.reservedUntil};
    }
    case 'member_release_seat': {
      const m = me(); if(!m) return {ok: false, auth: true};
      const s = seats.find(x => x.memberId === m.id && x.occupant);
      if(!s) return {ok: false, error: 'no_seat'};
      const n = s.number;
      s.occupant = null; s.since = null; s.reservedUntil = null; s.memberId = null;
      demoSweep();
      logActivity(`${m.name} left seat ${n}`);
      renderAll();
      return {ok: true, seat: n};
    }
    case 'member_wifi': {
      const m = me(); if(!m) return {ok: false, auth: true};
      if(!seats.some(x => x.memberId === m.id && x.occupant)) return {ok: false, error: 'no_seat'};
      return {ok: true, ssid: DEMO.wifi.ssid, password: DEMO.wifi.password};
    }
    case 'expire_holds': return {ok: true};

    /* staff side (no password check in the demo) */
    case 'staff_analytics': {
      const since = Date.now() - Math.max(1, Math.min(120, a.p_days || 30)) * 86400000;
      const rows = DEMO.bookings.filter(b => b.booked >= since)
        .sort((x, y) => y.booked - x.booked)
        .map(b => [b.m, b.seat, b.status, b.booked, b.arrived, b.ended]);
      return {ok: true, bookings: rows, members: DEMO.members.length,
              newMembers: DEMO.members.filter(x => x.created > Date.now() - 7 * 86400000).length};
    }
    case 'staff_members':
      return {ok: true, members: DEMO.members.slice().sort((x, y) => y.created - x.created).map(m => {
        const mine = DEMO.bookings.filter(b => b.m === m.id);
        return {id: m.id, name: m.name, memberNo: m.memberNo, active: m.active, created: m.created,
                bookings: mine.length, last: mine.length ? Math.max(...mine.map(b => b.booked)) : null};
      })};
    case 'staff_member_set': {
      const m = DEMO.members.find(x => x.id === a.p_id);
      if(m){
        m.active = !!a.p_active;
        if(!m.active) Object.keys(DEMO.sessions).forEach(t => { if(DEMO.sessions[t] === m.id) delete DEMO.sessions[t]; });
      }
      return {ok: true};
    }
    case 'staff_member_reset': {
      if(String(a.p_new || '').length < 6) return {ok: false, error: 'pass'};
      const m = DEMO.members.find(x => x.id === a.p_id);
      if(m){
        m.pass = a.p_new;
        Object.keys(DEMO.sessions).forEach(t => { if(DEMO.sessions[t] === m.id) delete DEMO.sessions[t]; });
      }
      return {ok: true};
    }
    case 'staff_get_wifi': return {ok: true, ssid: DEMO.wifi.ssid, password: DEMO.wifi.password};
    case 'staff_set_wifi': DEMO.wifi = {ssid: a.p_ssid || '', password: a.p_password || ''}; return {ok: true};
  }
  return {ok: false, error: 'unknown'};
}
