-- ============================================================
-- BookNest database setup  (staff login, notice board,
-- lost & found, member accounts, seat booking, Wi-Fi, analytics)
--
-- Safe to run again at any time - it also upgrades the first
-- version of BookNest. Re-running with a different password
-- changes the staff password.
--
-- BEFORE YOU RUN IT:
--   Find the line   pw text := 'PUT-YOUR-PASSWORD-HERE';
--   and put your own staff password between the quotes
--   (at least 8 characters, and no apostrophe ' in it).
-- ============================================================

-- remove old functions from earlier versions
drop function if exists public.save_collection(text, integer, jsonb);   -- version 1 (let anyone write)
drop function if exists public.read_members(text, integer);             -- members feature (removed)

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.booknest_data (
  key     text primary key,
  value   jsonb   not null default '[]'::jsonb,
  version integer not null default 0
);
create table if not exists public.booknest_auth (
  id        integer primary key check (id = 1),
  pass_hash text not null
);
create table if not exists public.booknest_attempts (
  id bigserial primary key,
  at timestamptz not null default now()
);

alter table public.booknest_data     enable row level security;
alter table public.booknest_auth     enable row level security;
alter table public.booknest_attempts enable row level security;

-- visitors can read everything (they can never write directly)
drop policy if exists "booknest read" on public.booknest_data;
create policy "booknest read" on public.booknest_data
  for select to anon using (true);

-- members feature was removed: delete any member records saved by an earlier version
delete from public.booknest_data where key = 'members';

revoke all on public.booknest_data, public.booknest_auth, public.booknest_attempts
  from anon, authenticated;
revoke all on sequence public.booknest_attempts_id_seq from anon, authenticated;
grant select on public.booknest_data to anon;

-- ---------- staff password (stored hashed, never in plain text) ----------
do $$
declare
  pw text := 'PUT-YOUR-PASSWORD-HERE';
begin
  if pw = 'PUT-YOUR-PASSWORD-HERE' or length(pw) < 8 then
    raise exception 'Edit this script first: replace PUT-YOUR-PASSWORD-HERE with your own staff password (at least 8 characters).';
  end if;
  insert into public.booknest_auth (id, pass_hash)
  values (1, extensions.crypt(pw, extensions.gen_salt('bf', 10)))
  on conflict (id) do update set pass_hash = excluded.pass_hash;
  delete from public.booknest_attempts;
end $$;

-- ---------- internal helpers (not callable from the website) ----------

-- true = correct password, false = wrong, null = locked out for a while
create or replace function public.bn_is_staff(p_pass text)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
declare h text; fails integer;
begin
  select count(*) into fails from booknest_attempts where at > now() - interval '10 minutes';
  if fails >= 10 then return null; end if;
  select pass_hash into h from booknest_auth where id = 1;
  if h is null or p_pass is null or p_pass = '' then return false; end if;
  if h = crypt(p_pass, h) then return true; end if;
  insert into booknest_attempts default values;
  delete from booknest_attempts where at < now() - interval '1 day';
  return false;
end;
$$;

-- adds one line to the front of the activity feed (keeps the latest 30)
create or replace function public.bn_log(p_text text, p_time text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare a jsonb;
begin
  insert into booknest_data (key, value, version) values ('activity', '[]'::jsonb, 0)
  on conflict (key) do nothing;
  select value into a from booknest_data where key = 'activity' for update;
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into a
  from (
    select x, o from (
      select jsonb_build_object('text', p_text, 'time', p_time) as x, 0::bigint as o
      union all
      select e, ord from jsonb_array_elements(a) with ordinality as t(e, ord)
    ) q order by o limit 30
  ) z;
  update booknest_data set value = a, version = version + 1 where key = 'activity';
end;
$$;

-- ---------- functions the website calls ----------

create or replace function public.staff_login(p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'locked', true); end if;
  return jsonb_build_object('ok', s);
end;
$$;

-- staff only: save one whole collection (with a version check)
create or replace function public.save_collection(p_key text, p_version integer, p_value jsonb, p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean; cur integer; curval jsonb;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;

  if p_key not in ('books','seats','attendance','activity','lostFound','notices') then
    raise exception 'unknown collection';
  end if;
  if jsonb_typeof(p_value) <> 'array' then
    raise exception 'value must be a list';
  end if;
  if length(p_value::text) > 1000000 then
    raise exception 'value too large';
  end if;

  insert into booknest_data (key, value, version) values (p_key, '[]'::jsonb, 0)
  on conflict (key) do nothing;

  select version, value into cur, curval from booknest_data where key = p_key for update;

  if cur <> p_version then
    return jsonb_build_object('ok', false, 'version', cur, 'value', curval);
  end if;

  update booknest_data set value = p_value, version = cur + 1 where key = p_key;
  return jsonb_build_object('ok', true, 'version', cur + 1);
end;
$$;

-- anyone: report a lost item (adds one entry, nothing else can be touched)
create or replace function public.report_lost(p_name text, p_item text, p_details text, p_date text, p_time text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare n text; i text; d text; lf jsonb;
begin
  n := left(btrim(coalesce(p_name, '')), 80);
  i := left(btrim(coalesce(p_item, '')), 120);
  d := left(btrim(coalesce(p_details, '')), 300);
  if n = '' or i = '' then return jsonb_build_object('ok', false, 'error', 'missing'); end if;

  insert into booknest_data (key, value, version) values ('lostFound', '[]'::jsonb, 0)
  on conflict (key) do nothing;
  select value into lf from booknest_data where key = 'lostFound' for update;
  if jsonb_array_length(lf) >= 300 then return jsonb_build_object('ok', false, 'error', 'full'); end if;

  update booknest_data
     set value = lf || jsonb_build_array(jsonb_build_object(
           'name', n, 'item', i, 'details', d,
           'date', left(coalesce(p_date, ''), 30), 'found', false)),
         version = version + 1
   where key = 'lostFound';
  perform public.bn_log(n || ' reported losing "' || i || '"', left(coalesce(p_time, ''), 20));
  return jsonb_build_object('ok', true);
end;
$$;

-- anyone: confirm arrival at a seat that is on hold (used by the QR scan)
create or replace function public.confirm_arrival(p_number integer, p_since text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb; nv jsonb; who text;
begin
  perform public.bn_sweep();
  select value into v from booknest_data where key = 'seats' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no seats'); end if;

  select e->>'occupant' into who
    from jsonb_array_elements(v) as t(e)
   where (e->>'number')::integer = p_number and e->>'reservedUntil' is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not on hold'); end if;

  select coalesce(jsonb_agg(
           case when (e->>'number')::integer = p_number
                then e || jsonb_build_object('reservedUntil', null, 'since', left(coalesce(p_since, ''), 20))
                else e end
           order by ord), '[]'::jsonb)
    into nv
    from jsonb_array_elements(v) with ordinality as t(e, ord);

  update booknest_data set value = nv, version = version + 1 where key = 'seats';
  perform public.bn_log(coalesce(who, 'A visitor') || ' arrived and took seat ' || p_number, left(coalesce(p_since, ''), 20));
  perform public.bn_sweep();      -- turns a member's held booking into an active one
  return jsonb_build_object('ok', true);
end;
$$;

-- ============================================================
-- v5: member accounts, seat booking, Wi-Fi, analytics
-- ============================================================

create table if not exists public.booknest_members (
  id         bigserial primary key,
  member_no  text not null,                       -- the member / student ID they log in with
  name       text not null,
  pass_hash  text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists booknest_members_no_idx on public.booknest_members (lower(member_no));

create table if not exists public.booknest_sessions (
  token_hash text primary key,                    -- sha256 of the login token (the token itself is never stored)
  member_id  bigint not null references public.booknest_members(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists public.booknest_member_attempts (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  member_no text not null
);

create table if not exists public.booknest_bookings (
  id          bigserial primary key,
  member_id   bigint not null references public.booknest_members(id) on delete cascade,
  seat_number integer not null,
  booked_at   timestamptz not null default now(),
  held_until  timestamptz,
  arrived_at  timestamptz,
  ended_at    timestamptz,
  status      text not null default 'held'        -- held | active | completed | expired | cancelled
);
create index if not exists booknest_bookings_member_idx on public.booknest_bookings (member_id, booked_at desc);
create index if not exists booknest_bookings_time_idx   on public.booknest_bookings (booked_at desc);

create table if not exists public.booknest_settings (
  key   text primary key,                         -- 'wifi_ssid', 'wifi_password'
  value text not null
);

alter table public.booknest_members          enable row level security;
alter table public.booknest_sessions         enable row level security;
alter table public.booknest_member_attempts  enable row level security;
alter table public.booknest_bookings         enable row level security;
alter table public.booknest_settings         enable row level security;

-- nothing here is readable or writable directly from the website: only through the functions below
revoke all on public.booknest_members, public.booknest_sessions, public.booknest_member_attempts,
              public.booknest_bookings, public.booknest_settings from anon, authenticated;
revoke all on sequence public.booknest_members_id_seq, public.booknest_member_attempts_id_seq,
                       public.booknest_bookings_id_seq from anon, authenticated;

-- ---------- internal helpers ----------

-- login token -> member id (null if missing, expired, or the member is disabled)
create or replace function public.bn_member_id(p_token text)
returns bigint
language plpgsql security definer
set search_path = public, extensions
as $$
declare m bigint;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select s.member_id into m
    from booknest_sessions s
    join booknest_members mm on mm.id = s.member_id
   where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and s.expires_at > now()
     and mm.active;
  return m;
end;
$$;

create or replace function public.bn_new_session(p_member bigint)
returns text
language plpgsql security definer
set search_path = public, extensions
as $$
declare tok text;
begin
  tok := encode(gen_random_bytes(24), 'hex');
  insert into booknest_sessions (token_hash, member_id, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), p_member, now() + interval '30 days');
  delete from booknest_sessions where expires_at < now();
  return tok;
end;
$$;

-- Housekeeping, run before every member action:
--   * frees seats whose hold timer ran out
--   * frees seats a member forgot to leave (12 hours after arriving)
--   * keeps the bookings table in step with the seating chart
--     (held -> active when the seat is confirmed, anything freed -> completed / expired / cancelled)
create or replace function public.bn_sweep()
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v jsonb; nv jsonb;
  now_ms numeric := extract(epoch from now()) * 1000;
  stale bigint[];
begin
  select array_agg(member_id) into stale
    from booknest_bookings
   where status = 'active' and arrived_at < now() - interval '12 hours';

  select value into v from booknest_data where key = 'seats' for update;
  if not found then return; end if;

  select coalesce(jsonb_agg(
           case
             when (e->>'reservedUntil') is not null and (e->>'reservedUntil')::numeric <= now_ms
               then e || jsonb_build_object('occupant', null, 'since', null, 'reservedUntil', null, 'memberId', null)
             when (e->>'reservedUntil') is null and (e->>'memberId') is not null
                  and stale is not null and (e->>'memberId')::bigint = any(stale)
               then e || jsonb_build_object('occupant', null, 'since', null, 'reservedUntil', null, 'memberId', null)
             else e
           end order by ord), '[]'::jsonb)
    into nv
    from jsonb_array_elements(v) with ordinality as t(e, ord);

  if nv <> v then
    update booknest_data set value = nv, version = version + 1 where key = 'seats';
  end if;

  -- held -> active: the seat was confirmed (timer cleared, still has the member's name on it)
  update booknest_bookings b
     set status = 'active', arrived_at = now()
   where b.status = 'held'
     and exists (select 1 from jsonb_array_elements(nv) e
                  where (e->>'number')::integer = b.seat_number
                    and (e->>'memberId')::bigint = b.member_id
                    and (e->>'occupant') is not null
                    and (e->>'reservedUntil') is null);

  -- open bookings whose seat is no longer theirs: close them
  update booknest_bookings b
     set status = case when b.status = 'active' then 'completed'
                       when b.held_until is not null and b.held_until <= now() then 'expired'
                       else 'cancelled' end,
         ended_at = case when b.status = 'active' then least(now(), b.arrived_at + interval '12 hours')
                         when b.held_until is not null and b.held_until <= now() then b.held_until
                         else now() end
   where b.status in ('held', 'active')
     and not exists (select 1 from jsonb_array_elements(nv) e
                      where (e->>'number')::integer = b.seat_number
                        and (e->>'memberId')::bigint = b.member_id
                        and (e->>'occupant') is not null);
end;
$$;

-- ---------- member accounts ----------

create or replace function public.member_register(p_member_no text, p_name text, p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare mno text; nm text; mid bigint; recent integer; tok text;
begin
  mno := btrim(coalesce(p_member_no, ''));
  nm := btrim(coalesce(p_name, ''));
  if length(nm) < 2 or length(nm) > 60 then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if mno !~ '^[A-Za-z0-9._@-]{3,30}$' then return jsonb_build_object('ok', false, 'error', 'id'); end if;
  if length(coalesce(p_pass, '')) < 6 or length(p_pass) > 72 then return jsonb_build_object('ok', false, 'error', 'pass'); end if;

  select count(*) into recent from booknest_members where created_at > now() - interval '1 hour';
  if recent >= 40 then return jsonb_build_object('ok', false, 'error', 'busy'); end if;

  if exists (select 1 from booknest_members where lower(member_no) = lower(mno)) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  begin
    insert into booknest_members (member_no, name, pass_hash)
    values (mno, nm, crypt(p_pass, gen_salt('bf', 10)))
    returning id into mid;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end;

  tok := public.bn_new_session(mid);
  return jsonb_build_object('ok', true, 'token', tok,
           'member', jsonb_build_object('id', mid, 'name', nm, 'memberNo', mno));
end;
$$;

create or replace function public.member_login(p_member_no text, p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare m record; fails integer; mno text; tok text;
begin
  mno := lower(btrim(coalesce(p_member_no, '')));
  select count(*) into fails from booknest_member_attempts
   where member_no = mno and at > now() - interval '10 minutes';
  if fails >= 8 then return jsonb_build_object('ok', false, 'locked', true); end if;

  select * into m from booknest_members where lower(member_no) = mno;
  if not found or m.pass_hash <> crypt(coalesce(p_pass, ''), m.pass_hash) then
    insert into booknest_member_attempts (member_no) values (left(mno, 40));
    delete from booknest_member_attempts where at < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;
  if not m.active then return jsonb_build_object('ok', false, 'error', 'disabled'); end if;

  tok := public.bn_new_session(m.id);
  return jsonb_build_object('ok', true, 'token', tok,
           'member', jsonb_build_object('id', m.id, 'name', m.name, 'memberNo', m.member_no));
end;
$$;

create or replace function public.member_logout(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if p_token is not null then
    delete from booknest_sessions where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- the member's own details and booking history (last 200 bookings)
create or replace function public.member_me(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare mid bigint; m record; hist jsonb;
begin
  mid := public.bn_member_id(p_token);
  if mid is null then return jsonb_build_object('ok', false, 'auth', true); end if;
  perform public.bn_sweep();
  select name, member_no into m from booknest_members where id = mid;

  select coalesce(jsonb_agg(jsonb_build_array(
           seat_number, status,
           (extract(epoch from booked_at) * 1000)::bigint,
           (extract(epoch from arrived_at) * 1000)::bigint,
           (extract(epoch from ended_at) * 1000)::bigint
         ) order by booked_at desc), '[]'::jsonb)
    into hist
    from (select * from booknest_bookings where member_id = mid order by booked_at desc limit 200) q;

  return jsonb_build_object('ok', true,
           'member', jsonb_build_object('id', mid, 'name', m.name, 'memberNo', m.member_no),
           'bookings', hist);
end;
$$;

-- ---------- booking a seat ----------

create or replace function public.member_book_seat(p_token text, p_seat integer, p_hold integer, p_time text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare mid bigint; mname text; v jsonb; nv jsonb; hold integer; until_ms bigint; cur integer;
begin
  mid := public.bn_member_id(p_token);
  if mid is null then return jsonb_build_object('ok', false, 'auth', true); end if;
  select name into mname from booknest_members where id = mid;
  if p_seat is null or p_seat < 1 or p_seat > 100 then return jsonb_build_object('ok', false, 'error', 'bad_seat'); end if;
  hold := greatest(5, least(coalesce(p_hold, 15), 30));

  perform public.bn_sweep();
  select value into v from booknest_data where key = 'seats' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;

  -- one seat per member
  select (e->>'number')::integer into cur
    from jsonb_array_elements(v) e
   where (e->>'memberId')::bigint = mid and (e->>'occupant') is not null
   limit 1;
  if found then return jsonb_build_object('ok', false, 'error', 'already', 'seat', cur); end if;

  if not exists (select 1 from jsonb_array_elements(v) e where (e->>'number')::integer = p_seat) then
    return jsonb_build_object('ok', false, 'error', 'bad_seat');
  end if;
  if exists (select 1 from jsonb_array_elements(v) e
              where (e->>'number')::integer = p_seat and (e->>'occupant') is not null) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;

  until_ms := (extract(epoch from now()) * 1000)::bigint + hold * 60000;
  select jsonb_agg(
           case when (e->>'number')::integer = p_seat
                then e || jsonb_build_object('occupant', mname, 'since', null, 'reservedUntil', until_ms, 'memberId', mid)
                else e end
           order by ord)
    into nv
    from jsonb_array_elements(v) with ordinality as t(e, ord);

  update booknest_data set value = nv, version = version + 1 where key = 'seats';
  insert into booknest_bookings (member_id, seat_number, held_until)
  values (mid, p_seat, now() + make_interval(mins => hold));
  perform public.bn_log(mname || ' booked seat ' || p_seat || ' for ' || hold || ' min', left(coalesce(p_time, ''), 20));
  return jsonb_build_object('ok', true, 'seat', p_seat, 'reservedUntil', until_ms);
end;
$$;

create or replace function public.member_release_seat(p_token text, p_time text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare mid bigint; mname text; v jsonb; nv jsonb; cur integer;
begin
  mid := public.bn_member_id(p_token);
  if mid is null then return jsonb_build_object('ok', false, 'auth', true); end if;
  select name into mname from booknest_members where id = mid;

  perform public.bn_sweep();
  select value into v from booknest_data where key = 'seats' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_seat'); end if;

  select (e->>'number')::integer into cur
    from jsonb_array_elements(v) e
   where (e->>'memberId')::bigint = mid and (e->>'occupant') is not null
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_seat'); end if;

  select jsonb_agg(
           case when (e->>'number')::integer = cur
                then e || jsonb_build_object('occupant', null, 'since', null, 'reservedUntil', null, 'memberId', null)
                else e end
           order by ord)
    into nv
    from jsonb_array_elements(v) with ordinality as t(e, ord);

  update booknest_data set value = nv, version = version + 1 where key = 'seats';
  perform public.bn_sweep();      -- closes the booking
  perform public.bn_log(mname || ' left seat ' || cur, left(coalesce(p_time, ''), 20));
  return jsonb_build_object('ok', true, 'seat', cur);
end;
$$;

-- Wi-Fi details: only a member who currently has a seat (held or occupied) gets them
create or replace function public.member_wifi(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare mid bigint; v jsonb; ssid text; pw text;
begin
  mid := public.bn_member_id(p_token);
  if mid is null then return jsonb_build_object('ok', false, 'auth', true); end if;
  perform public.bn_sweep();
  select value into v from booknest_data where key = 'seats';
  if v is null or not exists (select 1 from jsonb_array_elements(v) e
                               where (e->>'memberId')::bigint = mid and (e->>'occupant') is not null) then
    return jsonb_build_object('ok', false, 'error', 'no_seat');
  end if;
  select value into ssid from booknest_settings where key = 'wifi_ssid';
  select value into pw   from booknest_settings where key = 'wifi_password';
  return jsonb_build_object('ok', true, 'ssid', ssid, 'password', pw);
end;
$$;

-- anyone may trigger housekeeping (it only does what would happen anyway when a timer runs out)
create or replace function public.expire_holds()
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  perform public.bn_sweep();
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- staff-only: members, Wi-Fi, analytics ----------

create or replace function public.staff_members(p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean; outv jsonb;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'name', m.name, 'memberNo', m.member_no, 'active', m.active,
           'created', (extract(epoch from m.created_at) * 1000)::bigint,
           'bookings', (select count(*) from booknest_bookings b where b.member_id = m.id),
           'last', (select (extract(epoch from max(b.booked_at)) * 1000)::bigint from booknest_bookings b where b.member_id = m.id)
         ) order by m.created_at desc), '[]'::jsonb)
    into outv
    from (select * from booknest_members order by created_at desc limit 500) m;
  return jsonb_build_object('ok', true, 'members', outv);
end;
$$;

create or replace function public.staff_member_set(p_pass text, p_id bigint, p_active boolean)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;
  update booknest_members set active = coalesce(p_active, true) where id = p_id;
  if not coalesce(p_active, true) then delete from booknest_sessions where member_id = p_id; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.staff_member_reset(p_pass text, p_id bigint, p_new text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;
  if length(coalesce(p_new, '')) < 6 or length(p_new) > 72 then return jsonb_build_object('ok', false, 'error', 'pass'); end if;
  update booknest_members set pass_hash = crypt(p_new, gen_salt('bf', 10)) where id = p_id;
  delete from booknest_sessions where member_id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.staff_get_wifi(p_pass text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean; ssid text; pw text;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;
  select value into ssid from booknest_settings where key = 'wifi_ssid';
  select value into pw   from booknest_settings where key = 'wifi_password';
  return jsonb_build_object('ok', true, 'ssid', ssid, 'password', pw);
end;
$$;

create or replace function public.staff_set_wifi(p_pass text, p_ssid text, p_password text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean; a text; b text;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;
  a := left(btrim(coalesce(p_ssid, '')), 60);
  b := left(coalesce(p_password, ''), 100);
  if a = '' then delete from booknest_settings where key = 'wifi_ssid';
  else insert into booknest_settings (key, value) values ('wifi_ssid', a)
       on conflict (key) do update set value = excluded.value; end if;
  if b = '' then delete from booknest_settings where key = 'wifi_password';
  else insert into booknest_settings (key, value) values ('wifi_password', b)
       on conflict (key) do update set value = excluded.value; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- raw booking rows for the admin dashboard: [member, seat, status, booked, arrived, ended] (times in ms)
create or replace function public.staff_analytics(p_pass text, p_days integer)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare s boolean; rows_ jsonb; total integer; fresh integer;
begin
  s := public.bn_is_staff(p_pass);
  if s is null then return jsonb_build_object('ok', false, 'auth', true, 'locked', true); end if;
  if not s then return jsonb_build_object('ok', false, 'auth', true); end if;
  perform public.bn_sweep();

  select coalesce(jsonb_agg(jsonb_build_array(
           member_id, seat_number, status,
           (extract(epoch from booked_at) * 1000)::bigint,
           (extract(epoch from arrived_at) * 1000)::bigint,
           (extract(epoch from ended_at) * 1000)::bigint
         ) order by booked_at desc), '[]'::jsonb)
    into rows_
    from (select * from booknest_bookings
           where booked_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 120)))
           order by booked_at desc limit 5000) q;

  select count(*) into total from booknest_members;
  select count(*) into fresh from booknest_members where created_at > now() - interval '7 days';
  return jsonb_build_object('ok', true, 'bookings', rows_, 'members', total, 'newMembers', fresh);
end;
$$;

-- ---------- who may call what ----------
revoke all on function public.bn_is_staff(text)                          from public, anon, authenticated;
revoke all on function public.bn_log(text, text)                         from public, anon, authenticated;
revoke all on function public.staff_login(text)                          from public, anon, authenticated;
revoke all on function public.save_collection(text, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.report_lost(text, text, text, text, text)  from public, anon, authenticated;
revoke all on function public.confirm_arrival(integer, text)             from public, anon, authenticated;

grant execute on function public.staff_login(text)                          to anon;
grant execute on function public.save_collection(text, integer, jsonb, text) to anon;
grant execute on function public.report_lost(text, text, text, text, text)  to anon;
grant execute on function public.confirm_arrival(integer, text)             to anon;

revoke all on function public.bn_member_id(text)                          from public, anon, authenticated;
revoke all on function public.bn_new_session(bigint)                     from public, anon, authenticated;
revoke all on function public.bn_sweep()                                 from public, anon, authenticated;
revoke all on function public.member_register(text, text, text)          from public, anon, authenticated;
revoke all on function public.member_login(text, text)                   from public, anon, authenticated;
revoke all on function public.member_logout(text)                        from public, anon, authenticated;
revoke all on function public.member_me(text)                            from public, anon, authenticated;
revoke all on function public.member_book_seat(text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.member_release_seat(text, text)            from public, anon, authenticated;
revoke all on function public.member_wifi(text)                          from public, anon, authenticated;
revoke all on function public.expire_holds()                             from public, anon, authenticated;
revoke all on function public.staff_members(text)                        from public, anon, authenticated;
revoke all on function public.staff_member_set(text, bigint, boolean)    from public, anon, authenticated;
revoke all on function public.staff_member_reset(text, bigint, text)     from public, anon, authenticated;
revoke all on function public.staff_get_wifi(text)                       from public, anon, authenticated;
revoke all on function public.staff_set_wifi(text, text, text)           from public, anon, authenticated;
revoke all on function public.staff_analytics(text, integer)             from public, anon, authenticated;

grant execute on function public.member_register(text, text, text)          to anon;
grant execute on function public.member_login(text, text)                   to anon;
grant execute on function public.member_logout(text)                        to anon;
grant execute on function public.member_me(text)                            to anon;
grant execute on function public.member_book_seat(text, integer, integer, text) to anon;
grant execute on function public.member_release_seat(text, text)            to anon;
grant execute on function public.member_wifi(text)                          to anon;
grant execute on function public.expire_holds()                             to anon;
grant execute on function public.staff_members(text)                        to anon;
grant execute on function public.staff_member_set(text, bigint, boolean)    to anon;
grant execute on function public.staff_member_reset(text, bigint, text)     to anon;
grant execute on function public.staff_get_wifi(text)                       to anon;
grant execute on function public.staff_set_wifi(text, text, text)           to anon;
grant execute on function public.staff_analytics(text, integer)             to anon;

notify pgrst, 'reload schema';
