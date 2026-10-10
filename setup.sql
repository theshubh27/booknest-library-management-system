-- ============================================================
-- BookNest database setup  (staff login, notice board,
-- lost & found for visitors)
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
  pw text := 'MyLibrary@2026!';
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
  return jsonb_build_object('ok', true);
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

notify pgrst, 'reload schema';
