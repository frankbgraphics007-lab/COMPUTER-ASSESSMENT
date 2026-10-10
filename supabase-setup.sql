-- =====================================================================
-- Computer Assessment Portal - Supabase setup
-- Run this ONCE: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------
create table if not exists public.assessments (
  id        text primary key,
  meta      jsonb not null,          -- title, year, cat, kind, date, secure, limit, desc, file, link url
  body      text,                    -- HTML exams only (answers already removed)
  path      text,                    -- Storage path for PDF/Word/image files
  created   timestamptz default now()
);
create table if not exists public.exam_keys (   -- the real answers. Students can NEVER read this.
  aid  text primary key,
  data jsonb not null
);
create table if not exists public.class_pw (
  year int primary key,
  hash text not null
);
create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);
insert into public.settings(key,value) values ('links','[]'), ('reveal','false')
  on conflict do nothing;

create table if not exists public.results (
  id        bigint generated always as identity primary key,
  aid       text not null,
  title     text, year int,
  skey      text not null,           -- lower(name|campus|class): one result per student per exam
  name text, cand text, cls text,
  raw numeric, pen numeric, total numeric, max_marks numeric,
  pct int, grade text, tabs int,
  secs jsonb, detail jsonb, log jsonb,
  submitted_at timestamptz default now(),
  unique (aid, skey)
);
create index if not exists results_aid_idx on public.results(aid, submitted_at desc);

create table if not exists public.live (
  sid text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create index if not exists live_upd_idx on public.live(updated_at desc);

-- ---------- row level security ----------
-- Students (anon) get NO direct table access at all. They only use the functions below.
-- Staff (signed-in users) get full access. Turn OFF "Allow new users to sign up" in Auth settings.
alter table public.assessments enable row level security;
alter table public.exam_keys   enable row level security;
alter table public.class_pw    enable row level security;
alter table public.settings    enable row level security;
alter table public.results     enable row level security;
alter table public.live        enable row level security;

do $$ declare t text; begin
  foreach t in array array['assessments','exam_keys','class_pw','settings','results','live'] loop
    execute format('drop policy if exists staff_all on public.%I', t);
    execute format('create policy staff_all on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- functions students can call ----------
-- Portal data: lists assessments (NO files, NO answers), which years are protected, links.
create or replace function public.get_portal() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'a',     coalesce((select jsonb_agg(a.meta || jsonb_build_object('id', a.id) order by a.created) from assessments a), '[]'::jsonb),
    'pw',    coalesce((select jsonb_object_agg(year::text, true) from class_pw), '{}'::jsonb),
    'links', coalesce((select value from settings where key='links'), '[]'::jsonb),
    'reveal', coalesce((select (value)::boolean from settings where key='reveal'), false)
  );
$$;

create or replace function public.check_class(p_year int, p_pw text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  select hash into h from class_pw where year = p_year;
  if h is null then return true; end if;
  return h = extensions.crypt(coalesce(p_pw,''), h);
end $$;

-- Open one assessment (checks the class password on the server).
create or replace function public.open_assessment(p_id text, p_pw text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r assessments; y int;
begin
  select * into r from assessments where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'err', 'notfound'); end if;
  y := (r.meta->>'year')::int;
  if not public.check_class(y, p_pw) then return jsonb_build_object('ok', false, 'err', 'password'); end if;
  return jsonb_build_object('ok', true, 'body', r.body, 'path', r.path);
end $$;

-- Live exam heartbeat. Students can only write whitelisted fields; they get teacher commands back.
create or replace function public.live_patch(p_sid text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f jsonb; d jsonb;
  allowed text[] := array['sid','aid','title','year','name','state','hb','viol','help','ackN','ackT'];
  teacher text[] := array['cmd','cmdN','msg','msgN','warns','msgs'];
begin
  if p_sid is null or length(p_sid) > 80 or length(p::text) > 20000 then return '{}'::jsonb; end if;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into f from jsonb_each(p) t(k, v) where k = any(allowed);
  insert into live(sid, data) values (p_sid, f || jsonb_build_object('sid', p_sid))
  on conflict (sid) do update set data = live.data || f, updated_at = now()
  returning data into d;
  return coalesce((select jsonb_object_agg(k, v) from jsonb_each(d) t(k, v) where k = any(teacher)), '{}'::jsonb);
end $$;

-- Read one live session (used when a student's page reloads in the middle of an exam).
create or replace function public.live_get(p_sid text) returns jsonb
language sql security definer set search_path = public as $$
  select data from live where sid = p_sid;
$$;

-- ---------- functions for staff only ----------
create or replace function public.set_class_pw(p_year int, p_hash text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  insert into class_pw(year, hash) values (p_year, extensions.crypt(p_hash, extensions.gen_salt('bf')))
  on conflict (year) do update set hash = excluded.hash;
end $$;

create or replace function public.clear_class_pw(p_year int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  delete from class_pw where year = p_year;
end $$;

-- Teacher list: students needing attention first, capped so the page stays light.
create or replace function public.live_list() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'total', (select count(*) from live where updated_at > now() - interval '3 minutes'),
    'list', coalesce((select jsonb_agg(data) from (
        select data from live
        where updated_at > now() - interval '12 hours'
        order by (data->>'state' = 'help') desc, (data->>'state' = 'paused') desc,
                 jsonb_array_length(coalesce(data->'viol','[]'::jsonb)) desc, updated_at desc
        limit 150) x), '[]'::jsonb));
end $$;

create or replace function public.live_command(p_sid text, p_cmd text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  update live set data = data || jsonb_build_object('cmd', p_cmd, 'cmdN', coalesce((data->>'cmdN')::int, 0) + 1) where sid = p_sid;
end $$;

create or replace function public.live_message(p_sid text, p_level text, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb; n int; w int; m jsonb; arr jsonb;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select data into d from live where sid = p_sid; if not found then return; end if;
  n := coalesce((d->>'msgN')::int, 0) + 1;
  w := coalesce((d->>'warns')::int, 0) + (case when p_level <> 'notice' then 1 else 0 end);
  m := jsonb_build_object('n', n, 'level', p_level, 'text', p_text, 't', (extract(epoch from now()) * 1000)::bigint, 'w', w);
  arr := coalesce(d->'msgs', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('t', m->'t', 'level', p_level, 'text', p_text));
  if jsonb_array_length(arr) > 12 then
    arr := (select jsonb_agg(v order by o) from jsonb_array_elements(arr) with ordinality t(v, o) where o > jsonb_array_length(arr) - 12);
  end if;
  update live set data = d || jsonb_build_object('msgN', n, 'warns', w, 'msg', m, 'msgs', arr) where sid = p_sid;
end $$;

create or replace function public.live_remove(p_sid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  delete from live where sid = p_sid;
end $$;

-- Lock the functions: students may only call the student ones.
revoke all on function public.set_class_pw(int,text), public.clear_class_pw(int), public.live_list(),
  public.live_command(text,text), public.live_message(text,text,text), public.live_remove(text) from public, anon;
grant execute on function public.set_class_pw(int,text), public.clear_class_pw(int), public.live_list(),
  public.live_command(text,text), public.live_message(text,text,text), public.live_remove(text) to authenticated;
grant execute on function public.get_portal(), public.check_class(int,text), public.open_assessment(text,text),
  public.live_patch(text,jsonb), public.live_get(text) to anon, authenticated;

-- ---------- file storage (PDF, Word, images) ----------
insert into storage.buckets (id, name, public) values ('assessment-files', 'assessment-files', true)
  on conflict (id) do nothing;
drop policy if exists "staff manage files" on storage.objects;
create policy "staff manage files" on storage.objects for all to authenticated
  using (bucket_id = 'assessment-files') with check (bucket_id = 'assessment-files');

-- cleanup of old live sessions (optional): run now and then
-- delete from public.live where updated_at < now() - interval '1 day';
