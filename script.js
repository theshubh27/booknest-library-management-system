/* ============================================================
   BookNest — app logic
   Data lives in a free Supabase database, so every device sees the
   same books, seats, attendance and lost & found in near real time.
   Visitors can look around; members log in to book a seat; staff
   sign in with a password to make changes.
   (Member screens: member.js · Admin screens: admin.js)
   Changes are versioned: if two people save at the same moment,
   the second one is asked to try again instead of overwriting.
   ============================================================ */

const SEAT_COUNT = 100;
let books = [];
let seats = [];
let attendance = [];
let activity = [];
let lostFound = [];
let notices = [];

/* ---------- shared storage layer (Supabase — free hosted database) ---------- */
const CFG = window.BOOKNEST_CONFIG || {};
const SB_URL = String(CFG.supabaseUrl || '').trim().replace(/\/+$/, '');
const SB_KEY = String(CFG.supabaseKey || '').trim();
const CONFIGURED = /^(https:\/\/.+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(SB_URL)
                   && SB_KEY !== '' && !/PASTE/i.test(SB_URL + SB_KEY);
const KEYS = ['books','seats','attendance','activity','lostFound','notices'];   // everyone can read
const versions = {};      // last version we saw on the server, per collection
const epochs = {};        // bumped on conflict so stale queued saves are dropped
const saveQueue = {};     // saves are sent one at a time per collection
let pendingSaves = 0;     // saves currently being sent
let queuedSaves = 0;      // saves waiting to be sent OR being sent (counted from the moment of the edit)
let silentSave = false;   // true for automatic saves (e.g. expiring reservations)
let lastServerVersions = {};

/* who is using the site: visitors can look, signed-in staff can change things */
let isStaff = !CONFIGURED;   // not set up yet = local demo where everything works in memory
let staffPass = '';
const SESSION_KEY = 'booknest-staff';
function storeGet(){
  try{ return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || ''; }catch(e){ return ''; }
}
function storeSet(pass, remember){
  try{
    localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY);
    if(pass) (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, pass);
  }catch(e){}
}

function sb(path, options){
  options = options || {};
  return fetch(SB_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    headers: {'apikey': SB_KEY, 'Content-Type': 'application/json'},
    body: options.body,
    cache: 'no-store'
  });
}
async function rpc(name, args){
  const res = await sb('rpc/' + name, {method: 'POST', body: JSON.stringify(args)});
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function setStatus(ok, text){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  el.classList.toggle('offline', !ok);
  el.querySelector('.label').textContent = text || (ok ? 'Live · shared with everyone' : 'Offline — reconnecting…');
}

function setCollection(key, value){
  const v = Array.isArray(value) ? value : null;
  switch(key){
    case 'books': books = v || defaultBooks(); break;
    case 'seats': seats = v || defaultSeats(); break;
    case 'attendance': attendance = v || []; break;
    case 'activity': activity = v || []; break;
    case 'lostFound': lostFound = v || []; break;
    case 'notices': notices = v || []; break;
  }
}
function getCollection(key){
  return {books, seats, attendance, activity, lostFound, notices}[key];
}

function saveJSON(key, value){
  if(!CONFIGURED || !isStaff) return;     // visitors can't save; unconfigured = in-memory demo
  const silent = silentSave;
  const body = JSON.stringify(value);
  const epoch = epochs[key] || 0;
  queuedSaves++;           // from now until it is sent, don't let a refresh overwrite this edit
  saveQueue[key] = (saveQueue[key] || Promise.resolve())
    .then(() => (epochs[key] || 0) === epoch ? pushKey(key, body, silent) : null)
    .catch(() => {})       // never let one failed save block the saves after it
    .then(() => { queuedSaves--; });
}

async function pushKey(key, body, silent){
  pendingSaves++;
  try{
    const res = await sb('rpc/save_collection', {
      method: 'POST',
      body: `{"p_key":"${key}","p_version":${versions[key] || 0},"p_value":${body},"p_pass":${JSON.stringify(staffPass)}}`
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if(j.auth){ handleAuthLost(j.locked); return; }
    if(!j.ok){
      // someone else saved first: take their version, drop our stale change
      versions[key] = j.version;
      epochs[key] = (epochs[key] || 0) + 1;
      setCollection(key, j.value);
      afterRemoteChange([key]);
      if(!silent) showToast('Someone else just updated this — please try again');
      setStatus(true);
      return;
    }
    versions[key] = j.version;
    setStatus(true);
  }catch(e){
    setStatus(false);
    if(!silent) showToast("Couldn't save — check your connection");
  }finally{
    pendingSaves--;
  }
}

function afterRemoteChange(changedKeys){
  if(changedKeys.includes('seats') && modalSeatNum !== null){
    closeSeatModal();
    showToast('That seat was just updated by someone else');
  }
  renderAll();
}

async function syncFromServer(){
  if(!CONFIGURED){ setStatus(false, 'Setup needed — see README'); return null; }
  if(pendingSaves + queuedSaves > 0) return null;
  try{
    // 1) cheap check: just the version numbers
    const r1 = await sb('booknest_data?select=key,version');
    if(!r1.ok) throw new Error('HTTP ' + r1.status);
    const rows = await r1.json();
    const serverVersions = {};
    rows.forEach(r => { serverVersions[r.key] = r.version; });
    lastServerVersions = serverVersions;
    // 2) download only the collections that changed
    const stale = KEYS.filter(k => (serverVersions[k] || 0) > (versions[k] || 0));
    let fresh = [];
    if(stale.length){
      const r2 = await sb(`booknest_data?select=key,value,version&key=in.(${stale.join(',')})`);
      if(!r2.ok) throw new Error('HTTP ' + r2.status);
      fresh = await r2.json();
    }
    if(pendingSaves + queuedSaves > 0) return null;       // an edit was made while we were fetching
    const changed = [];
    fresh.forEach(row => {
      if(row.version > (versions[row.key] || 0)){
        versions[row.key] = row.version;
        setCollection(row.key, row.value);
        changed.push(row.key);
      }
    });
    setStatus(true);
    if(changed.length) afterRemoteChange(changed);
    return {versions: serverVersions};
  }catch(e){
    setStatus(false);
    return null;
  }
}

/* ---------- staff sign-in ---------- */
function applyRole(){
  document.body.classList.toggle('is-staff', isStaff);
  const btn = document.getElementById('staffBtn');
  if(btn){
    btn.hidden = !CONFIGURED;
    btn.textContent = isStaff ? 'Staff · Sign out' : 'Staff login';
  }
  const active = document.querySelector('.tab-btn.active');
  if(!isStaff && active && active.classList.contains('staff-only')) goTab('overview');
  renderSeatHelp();
  renderAll();
}

function staffSignedOut(message){
  isStaff = false;
  staffPass = '';
  storeSet('');
  adReset();
  KEYS.forEach(k => { versions[k] = 0; });   // reload everything as a visitor
  applyRole();
  syncFromServer();
  if(message) showToast(message);
}
function handleAuthLost(locked){
  staffSignedOut(locked ? 'Too many wrong passwords — try again in 10 minutes'
                        : 'Staff session ended — please sign in again');
}

function seedEmptyCollections(){
  // very first staff sign-in on a new database: store the starter data so everyone shares it
  silentSave = true;
  KEYS.forEach(k => { if(!((lastServerVersions[k] || 0) > 0)) saveJSON(k, getCollection(k)); });
  silentSave = false;
}

async function loadAll(){
  KEYS.forEach(k => setCollection(k, null));   // show the app instantly with defaults
  initMemberUI();
  initAdminUI();
  applyRole();
  if(CONFIGURED){
    const saved = storeGet();
    if(saved){
      try{
        const r = await rpc('staff_login', {p_pass: saved});
        if(r.ok){ isStaff = true; staffPass = saved; }
        else if(!r.locked){ storeSet(''); }      // password was changed: forget the old one
      }catch(e){ /* offline: carry on as a visitor */ }
      applyRole();
    }
  }
  const payload = await syncFromServer();
  if(payload && isStaff) seedEmptyCollections();
  await mbRestore();
  tickSeats();
  setInterval(syncFromServer, 3000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) syncFromServer(); });
}

function defaultBooks(){
  return [
    {id:1, title:"The Silent Patient", author:"Alex Michaelides", category:"Thriller", shelf:"A1", available:true, dueDate:null, borrower:null},
    {id:2, title:"Sapiens", author:"Yuval Noah Harari", category:"History", shelf:"B2", available:false, dueDate:addDays(-2), borrower:"Meera Nair"},
    {id:3, title:"Atomic Habits", author:"James Clear", category:"Self-help", shelf:"C1", available:true, dueDate:null, borrower:null},
    {id:4, title:"The Midnight Library", author:"Matt Haig", category:"Fiction", shelf:"A3", available:true, dueDate:null, borrower:null},
    {id:5, title:"Educated", author:"Tara Westover", category:"Memoir", shelf:"D2", available:false, dueDate:addDays(4), borrower:"Devesh Rao"},
  ];
}
function defaultSeats(){
  const arr = [];
  for(let i=1;i<=SEAT_COUNT;i++) arr.push({number:i, occupant:null, since:null, reservedUntil:null});
  return arr;
}

function saveBooks(){ saveJSON('books', books); }
function saveSeats(){ saveJSON('seats', seats); }
function saveAttendance(){ saveJSON('attendance', attendance); }
function saveActivity(){ saveJSON('activity', activity); }
function saveLostFound(){ saveJSON('lostFound', lostFound); }
function saveNotices(){ saveJSON('notices', notices); }

function localISO(d){
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function addDays(n){
  const d = new Date();
  d.setDate(d.getDate()+n);
  return localISO(d);
}
function todayISO(){ return localISO(new Date()); }
function todayStr(){ return new Date().toLocaleDateString(); }
function isOverdue(book){ return !book.available && book.dueDate && book.dueDate < todayISO(); }
const SEAT_CODE_PREFIX = 'BOOKNEST-SEAT-';
function seatCode(num){ return SEAT_CODE_PREFIX + num; }
async function confirmArrival(num){
  const seat = seats.find(s=>s.number===num);
  if(!seat || !seat.reservedUntil) return false;
  const since = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if(CONFIGURED && !isStaff){
    // visitors can't edit seats directly; the server only lets them confirm a held seat
    try{
      const r = await rpc('confirm_arrival', {p_number: num, p_since: since});
      await syncFromServer();
      mbRefresh();
      return !!r.ok;
    }catch(e){ return false; }
  }
  seat.reservedUntil = null;
  seat.since = since;
  saveSeats();
  logActivity(`${seat.occupant} arrived and took seat ${num}`);
  renderSeats(); populateSeatSelect(); renderOverview();
  if(CONFIGURED) mbRefresh(); else demoRpc('expire_holds', {}).then(mbRefresh);
  return true;
}
function formatCountdown(ms){
  const total = Math.max(0, Math.ceil(ms/1000));
  const m = Math.floor(total/60);
  const s = total%60;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function logActivity(text){
  if(CONFIGURED && !isStaff) return;     // only staff write to the shared activity feed
  activity.unshift({text, time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})});
  activity = activity.slice(0,30);
  saveActivity();
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.remove('show'), 1800);
}

function renderAll(){
  renderOverview();
  renderNotices();
  renderBooks();
  renderSeats();
  populateSeatSelect();
  renderAttendance();
  renderLostFound();
  renderMember();
  renderAdmin();
}

/* ---------- OVERVIEW ---------- */
function renderOverview(){
  document.getElementById('ovBooks').textContent = books.filter(b=>b.available).length;
  document.getElementById('ovSeats').textContent = seats.filter(s=>!s.occupant).length;
  document.getElementById('ovAtt').textContent = attendance.filter(a=>a.date===todayStr()).length;

  const list = document.getElementById('activityList');
  const empty = document.getElementById('activityEmpty');
  if(activity.length===0){
    list.innerHTML=''; empty.style.display='block'; return;
  }
  empty.style.display='none';
  list.innerHTML = activity.slice(0,12).map(a=>`
    <div class="activity-item">
      <span class="dot"></span>
      <span class="txt">${escapeHtml(a.text)}</span>
      <span class="time">${a.time}</span>
    </div>
  `).join('');
}

/* ---------- BOOKS ---------- */
function categoryList(){
  return [...new Set(books.map(b=>(b.category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}
function refreshCategoryOptions(){
  const sel = document.getElementById('bookCategory');
  const cats = categoryList();
  const hasNone = books.some(b=>!(b.category||'').trim());
  const current = sel.value || 'all';
  sel.innerHTML = `<option value="all">All categories</option>`
    + cats.map(c=>`<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('')
    + (hasNone && cats.length ? `<option value="__none">Uncategorised</option>` : '');
  sel.value = [...sel.options].some(o=>o.value===current) ? current : 'all';
  document.getElementById('categoryOptions').innerHTML =
    cats.map(c=>`<option value="${escapeAttr(c)}"></option>`).join('');
}

function renderBooks(){
  refreshCategoryOptions();
  const search = document.getElementById('bookSearch').value.trim().toLowerCase();
  const filter = document.getElementById('bookFilter').value;
  const category = document.getElementById('bookCategory').value;
  const sort = document.getElementById('bookSort').value;
  const list = document.getElementById('bookList');

  let shown = books.filter(b=>{
    const cat = (b.category||'').trim();
    const hay = [b.title, b.author, cat, b.shelf, isStaff ? b.borrower : ''].join(' ').toLowerCase();
    const late = isOverdue(b);
    const matchesFilter = filter==='all'
      || (filter==='available' && b.available)
      || (filter==='out' && !b.available)
      || (filter==='late' && late);
    const matchesCategory = category==='all' || (category==='__none' ? !cat : cat===category);
    return hay.includes(search) && matchesFilter && matchesCategory;
  });

  shown.sort((a,b)=>{
    if(sort==='title') return (a.title||'').localeCompare(b.title||'');
    if(sort==='author') return (a.author||'').localeCompare(b.author||'');
    if(sort==='category') return (a.category||'~').localeCompare(b.category||'~') || (a.title||'').localeCompare(b.title||'');
    if(sort==='status') return (a.available===b.available)?0:(a.available?-1:1);
    return 0;
  });

  document.getElementById('bookCount').textContent =
    shown.length===books.length ? `${books.length} titles` : `${shown.length} of ${books.length} titles`;

  if(shown.length===0){
    list.innerHTML = `<div class="empty">No books match. Try a different search or filter.</div>`;
    return;
  }

  list.innerHTML = shown.map(b=>{
    const late = isOverdue(b);
    let rowClass = b.available ? '' : (late ? 'overdue' : 'out');
    let pill = b.available ? `<span class="status-pill avail">Available</span>`
      : late ? `<span class="status-pill late">Overdue</span>`
      : `<span class="status-pill out">Checked out</span>`;
    let dueLine = (!b.available && b.dueDate) ? `<div class="due ${late?'late':''}">Due ${formatDate(b.dueDate)}${late?' — overdue':''}</div>` : '';
    let borrowerLine = (!b.available && b.borrower) ? `<div class="meta">Held by ${escapeHtml(b.borrower)}</div>` : '';
    const tags = [(b.category||'').trim(), b.shelf ? 'Shelf ' + b.shelf : '']
      .filter(Boolean).map(t=>`<span class="chip">${escapeHtml(t)}</span>`).join('');
    return `
    <div class="book-row ${rowClass}">
      <div class="info">
        <div class="title">${escapeHtml(b.title)}</div>
        <div class="meta">${escapeHtml(b.author||'')}</div>
        ${tags ? `<div class="chips">${tags}</div>` : ''}
        ${borrowerLine}
        ${dueLine}
      </div>
      ${pill}
      <div class="row-actions staff-only">
        <button class="btn ghost" data-toggle="${b.id}">${b.available?'Check out':'Return'}</button>
        <button class="btn ghost small" data-edit-book="${b.id}">Edit</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      openBookModal(Number(btn.dataset.toggle));
    });
  });
  list.querySelectorAll('[data-edit-book]').forEach(btn=>{
    btn.addEventListener('click', ()=> openEditBook(Number(btn.dataset.editBook)));
  });
}
function formatDate(iso){
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
}

function openBookModal(id){
  const book = books.find(b=>b.id===id);
  const overlay = document.getElementById('bookModalOverlay');
  const title = document.getElementById('bookModalTitle');
  const sub = document.getElementById('bookModalSub');
  const body = document.getElementById('bookModalBody');
  const actions = document.getElementById('bookModalActions');

  if(book.available){
    title.textContent = 'Check out';
    sub.textContent = `"${book.title}" — who's taking it?`;
    body.innerHTML = `<input type="text" id="borrowerNameInput" placeholder="Borrower's name">`;
    actions.innerHTML = `
      <button class="btn ghost" id="bookModalCancel">Cancel</button>
      <button class="btn" id="bookModalConfirm">Check out</button>`;
    const input = document.getElementById('borrowerNameInput');
    input.addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('bookModalConfirm').click(); });
    document.getElementById('bookModalConfirm').addEventListener('click', ()=>{
      const name = input.value.trim();
      if(!name){ showToast('Enter a name first'); return; }
      book.available = false;
      book.dueDate = addDays(7);
      book.borrower = name;
      saveBooks();
      logActivity(`"${book.title}" was checked out to ${name}`);
      renderBooks(); renderOverview();
      closeBookModal();
      showToast(`Checked out to ${name}`);
    });
    setTimeout(()=>input.focus(), 50);
  }else{
    title.textContent = 'Return';
    sub.textContent = `"${book.title}" is currently held by ${book.borrower || 'someone unnamed'}.`;
    body.innerHTML = book.dueDate ? `<p style="margin:0 0 4px;font-size:.9rem;">Due ${formatDate(book.dueDate)}${isOverdue(book)?' — overdue':''}.</p>` : '';
    actions.innerHTML = `
      <button class="btn ghost" id="bookModalCancel">Cancel</button>
      <button class="btn" id="bookModalConfirm">Mark returned</button>`;
    document.getElementById('bookModalConfirm').addEventListener('click', ()=>{
      const who = book.borrower;
      book.available = true;
      book.dueDate = null;
      book.borrower = null;
      saveBooks();
      logActivity(`"${book.title}" was returned${who?(' by '+who):''}`);
      renderBooks(); renderOverview();
      closeBookModal();
      showToast('Marked as returned');
    });
  }
  document.getElementById('bookModalCancel').addEventListener('click', closeBookModal);
  overlay.classList.add('open');
}
function closeBookModal(){ document.getElementById('bookModalOverlay').classList.remove('open'); }
document.getElementById('bookModalOverlay').addEventListener('click', e=>{
  if(e.target.id==='bookModalOverlay') closeBookModal();
});

function openEditBook(id){
  const book = books.find(b=>b.id===id);
  if(!book) return;
  const extra = [];
  if(book.available){
    extra.push({label:'Delete', cls:'danger', onClick: ()=>{
      if(!confirm(`Remove "${book.title}" from the catalogue?`)) return false;
      books = books.filter(b=>b.id!==id);
      saveBooks();
      logActivity(`"${book.title}" was removed from the catalogue`);
      renderBooks(); renderOverview();
      showToast('Book removed');
    }});
  }
  openFormModal({
    title: 'Edit book',
    sub: book.available ? '' : 'This book is checked out, so it can be edited but not deleted.',
    body: `
      <input type="text" id="ebTitle" placeholder="Title" value="${escapeAttr(book.title)}">
      <input type="text" id="ebAuthor" placeholder="Author" value="${escapeAttr(book.author||'')}">
      <input type="text" id="ebCategory" list="categoryOptions" placeholder="Category" value="${escapeAttr(book.category||'')}">
      <input type="text" id="ebShelf" placeholder="Shelf (e.g. A2)" value="${escapeAttr(book.shelf||'')}">`,
    confirmText: 'Save',
    extra,
    onConfirm: ()=>{
      const t = document.getElementById('ebTitle').value.trim();
      if(!t){ setFormError('A title is required'); return false; }
      book.title = t;
      book.author = document.getElementById('ebAuthor').value.trim() || 'Unknown';
      book.category = document.getElementById('ebCategory').value.trim();
      book.shelf = document.getElementById('ebShelf').value.trim();
      saveBooks();
      renderBooks();
      showToast('Book updated');
    }
  });
}

document.getElementById('bookSearch').addEventListener('input', renderBooks);
document.getElementById('bookFilter').addEventListener('change', renderBooks);
document.getElementById('bookCategory').addEventListener('change', renderBooks);
document.getElementById('bookSort').addEventListener('change', renderBooks);
document.getElementById('showAddBook').addEventListener('click', ()=>{
  document.getElementById('addBookForm').classList.toggle('open');
});
document.getElementById('addBookBtn').addEventListener('click', ()=>{
  const t = document.getElementById('newTitle').value.trim();
  const a = document.getElementById('newAuthor').value.trim();
  const c = document.getElementById('newCategory').value.trim();
  const sh = document.getElementById('newShelf').value.trim();
  if(!t){ showToast('Enter a title first'); return; }
  const id = books.length ? Math.max(...books.map(b=>b.id))+1 : 1;
  books.push({id, title:t, author:a||'Unknown', category:c, shelf:sh, available:true, dueDate:null, borrower:null});
  ['newTitle','newAuthor','newCategory','newShelf'].forEach(i=>{ document.getElementById(i).value=''; });
  saveBooks();
  logActivity(`"${t}" was added to the catalogue`);
  renderBooks();
  renderOverview();
  showToast('Book added');
});

/* ---------- SEATS ---------- */
function renderSeats(){
  const quiet = document.getElementById('seatGridQuiet');
  const group = document.getElementById('seatGridGroup');
  const free = seats.filter(s=>!s.occupant).length;
  document.getElementById('seatCount').textContent = `${free} / ${seats.length} free`;

  function seatHtml(s){
    const isQuiet = s.number<=50;
    const isReserved = !!s.reservedUntil;
    const remain = isReserved ? s.reservedUntil - Date.now() : 0;
    const urgent = isReserved && remain<=60000;
    const stateClass = isReserved ? `reserved ${urgent?'urgent':''}` : (s.occupant?'taken':'');
    let sub = '';
    if(isReserved){
      sub = `<div class="occ">${escapeHtml(s.occupant)}</div><div class="countdown">${formatCountdown(remain)}</div>`;
    } else if(s.occupant){
      sub = `<div class="occ">${escapeHtml(s.occupant)}</div>`;
    }
    const mine = mbUser && s.memberId === mbUser.id && s.occupant ? 'mine' : '';
    return `
    <div class="seat ${stateClass} ${isQuiet?'quiet':''} ${mine}" data-seat="${s.number}">
      <div>${s.number}</div>
      ${sub}
    </div>`;
  }
  quiet.innerHTML = seats.filter(s=>s.number<=50).map(seatHtml).join('');
  group.innerHTML = seats.filter(s=>s.number>50).map(seatHtml).join('');

  [quiet, group].forEach(grid=>{
    grid.querySelectorAll('[data-seat]').forEach(el=>{
      el.addEventListener('click', ()=>{
        if(!isStaff){ memberSeatClick(Number(el.dataset.seat)); return; }
        openSeatModal(Number(el.dataset.seat));
      });
    });
  });
}

let modalSeatNum = null;

function openSeatModal(num){
  modalSeatNum = num;
  const seat = seats.find(s=>s.number===num);
  const overlay = document.getElementById('seatModalOverlay');
  const title = document.getElementById('seatModalTitle');
  const sub = document.getElementById('seatModalSub');
  const body = document.getElementById('seatModalBody');
  const actions = document.getElementById('seatModalActions');

  title.textContent = `Seat ${num}`;

  if(seat.reservedUntil){
    const expiryStr = new Date(seat.reservedUntil).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    sub.textContent = `Reserved for ${seat.occupant}`;
    body.innerHTML = `<p style="margin:0 0 14px;font-size:.92rem;">Holds until <strong>${expiryStr}</strong>. When they arrive, scan the QR code taped to the seat to confirm — otherwise it frees up on its own.</p>`;
    actions.innerHTML = `
      <button class="btn ghost" id="modalCancel">Close</button>
      <button class="btn danger" id="modalCancelRes">Cancel reservation</button>
      <button class="btn" id="modalScanBtn">Scan QR to confirm</button>`;
    document.getElementById('modalCancelRes').addEventListener('click', ()=>{
      const who = seat.occupant;
      seat.occupant = null;
      seat.since = null;
      seat.reservedUntil = null;
      seat.memberId = null;
      saveSeats();
      logActivity(`Reservation for seat ${num} (${who}) was cancelled`);
      renderSeats(); populateSeatSelect(); renderOverview();
      closeSeatModal();
      showToast(`Seat ${num} is now free`);
    });
    document.getElementById('modalScanBtn').addEventListener('click', ()=>{
      closeSeatModal();
      openScanner(num);
    });
  }else if(seat.occupant){
    sub.textContent = `Occupied since ${seat.since||'—'}`;
    body.innerHTML = `<p style="margin:0 0 14px;font-size:.92rem;">Currently seated: <strong>${escapeHtml(seat.occupant)}</strong></p>`;
    actions.innerHTML = `
      <button class="btn ghost" id="modalCancel">Close</button>
      <button class="btn danger" id="modalFree">Free seat</button>`;
    document.getElementById('modalFree').addEventListener('click', ()=>{
      const who = seat.occupant;
      seat.occupant = null;
      seat.since = null;
      seat.memberId = null;
      saveSeats();
      logActivity(`Seat ${num} was freed (${who})`);
      renderSeats(); populateSeatSelect(); renderOverview();
      closeSeatModal();
      showToast(`Seat ${num} is now free`);
    });
  }else{
    sub.textContent = 'This seat is free — reserve it for a visitor.';
    body.innerHTML = `
      <input type="text" id="seatNameInput" placeholder="Visitor name">
      <select id="seatDurationInput">
        <option value="5">Hold for 5 minutes</option>
        <option value="10" selected>Hold for 10 minutes</option>
        <option value="15">Hold for 15 minutes</option>
        <option value="0">Seat them now — no timer</option>
      </select>`;
    actions.innerHTML = `
      <button class="btn ghost" id="modalCancel">Cancel</button>
      <button class="btn" id="modalAssign">Reserve seat</button>`;
    const input = document.getElementById('seatNameInput');
    input.addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('modalAssign').click(); });
    document.getElementById('modalAssign').addEventListener('click', ()=>{
      const name = input.value.trim();
      if(!name){ showToast('Enter a name first'); return; }
      const minutes = Number(document.getElementById('seatDurationInput').value);
      seat.occupant = name;
      seat.memberId = null;           // seated by staff, not booked by a member
      if(minutes>0){
        seat.reservedUntil = Date.now() + minutes*60000;
        seat.since = null;
        logActivity(`${name} reserved seat ${num} for ${minutes} min`);
        showToast(`Seat ${num} held for ${name} — ${minutes} min`);
      }else{
        seat.reservedUntil = null;
        seat.since = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        logActivity(`${name} took seat ${num}`);
        showToast(`${name} seated at ${num}`);
      }
      saveSeats();
      renderSeats(); populateSeatSelect(); renderOverview();
      closeSeatModal();
    });
    setTimeout(()=>input.focus(), 50);
  }
  document.getElementById('modalCancel').addEventListener('click', closeSeatModal);
  overlay.classList.add('open');
}
function closeSeatModal(){
  document.getElementById('seatModalOverlay').classList.remove('open');
  modalSeatNum = null;
}
document.getElementById('seatModalOverlay').addEventListener('click', e=>{
  if(e.target.id==='seatModalOverlay') closeSeatModal();
});

/* ---------- printable seat QR codes ---------- */
function openQrCodesModal(){
  const grid = document.getElementById('qrCodesGrid');
  grid.innerHTML = '';
  seats.forEach(s=>{
    const cell = document.createElement('div');
    cell.className = 'qr-cell';
    const qrBox = document.createElement('div');
    cell.appendChild(qrBox);
    const label = document.createElement('div');
    label.className = 'qr-label';
    label.textContent = `Seat ${s.number}`;
    cell.appendChild(label);
    grid.appendChild(cell);
    if(typeof QRCode !== 'undefined'){
      new QRCode(qrBox, {text: seatCode(s.number), width: 90, height: 90, correctLevel: QRCode.CorrectLevel.M});
    }else{
      qrBox.textContent = seatCode(s.number);
    }
  });
  document.getElementById('qrCodesOverlay').classList.add('open');
}
document.getElementById('showQrCodes').addEventListener('click', openQrCodesModal);
document.getElementById('qrCodesClose').addEventListener('click', ()=>{
  document.getElementById('qrCodesOverlay').classList.remove('open');
});
document.getElementById('qrCodesPrint').addEventListener('click', ()=> window.print());
document.getElementById('qrCodesOverlay').addEventListener('click', e=>{
  if(e.target.id==='qrCodesOverlay') document.getElementById('qrCodesOverlay').classList.remove('open');
});

/* ---------- camera scanner to confirm arrival at a held seat ---------- */
let scanStream = null;
let scanRAF = null;
let scanSeatTarget = null;

function openScanner(num){
  scanSeatTarget = num || null;
  const statusEl = document.getElementById('scanStatus');
  const subEl = document.getElementById('scanSub');
  const manualBtn = document.getElementById('scanManual');
  statusEl.textContent = '';
  if(scanSeatTarget){
    subEl.innerHTML = `Point the camera at the code taped to seat <span id="scanSeatNum">${scanSeatTarget}</span>.`;
    manualBtn.style.display = '';
  }else{
    subEl.textContent = 'Point the camera at the QR code taped to your seat.';
    manualBtn.style.display = 'none';
  }
  document.getElementById('qrScannerOverlay').classList.add('open');

  if(typeof jsQR === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    statusEl.textContent = "Camera scanning isn't available here — use manual confirm below.";
    return;
  }
  navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})
    .then(stream=>{
      scanStream = stream;
      const video = document.getElementById('scanVideo');
      video.srcObject = stream;
      video.play();
      scanRAF = requestAnimationFrame(scanTick);
    })
    .catch(()=>{
      statusEl.textContent = 'Camera access was blocked — use manual confirm below.';
    });
}
document.getElementById('scanCheckinBtn').addEventListener('click', ()=> openScanner(null));

function scanTick(){
  const video = document.getElementById('scanVideo');
  const canvas = document.getElementById('scanCanvas');
  if(video.readyState === video.HAVE_ENOUGH_DATA){
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    if(code){
      handleScanResult(code.data);
      return;
    }
  }
  scanRAF = requestAnimationFrame(scanTick);
}

function handleScanResult(text){
  const statusEl = document.getElementById('scanStatus');

  if(scanSeatTarget){
    // opened from a specific seat's modal — the code must match that seat
    if(text === seatCode(scanSeatTarget)){
      finishScanCheckin(scanSeatTarget, statusEl);
    }else{
      statusEl.textContent = "That code doesn't match this seat — try again.";
      scanRAF = requestAnimationFrame(scanTick);
    }
    return;
  }

  // generic "Scan to check in" — figure out the seat from the code itself
  const m = text.match(new RegExp('^' + SEAT_CODE_PREFIX + '(\\d+)$'));
  if(!m){
    statusEl.textContent = "That's not a seat code from this library — try again.";
    scanRAF = requestAnimationFrame(scanTick);
    return;
  }
  const num = Number(m[1]);
  const seat = seats.find(s=>s.number===num);
  if(!seat || !seat.reservedUntil){
    statusEl.textContent = `Seat ${num} isn't currently on hold — nothing to confirm.`;
    scanRAF = requestAnimationFrame(scanTick);
    return;
  }
  finishScanCheckin(num, statusEl);
}

async function finishScanCheckin(num, statusEl){
  statusEl.textContent = 'Matched — checking in…';
  stopScanner();
  const ok = await confirmArrival(num);
  closeScannerOverlay();
  showToast(ok ? `Checked in at seat ${num}` : `Couldn't check in at seat ${num} — it may have expired`);
}

function stopScanner(){
  if(scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = null;
  if(scanStream){
    scanStream.getTracks().forEach(t=>t.stop());
    scanStream = null;
  }
}

function closeScannerOverlay(){
  document.getElementById('qrScannerOverlay').classList.remove('open');
  scanSeatTarget = null;
}

document.getElementById('scanCancel').addEventListener('click', ()=>{
  stopScanner();
  closeScannerOverlay();
});
document.getElementById('scanManual').addEventListener('click', ()=>{
  const num = scanSeatTarget;
  stopScanner();
  closeScannerOverlay();
  if(num!=null){
    confirmArrival(num);
    showToast(`Seat ${num} confirmed manually`);
  }
});

/* checks every second for reservations whose timer ran out and frees them automatically */
function tickSeats(){
  silentSave = true;
  try{ tickSeatsInner(); } finally{ silentSave = false; }
  mbTick();
}
function tickSeatsInner(){
  const now = Date.now();
  let changed = false;
  let expiredAny = false;
  let expiredNum = null;
  seats.forEach(s=>{
    if(s.reservedUntil && s.reservedUntil<=now){
      logActivity(`Seat ${s.number} reservation for ${s.occupant} expired — seat freed automatically`);
      if(s.number===modalSeatNum) expiredNum = s.number;
      s.occupant = null;
      s.since = null;
      s.reservedUntil = null;
      s.memberId = null;
      changed = true;
      expiredAny = true;
    }
  });
  if(changed){
    saveSeats();
    renderOverview();
    populateSeatSelect();
  }
  // visitors and members can't save, so ask the database to tidy up (it closes member bookings too)
  if(expiredAny && CONFIGURED && !isStaff) askServerToExpire();
  if(document.getElementById('seats').classList.contains('active')){
    renderSeats();
  }
  if(expiredNum!==null){
    closeSeatModal();
    if(scanSeatTarget===expiredNum){
      stopScanner();
      closeScannerOverlay();
    }
    showToast(`Seat ${expiredNum}'s reservation expired — now free`);
  }
}
let lastExpireAsk = 0;
function askServerToExpire(){
  if(Date.now() - lastExpireAsk < 20000) return;
  lastExpireAsk = Date.now();
  rpc('expire_holds', {}).then(() => syncFromServer()).catch(() => {});
}
setInterval(tickSeats, 1000);

/* ---------- ATTENDANCE ---------- */
function populateSeatSelect(){
  const sel = document.getElementById('attSeat');
  const current = sel.value;
  sel.innerHTML = `<option value="">No seat</option>` + seats.map(s=>{
    let label = `Seat ${s.number}`;
    if(s.occupant) label += s.reservedUntil ? ` (reserved: ${s.occupant})` : ` (${s.occupant})`;
    return `<option value="${s.number}">${escapeHtml(label)}</option>`;
  }).join('');
  if(current) sel.value = current;
}

function renderAttendance(){
  const today = todayStr();
  const todays = attendance.filter(a=>a.date===today);
  document.getElementById('attCount').textContent = `${todays.length} today`;

  const body = document.getElementById('attBody');
  const empty = document.getElementById('attEmpty');
  if(todays.length===0){
    body.innerHTML='';
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  body.innerHTML = todays.slice().reverse().map(a=>{
    const realIdx = attendance.indexOf(a);
    return `
    <tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${a.seat?('Seat '+a.seat):'—'}</td>
      <td>${a.time}</td>
      <td><button class="btn ghost small staff-only" data-remove="${realIdx}">Remove</button></td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = Number(btn.dataset.remove);
      attendance.splice(idx,1);
      saveAttendance();
      renderAttendance();
      renderOverview();
    });
  });
}

document.getElementById('checkInBtn').addEventListener('click', ()=>{
  const name = document.getElementById('attName').value.trim();
  if(!name){ showToast('Enter a name first'); return; }
  const seatNum = document.getElementById('attSeat').value;
  const now = new Date();
  attendance.push({
    name,
    seat: seatNum || null,
    time: now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
    date: todayStr()
  });
  document.getElementById('attName').value='';
  saveAttendance();
  logActivity(`${name} marked present${seatNum?(' at seat '+seatNum):''}`);
  renderAttendance();
  renderOverview();
  showToast('Attendance marked');
});
document.getElementById('attName').addEventListener('keydown', e=>{
  if(e.key==='Enter') document.getElementById('checkInBtn').click();
});

/* ---------- LOST & FOUND ---------- */
function renderLostFound(){
  const list = document.getElementById('lfList');
  const empty = document.getElementById('lfEmpty');
  const open = lostFound.filter(i=>!i.found).length;
  document.getElementById('lfCount').textContent = `${open} open`;

  if(lostFound.length===0){
    list.innerHTML='';
    empty.style.display='block';
    return;
  }
  empty.style.display='none';

  // open reports first, most recently reported first within each group
  const order = lostFound.map((item,i)=>i).sort((a,b)=>{
    const ia = lostFound[a], ib = lostFound[b];
    if(ia.found!==ib.found) return ia.found?1:-1;
    return b-a;
  });

  list.innerHTML = order.map(idx=>{
    const item = lostFound[idx];
    const pill = item.found ? `<span class="status-pill avail">Found</span>` : `<span class="status-pill out">Lost</span>`;
    const details = item.details ? `<div class="meta">${escapeHtml(item.details)}</div>` : '';
    return `
    <div class="book-row lf-row ${item.found?'':'out'}">
      <div class="info">
        <div class="title">${escapeHtml(item.item)}</div>
        <div class="meta">Reported by ${escapeHtml(item.name)} · ${item.date}</div>
        ${details}
      </div>
      ${pill}
      <div class="lf-actions staff-only">
        <button class="btn ghost small" data-lf-toggle="${idx}">${item.found?'Reopen':'Mark found'}</button>
        <button class="btn ghost small" data-lf-remove="${idx}">Remove</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-lf-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = Number(btn.dataset.lfToggle);
      const item = lostFound[idx];
      item.found = !item.found;
      saveLostFound();
      logActivity(`"${item.item}" was marked ${item.found?'found':'lost again'}`);
      renderLostFound();
    });
  });
  list.querySelectorAll('[data-lf-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = Number(btn.dataset.lfRemove);
      const item = lostFound[idx];
      lostFound.splice(idx,1);
      saveLostFound();
      logActivity(`Lost & found entry "${item.item}" was removed`);
      renderLostFound();
    });
  });
}

document.getElementById('lfReportBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('lfName').value.trim();
  const itemName = document.getElementById('lfItem').value.trim();
  const details = document.getElementById('lfDetails').value.trim();
  if(!name || !itemName){ showToast('Enter your name and the item'); return; }
  const clear = ()=>['lfName','lfItem','lfDetails'].forEach(id=>{ document.getElementById(id).value=''; });
  if(!CONFIGURED){
    lostFound.push({name, item: itemName, details, date: todayStr(), found: false});
    clear(); logActivity(`${name} reported losing "${itemName}"`);
    renderLostFound(); showToast('Lost item reported');
    return;
  }
  try{
    // goes through a server function so visitors can add a report but nothing else
    const r = await rpc('report_lost', {
      p_name: name, p_item: itemName, p_details: details, p_date: todayStr(),
      p_time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    });
    if(!r.ok){
      showToast(r.error==='full' ? 'The lost & found list is full — please ask staff' : 'Enter your name and the item');
      return;
    }
    clear();
    await syncFromServer();
    showToast('Lost item reported');
  }catch(e){
    showToast("Couldn't send — check your connection");
  }
});
['lfName','lfItem','lfDetails'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown', e=>{
    if(e.key==='Enter') document.getElementById('lfReportBtn').click();
  });
});

/* ---------- NAV ---------- */
function goTab(name){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('main > section').forEach(s=>s.classList.toggle('active', s.id===name));
  if(name==='dashboard') dashOpened();
  if(name==='admin') adminOpened();
}
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> goTab(btn.dataset.tab));
});

/* ---------- small pop-up form used for sign-in and editing ---------- */
function openFormModal(opts){
  document.getElementById('fmTitle').textContent = opts.title || '';
  const subEl = document.getElementById('fmSub');
  subEl.textContent = opts.sub || '';
  subEl.style.display = opts.sub ? '' : 'none';
  const body = document.getElementById('fmBody');
  body.innerHTML = opts.body || '';
  setFormError('');
  const actions = document.getElementById('fmActions');
  actions.innerHTML = '';
  const mk = (label, cls, fn)=>{
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  mk('Cancel', 'ghost', closeFormModal);
  (opts.extra || []).forEach(x=> mk(x.label, x.cls || 'ghost', async ()=>{
    const r = await x.onClick();
    if(r !== false) closeFormModal();
  }));
  const ok = mk(opts.confirmText || 'Save', '', async ()=>{
    if(ok.disabled) return;
    ok.disabled = true;
    try{
      const r = await opts.onConfirm();
      if(r !== false) closeFormModal();
    }finally{ ok.disabled = false; }
  });
  body.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); ok.click(); } });
  });
  document.getElementById('formModalOverlay').classList.add('open');
  const first = body.querySelector('input:not([type=checkbox])');
  // focus the first box, unless the person has already clicked into one
  if(first) setTimeout(()=>{ if(!body.contains(document.activeElement)) first.focus(); }, 50);
}
function closeFormModal(){
  document.getElementById('formModalOverlay').classList.remove('open');
  document.getElementById('fmBody').innerHTML = '';     // also clears any typed password
}
function setFormError(msg){
  const e = document.getElementById('fmError');
  e.textContent = msg || '';
  e.style.display = msg ? 'block' : 'none';
}
document.getElementById('formModalOverlay').addEventListener('click', e=>{
  if(e.target.id==='formModalOverlay') closeFormModal();
});

/* ---------- staff login button ---------- */
function openStaffLogin(){
  openFormModal({
    title: 'Staff login',
    sub: 'Staff can add and change records. Visitors can only view.',
    body: `
      <input type="password" id="fmPass" placeholder="Staff password" autocomplete="current-password">
      <label class="check"><input type="checkbox" id="fmRemember"> Keep me signed in on this device</label>`,
    confirmText: 'Sign in',
    onConfirm: async ()=>{
      const pass = document.getElementById('fmPass').value;
      const remember = document.getElementById('fmRemember').checked;
      if(!pass){ setFormError('Enter the staff password'); return false; }
      try{
        const r = await rpc('staff_login', {p_pass: pass});
        if(r.locked){ setFormError('Too many wrong attempts. Please try again in 10 minutes.'); return false; }
        if(!r.ok){ setFormError('Wrong password'); return false; }
        isStaff = true;
        staffPass = pass;
        storeSet(pass, remember);
        applyRole();
        await syncFromServer();
        seedEmptyCollections();
        showToast('Signed in as staff');
      }catch(e){
        setFormError("Couldn't reach the server — check your connection");
        return false;
      }
    }
  });
}
document.getElementById('staffBtn').addEventListener('click', ()=>{
  if(isStaff) staffSignedOut('Signed out');
  else openStaffLogin();
});

/* ---------- NOTICE BOARD ---------- */
function renderNotices(){
  const list = document.getElementById('noticeList');
  const empty = document.getElementById('noticeEmpty');
  const items = notices.slice().sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,10);
  if(items.length===0){ list.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  list.innerHTML = items.map(n=>`
    <div class="notice">
      <div class="info">
        <div class="title">${escapeHtml(n.title||'')}</div>
        ${n.text ? `<div class="meta">${escapeHtml(n.text)}</div>` : ''}
        <div class="meta faint">Posted ${n.date ? formatDate(n.date) : ''}</div>
      </div>
      <button class="btn ghost small staff-only" data-n-remove="${escapeAttr(String(n.id))}">Remove</button>
    </div>`).join('');
  list.querySelectorAll('[data-n-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.nRemove;
      notices = notices.filter(n=>String(n.id)!==id);
      saveNotices();
      renderNotices();
      showToast('Notice removed');
    });
  });
}
document.getElementById('showAddNotice').addEventListener('click', ()=>{
  document.getElementById('addNoticeForm').classList.toggle('open');
});
document.getElementById('addNoticeBtn').addEventListener('click', ()=>{
  const title = document.getElementById('noticeTitle').value.trim();
  const text = document.getElementById('noticeText').value.trim();
  if(!title){ showToast('Write a title for the notice'); return; }
  notices.unshift({id: Date.now() + '' + Math.floor(Math.random()*1000), title, text, date: todayISO(), created: Date.now()});
  notices = notices.slice(0, 30);
  document.getElementById('noticeTitle').value = '';
  document.getElementById('noticeText').value = '';
  saveNotices();
  logActivity(`Notice posted: ${title}`);
  renderNotices();
  renderOverview();
  showToast('Notice posted');
});
['noticeTitle','noticeText'].forEach(id=>{
  document.getElementById(id).addEventListener('keydown', e=>{
    if(e.key==='Enter') document.getElementById('addNoticeBtn').click();
  });
});

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str == null ? '' : str;
  return d.innerHTML;
}
function escapeAttr(str){
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

loadAll();
