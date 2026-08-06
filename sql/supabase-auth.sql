-- supabase-auth.sql — accounts and cloud projects for Map Studio.
--
-- Paste the whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once: every statement is IF NOT EXISTS or a
-- CREATE OR REPLACE, and the policies are dropped before being recreated.
--
-- WHAT ACTUALLY PROTECTS THE DATA. Not the app. The browser holds a public
-- key (SUPABASE_ANON_KEY in js/config.js) and anyone can read it, so the
-- client cannot be trusted to ask only for its own rows. The policies below
-- are evaluated inside Postgres against auth.uid() — the user id proven by
-- the signed JWT — on every single row of every query. A hostile client
-- asking for `select * from projects` gets back only its own rows, because
-- the database, not the JavaScript, decides.
--
-- This is why RLS must be enabled BEFORE any real data goes in. A table with
-- policies missing is readable by every anonymous visitor on the internet.

-- ---------------------------------------------------------------------------
-- 1. Profiles — one row per user, mirroring auth.users
--
-- auth.users is managed by Supabase and cannot have columns added to it, so
-- anything the app wants to show (display name, avatar colour) lives here.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No INSERT policy on purpose: rows are created by the trigger below, which
-- runs as the definer and bypasses RLS. A client should never be able to
-- invent a profile for an id that has no matching auth.users row.

-- ---------------------------------------------------------------------------
-- 2. Fill a profile automatically when someone signs up
--
-- Microsoft/Azure returns the display name in different claim shapes
-- depending on tenant configuration, so several are tried before falling back
-- to the local part of the email. Without this a new user's list header would
-- read as a blank.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'preferred_username',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Map projects
--
-- NAMED map_projects, NOT projects. `public.projects` is already taken by the
-- AI reports schema (server/sql/schema.sql) — a different table, with a TEXT
-- primary key and a foreign key from `sites` pointing at it. Creating this one
-- as `projects` silently did nothing, because CREATE TABLE IF NOT EXISTS found
-- the existing table and skipped it, and the next statement then failed with
-- `column "owner_id" does not exist`. Both tables share one database; they do
-- not share a name.
--
-- `data` holds the serialised map exactly as js/project/projectState.js
-- produces it. JSONB rather than text so it can be queried later (counting
-- sites, finding projects near a point) without a schema migration.
--
-- The summary columns are denormalised on purpose: the list page draws a row
-- from them without ever fetching `data`, which is the difference between a
-- list that opens instantly and one that downloads megabytes of geometry to
-- show four names.
-- ---------------------------------------------------------------------------

create table if not exists public.map_projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null default 'Untitled map project',
  data        jsonb not null default '{}'::jsonb,
  n_locations integer not null default 0,
  n_sites     integer not null default 0,
  n_routes    integer not null default 0,
  n_shapes    integer not null default 0,
  bytes       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The list's only query: this owner's rows, newest change first.
create index if not exists map_projects_owner_updated_idx
  on public.map_projects (owner_id, updated_at desc);

alter table public.map_projects enable row level security;

-- Four separate policies rather than one FOR ALL, because the checks differ:
-- reading and deleting test the row that exists, while inserting tests the row
-- being created. Rolled into one, an INSERT could name someone else as owner.

drop policy if exists "map_projects: read own" on public.map_projects;
create policy "map_projects: read own"
  on public.map_projects for select
  using (auth.uid() = owner_id);

drop policy if exists "map_projects: insert own" on public.map_projects;
create policy "map_projects: insert own"
  on public.map_projects for insert
  with check (auth.uid() = owner_id);

drop policy if exists "map_projects: update own" on public.map_projects;
create policy "map_projects: update own"
  on public.map_projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "map_projects: delete own" on public.map_projects;
create policy "map_projects: delete own"
  on public.map_projects for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- 4. Keep updated_at honest
--
-- Set in the database rather than by the client, so "last modified" reflects
-- when the row actually changed and cannot be back-dated by a caller.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists map_projects_touch_updated on public.map_projects;
create trigger map_projects_touch_updated
  before update on public.map_projects
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated on public.profiles;
create trigger profiles_touch_updated
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Restrict sign-up to one email domain
--
-- The real gate for Microsoft sign-in is the Entra app registration being
-- single-tenant, which stops other organisations before Supabase is reached.
-- This covers the email/password path as well, and it runs in the database, so
-- unlike the check in js/config.js it cannot be skipped by a modified client.
--
-- Change 'dbotrealty.com', or drop the trigger, to allow other domains.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null and new.email not ilike '%@dbotrealty.com' then
    raise exception 'Sign-up is limited to dbotrealty.com accounts.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_domain_check on auth.users;
create trigger on_auth_user_domain_check
  before insert on auth.users
  for each row execute function public.enforce_email_domain();

-- ---------------------------------------------------------------------------
-- 6. Confirm it worked
--
-- Run this on its own afterwards. Every row must say rls_enabled = true.
-- "Success. No rows returned" from the block above means the objects were
-- created; it does NOT mean they are protected, which is what this checks.
-- ---------------------------------------------------------------------------

-- select tablename,
--        rowsecurity as rls_enabled,
--        (select count(*) from pg_policies p
--          where p.schemaname = 'public' and p.tablename = t.tablename) as policies
--   from pg_tables t
--  where schemaname = 'public' and tablename in ('profiles', 'map_projects');
