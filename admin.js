/* ============================================================
   BookNest — admin area (staff only)
     Analytics : seat usage, busy hours, no-shows, books snapshot
     Members   : search, reset a password, switch an account off
     Wi‑Fi     : the network name + password members see after booking

   All numbers come from the bookings table through staff_analytics()
   in setup.sql, which re-checks the staff password on every call.
   ============================================================ */

let adSub = 'analytics';
let adData = null;          // {bookings, members, newMembers}
let adMembers = [];
let adWifi = null;
let adLoading = false;
let adLoadedAt = 0;
let adError = '';
let adDays = 30;
let adSearch = '';

function adEl(id){ return document.getElementById(id); }

async function adCall(name, args){
  if(!CONFIGURED) return demoRpc(name, args || {});
  const r = await rpc(name, Object.assign({p_pass: staffPass}, args || {}));
  if(r && r.auth) handleAuthLost(r.locked);
  return r;
}

function initAdminUI(){
  document.querySelectorAll('.subtab').forEach(b => b.addEventListener('click', () => {
    adSub = b.dataset.sub;
    renderAdmin();
  }));
  adEl('adminRefresh').addEventListener('click', () => { adLoad(true); });
  adEl('sub-analytics').addEventListener('change', e => {
    if(e.target.id === 'adRange'){ adDays = Number(e.target.value); renderAdmin(); }
  });
  adEl('sub-members').addEventListener('input', e => {
    if(e.target.id === 'adSearch'){ adSearch = e.target.value; adRenderMembersTable(); }
  });
  adEl('sub-members').addEventListener('click', adMembersClick);
  adEl('sub-wifi').addEventListener('click', e => {
    if(e.target.closest('#adWifiSave')) adSaveWifi();
  });
}

/* called by goTab() when the Admin tab is opened */
function adminOpened(){
  if(!isStaff) return;
  adLoad(false);
  renderAdmin();
}

async function adLoad(force){
  if(!isStaff || adLoading) return;
  if(!force && adData && Date.now() - adLoadedAt < 20000) return;
  adLoading = true;
  adError = '';
  renderAdmin();
  try{
    const [a, m, w] = await Promise.all([
      adCall('staff_analytics', {p_days: 60}),
      adCall('staff_members', {}),
      adCall('staff_get_wifi', {})
    ]);
    if(a && a.ok) adData = a;
    if(m && m.ok) adMembers = m.members || [];
    if(w && w.ok) adWifi = {ssid: w.ssid || '', password: w.password || ''};
    adLoadedAt = Date.now();
    if(!(a && a.ok)) adError = 'Could not load the numbers — please sign in again.';
  }catch(e){
    adError = "Couldn't load the admin data. Check your connection, and make sure the new setup.sql has been run in Supabase.";
  }finally{
    adLoading = false;
  }
  renderAdmin();
}

/* ---------- drawing ---------- */
function renderAdmin(){
  const section = adEl('admin');
  if(!section || !section.classList.contains('active') || !isStaff) return;

  document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === adSub));
  ['analytics', 'members', 'wifi'].forEach(k => adEl('sub-' + k).classList.toggle('active', k === adSub));

  const demo = !CONFIGURED
    ? `<div class="demo-banner">Demo mode — sample data. Try logging in as member <strong>S1001</strong> with password <strong>demo1234</strong>, or create your own account. Connect Supabase (see README) for the real thing.</div>`
    : '';

  if(adSub === 'analytics'){
    const host = adEl('sub-analytics');
    if(adError){ host.innerHTML = `<div class="empty">${escapeHtml(adError)}</div>`; return; }
    if(!adData){ host.innerHTML = `<div class="empty">Loading the numbers…</div>`; return; }
    host.innerHTML = demo + adAnalyticsHtml();
  }
  else if(adSub === 'members'){
    const host = adEl('sub-members');
    if(!adLoadedAt){ host.innerHTML = `<div class="empty">${adError ? escapeHtml(adError) : 'Loading members…'}</div>`; return; }
    if(!adEl('adSearch')){
      host.innerHTML = demo + `
        <div class="range-row">
          <input type="search" id="adSearch" placeholder="Search by name or ID" value="${escapeAttr(adSearch)}">
          <span class="count-tag" id="adMemberCount"></span>
        </div>
        <div id="adMembersTable"></div>`;
    }
    adRenderMembersTable();
  }
  else{
    const host = adEl('sub-wifi');
    if(!adWifi){ host.innerHTML = `<div class="empty">${adError ? escapeHtml(adError) : 'Loading…'}</div>`; return; }
    if(!adEl('adWifiSsid')){
      host.innerHTML = demo + `
        <div class="card form-card">
          <h4>Library Wi‑Fi</h4>
          <p class="sub" style="margin:0">Members see these details on their dashboard only while they hold a seat. Change the password here whenever you change it on the router.</p>
          <label for="adWifiSsid">Network name</label>
          <input type="text" id="adWifiSsid" maxlength="60" placeholder="e.g. BookNest-Guest" value="${escapeAttr(adWifi ? adWifi.ssid : '')}">
          <label for="adWifiPass">Password</label>
          <input type="text" id="adWifiPass" maxlength="100" placeholder="Wi‑Fi password" autocomplete="off" value="${escapeAttr(adWifi ? adWifi.password : '')}">
          <div><button class="btn" id="adWifiSave">Save Wi‑Fi details</button></div>
        </div>
        <p class="hint" style="margin-top:12px">Walk-in visitors you seat yourself don't get this automatically — tell them the details above.</p>`;
    }
  }
}

function adAnalyticsHtml(){
  const rows = adData.bookings;              // [member, seat, status, booked, arrived, ended]
  const DAY = 86400000;
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const today = sod.getTime();
  const since = today - (adDays - 1) * DAY;
  const inRange = rows.filter(r => r[3] >= since);
  const now = Date.now();

  /* headline numbers */
  const bookedToday = rows.filter(r => r[3] >= today).length;
  const booked7 = rows.filter(r => r[3] >= today - 6 * DAY).length;
  const done = inRange.filter(r => r[2] === 'completed' && r[4] && r[5]);
  const avgMin = done.length ? done.reduce((a, r) => a + (r[5] - r[4]) / 60000, 0) / done.length : 0;
  const resolved = inRange.filter(r => r[2] === 'completed' || r[2] === 'active' || r[2] === 'expired');
  const noShow = resolved.length ? Math.round(inRange.filter(r => r[2] === 'expired').length / resolved.length * 100) : 0;

  /* live seats */
  const total = seats.length;
  const held = seats.filter(s => s.occupant && s.reservedUntil).length;
  const used = seats.filter(s => s.occupant && !s.reservedUntil).length;
  const free = total - held - used;
  const occPct = total ? Math.round((held + used) / total * 100) : 0;

  /* per day, last 14 days */
  const perDay = [];
  for(let i = 13; i >= 0; i--){
    const start = today - i * DAY;
    const n = rows.filter(r => r[3] >= start && r[3] < start + DAY).length;
    const d = new Date(start);
    perDay.push({label: String(d.getDate()), value: n, text: n ? String(n) : '',
                 title: d.toLocaleDateString(undefined, {weekday:'long', day:'numeric', month:'short'}) + ': ' + n});
  }

  /* busy hours + weekdays */
  const hours = new Array(24).fill(0), wk = new Array(7).fill(0);
  inRange.forEach(r => { const d = new Date(r[3]); hours[d.getHours()]++; wk[(d.getDay() + 6) % 7]++; });
  const peakH = hours.indexOf(Math.max(...hours));
  const hourItems = hours.map((v, h) => ({
    label: h % 3 === 0 ? String(h) : '', value: v, text: String(v),
    title: `${String(h).padStart(2, '0')}:00 – ${String((h + 1) % 24).padStart(2, '0')}:00: ${v} bookings`
  }));
  const wkNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const wkItems = wk.map((v, i) => ({label: wkNames[i], value: v, text: v ? String(v) : ''}));

  /* zones, outcomes, top seats, top members */
  const quiet = inRange.filter(r => r[1] <= 50).length, group = inRange.length - quiet;
  const count = st => inRange.filter(r => r[2] === st).length;
  const outcomes = [
    {name: 'Completed', value: count('completed')},
    {name: 'In seat now', value: count('active') + count('held')},
    {name: 'No-show', value: count('expired')},
    {name: 'Cancelled', value: count('cancelled')}
  ];
  const tally = (idx) => {
    const m = {}; inRange.forEach(r => { m[r[idx]] = (m[r[idx]] || 0) + 1; });
    return Object.keys(m).map(k => ({key: k, value: m[k]})).sort((a, b) => b.value - a.value).slice(0, 5);
  };
  const nameOf = id => { const m = adMembers.find(x => String(x.id) === String(id)); return m ? m.name : 'Member #' + id; };
  const topSeats = tally(1).map(x => ({name: 'Seat ' + x.key, value: x.value}));
  const topMembers = tally(0).map(x => ({name: nameOf(x.key), value: x.value}));

  /* books + today */
  const avail = books.filter(b => b.available).length;
  const out = books.filter(b => !b.available).length;
  const late = books.filter(b => isOverdue(b)).length;
  const cats = {}; books.forEach(b => { const c = (b.category || 'Uncategorised').trim() || 'Uncategorised'; cats[c] = (cats[c] || 0) + 1; });
  const topCats = Object.keys(cats).map(k => ({name: k, value: cats[k]})).sort((a, b) => b.value - a.value).slice(0, 5);
  const checkedToday = attendance.filter(a => a.date === todayStr()).length;
  const lostOpen = lostFound.filter(i => !i.found).length;

  const kpi = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;

  return `
    <div class="range-row">
      <label for="adRange" class="sub" style="margin:0">Show</label>
      <select id="adRange" aria-label="Date range">
        ${[7, 30, 60].map(d => `<option value="${d}" ${d === adDays ? 'selected' : ''}>Last ${d} days</option>`).join('')}
      </select>
      <span class="count-tag">${inRange.length} bookings</span>
    </div>

    <div class="kpi-grid">
      ${kpi(`${held + used}<span style="font-size:1rem;color:var(--muted)"> / ${total}</span>`, 'Seats in use now')}
      ${kpi(bookedToday, 'Bookings today')}
      ${kpi(booked7, 'Bookings, 7 days')}
      ${kpi(done.length ? fmtMins(avgMin) : '—', 'Average visit')}
      ${kpi(resolved.length ? noShow + '%' : '—', 'No-show rate')}
      ${kpi(`${adData.members}${adData.newMembers ? `<span style="font-size:.85rem;color:var(--muted)"> +${adData.newMembers} this week</span>` : ''}`, 'Members')}
    </div>

    <div class="chart-grid">
      <div class="card wide">
        <h4>Bookings per day — last 14 days</h4>
        ${barsHtml(perDay)}
      </div>

      <div class="card">
        <h4>Busiest hours</h4>
        ${Math.max(...hours) ? barsHtml(hourItems, {dense: true, peak: peakH}) : '<p class="sub" style="margin:0">No bookings in this range.</p>'}
        ${Math.max(...hours) ? `<p class="sub" style="margin:12px 0 0">Peak: <strong>${String(peakH).padStart(2, '0')}:00–${String((peakH + 1) % 24).padStart(2, '0')}:00</strong> (${hours[peakH]} bookings)</p>` : ''}
      </div>

      <div class="card">
        <h4>By day of the week</h4>
        ${barsHtml(wkItems)}
      </div>

      <div class="card">
        <h4>Right now</h4>
        <div class="ring-wrap">
          <div class="ring" style="--p:${occPct}"><span>${occPct}%</span></div>
          <div class="legend-list">
            <div><b>${used}</b> seated</div>
            <div><b>${held}</b> on hold</div>
            <div><b>${free}</b> free</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h4>Booking outcomes</h4>
        ${hrowsHtml(outcomes)}
      </div>

      <div class="card">
        <h4>Quiet zone vs group tables</h4>
        ${hrowsHtml([{name: 'Quiet (1–50)', value: quiet}, {name: 'Group (51–100)', value: group}])}
      </div>

      <div class="card">
        <h4>Most-booked seats</h4>
        ${hrowsHtml(topSeats)}
      </div>

      <div class="card">
        <h4>Most active members</h4>
        ${hrowsHtml(topMembers)}
      </div>

      <div class="card">
        <h4>Books</h4>
        ${hrowsHtml([{name: 'Available', value: avail}, {name: 'Checked out', value: out}, {name: 'Overdue', value: late}])}
        <p class="sub" style="margin:12px 0 6px">By category</p>
        ${hrowsHtml(topCats)}
      </div>

      <div class="card">
        <h4>Today</h4>
        <div class="legend-list">
          <div><b>${checkedToday}</b> marked present by staff</div>
          <div><b>${lostOpen}</b> open lost &amp; found reports</div>
          <div><b>${late}</b> overdue books</div>
        </div>
      </div>
    </div>`;
}

/* ---------- members ---------- */
function adRenderMembersTable(){
  const host = adEl('adMembersTable');
  if(!host) return;
  const q = adSearch.trim().toLowerCase();
  const list = adMembers.filter(m => !q || m.name.toLowerCase().includes(q) || m.memberNo.toLowerCase().includes(q));
  const cnt = adEl('adMemberCount');
  if(cnt) cnt.textContent = list.length === adMembers.length ? `${adMembers.length} members` : `${list.length} of ${adMembers.length}`;
  if(!list.length){
    host.innerHTML = `<div class="empty">${adMembers.length ? 'No members match that search.' : 'No one has created a member account yet.'}</div>`;
    return;
  }
  host.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>ID</th><th>Joined</th><th class="num">Bookings</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(m => `
      <tr>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.memberNo)}</td>
        <td>${new Date(m.created).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}</td>
        <td class="num">${m.bookings}</td>
        <td><span class="status-pill ${m.active ? 'avail' : 'warn'}">${m.active ? 'Active' : 'Switched off'}</span></td>
        <td><div class="inline-actions">
          <button class="btn ghost small" data-act="reset" data-id="${m.id}">Reset password</button>
          <button class="btn ghost small" data-act="toggle" data-id="${m.id}">${m.active ? 'Switch off' : 'Switch on'}</button>
        </div></td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

function adMembersClick(e){
  const b = e.target.closest('[data-act]');
  if(!b) return;
  const m = adMembers.find(x => String(x.id) === b.dataset.id);
  if(!m) return;
  if(b.dataset.act === 'reset') adResetPassword(m);
  else if(b.dataset.act === 'toggle') adToggleMember(m);
}

function adResetPassword(m){
  openFormModal({
    title: 'Reset password',
    sub: `Choose a new password for ${m.name} (${m.memberNo}). They will be logged out everywhere.`,
    body: `<input type="password" id="adNewPass" placeholder="New password (6+ characters)" autocomplete="new-password">`,
    confirmText: 'Reset password',
    onConfirm: async () => {
      const pw = adEl('adNewPass').value;
      if(pw.length < 6){ setFormError('At least 6 characters'); return false; }
      try{
        const r = await adCall('staff_member_reset', {p_id: m.id, p_new: pw});
        if(!r || !r.ok){ if(!(r && r.auth)) setFormError("Couldn't reset the password"); return false; }
      }catch(e){ setFormError("Couldn't reach the server"); return false; }
      showToast(`Password reset for ${m.name}`);
    }
  });
}

async function adToggleMember(m){
  if(m.active && !confirm(`Switch off ${m.name}'s account? They will be logged out and can't book seats.`)) return;
  try{
    const r = await adCall('staff_member_set', {p_id: m.id, p_active: !m.active});
    if(!r || !r.ok){ if(!(r && r.auth)) showToast("Couldn't update the account"); return; }
    showToast(m.active ? `${m.name} switched off` : `${m.name} switched on`);
    adLoad(true);
  }catch(e){ showToast("Couldn't reach the server"); }
}

/* ---------- wi-fi ---------- */
async function adSaveWifi(){
  const ssid = adEl('adWifiSsid').value.trim();
  const pw = adEl('adWifiPass').value;
  try{
    const r = await adCall('staff_set_wifi', {p_ssid: ssid, p_password: pw});
    if(!r || !r.ok){ if(!(r && r.auth)) showToast("Couldn't save the Wi‑Fi details"); return; }
    adWifi = {ssid, password: pw};
    showToast('Wi‑Fi details saved');
  }catch(e){ showToast("Couldn't reach the server"); }
}

/* forget everything when staff sign out */
function adReset(){
  adData = null; adMembers = []; adWifi = null; adLoadedAt = 0; adError = ''; adSearch = '';
  ['sub-analytics', 'sub-members', 'sub-wifi'].forEach(id => { const el = adEl(id); if(el) el.innerHTML = ''; });
}
