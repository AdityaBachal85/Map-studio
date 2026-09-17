-- hostinger-mysql.sql — accounts and cloud projects, on Hostinger's MySQL.
--
-- Run this once, in hPanel → Databases → phpMyAdmin → SQL, against the
-- database you created for the app. Safe to run more than once: every
-- statement is CREATE TABLE IF NOT EXISTS.
--
-- ---------------------------------------------------------------------------
-- WHAT PROTECTS THE DATA NOW, AND WHAT USED TO
--
-- This replaces sql/supabase-auth.sql, and the difference matters more than
-- the change of dialect.
--
-- Under Supabase the browser held a public key and talked to the database
-- directly, so the database had to defend itself: Row Level Security policies
-- were evaluated inside Postgres against the user id proven by a signed JWT,
-- on every row of every query. A hostile client asking for `select * from
-- map_projects` got back only its own rows because Postgres, not the
-- JavaScript, decided.
--
-- MySQL has no equivalent of that, and it does not need one here, because the
-- browser no longer talks to the database at all. Every query runs in PHP on
-- the server, from api/, using a credential the browser never sees, and each
-- one carries `where owner_id = :me` where `:me` comes from the session
-- cookie — never from the request body.
--
-- So the ownership check moved from the database into api/lib/projects.php.
-- That is a real transfer of responsibility: under RLS a forgotten WHERE
-- clause returned nothing, and here it would return everybody's rows. The
-- checks in api/ are written knowing that, and diagnostics/accounts-api.cjs
-- asserts it by signing in as two users and having each ask for the other's
-- project.
--
-- The database credential is therefore the whole perimeter. It belongs in
-- api/config.php (or better, one directory above public_html), never in a file
-- the web server will serve, and never in this repository.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Users
--
-- CHAR(36) ids holding canonical UUID text, not an AUTO_INCREMENT integer.
-- Two reasons, and the first is immediate: the accounts already in Supabase
-- are keyed by uuid and are being migrated across (tools/migrate-supabase.js),
-- so a numeric key would mean rewriting every owner_id on the way in and
-- breaking any link anybody has saved. The second is that a sequential id
-- leaks how many accounts exist and lets one be guessed from another.
--
-- `password_hash` is nullable on purpose. A migrated account arrives without
-- one — Supabase stores hashes we cannot read, and inventing a password for
-- somebody is worse than making them set one. A NULL hash cannot be signed
-- into by any password (see api/lib/auth.php); the account is reached through
-- the reset-by-email flow, which proves control of the address.
-- ---------------------------------------------------------------------------

create table if not exists users (
  id             char(36)     not null,
  email          varchar(190) not null,
  password_hash  varchar(255)     null,
  full_name      varchar(190) not null default '',
  avatar_url     varchar(500) not null default '',

  -- 'user' or 'admin'. A string rather than a boolean because the next role
  -- somebody wants is always a third one, and widening a tinyint after the
  -- fact means touching every query that reads it.
  role           varchar(16)  not null default 'user',

  -- 'active' or 'disabled'. Revoking access has to be separable from deleting
  -- the account: someone who leaves the company must stop being able to sign
  -- in TODAY, while their maps stay where they are until somebody decides what
  -- to do with them. Deleting the row takes the maps with it.
  status         varchar(16)  not null default 'active',

  -- Set on an account an administrator created, cleared the moment its owner
  -- chooses their own password. An issued password has been read by at least
  -- two people and has travelled through a chat app; it is a way in, not a
  -- secret, and it should stop working as soon as it has been used once.
  must_change_password tinyint(1) not null default 0,

  -- Who created this account, for the admin log. Nullable and not a foreign
  -- key: the creator may be deleted later, and that must not cascade into the
  -- accounts they set up.
  created_by     char(36)         null,

  -- Last successful sign-in. The one column that answers "is this account
  -- still in use", which is the question asked before revoking anything.
  last_seen_at   datetime         null,

  created_at     datetime     not null default current_timestamp,
  updated_at     datetime     not null default current_timestamp on update current_timestamp,
  primary key (id),
  -- 190, not 255: utf8mb4 is 4 bytes per character and InnoDB's index limit on
  -- older MySQL is 767 bytes, so a unique index on varchar(255) fails to build
  -- on exactly the shared-hosting MySQL versions this is aimed at.
  unique key users_email_uk (email)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Sessions
--
-- Rolled by hand rather than using PHP's own $_SESSION, and that is a
-- deliberate choice about shared hosting specifically.
--
-- PHP's default session handler writes files into a directory that, on a
-- shared plan, it shares with other accounts — and garbage-collects them on
-- whichever `session.gc_maxlifetime` the process happens to run with. The
-- failure mode is being signed out at random intervals with nothing in any log
-- to explain it, which is a miserable thing to debug and a worse thing to live
-- with. A row in our own table expires when we say it expires.
--
-- THE TOKEN IS NOT STORED. `id` is the SHA-256 of the token that went into the
-- cookie, so this table read by somebody who should not have it does not let
-- them sign in as anyone — the same reasoning as storing a password hash
-- rather than a password.
--
-- `csrf` is per-session rather than per-request: a per-request token breaks
-- two tabs of the same app, and the cookie is already SameSite=Lax, so this is
-- the second lock rather than the first.
-- ---------------------------------------------------------------------------

create table if not exists sessions (
  id           char(64)     not null,          -- sha256(token), hex
  user_id      char(36)     not null,
  csrf         char(64)     not null,
  created_at   datetime     not null default current_timestamp,
  last_seen_at datetime     not null default current_timestamp,
  expires_at   datetime     not null,
  user_agent   varchar(255) not null default '',
  ip           varchar(45)  not null default '',
  primary key (id),
  key sessions_user_idx (user_id),
  key sessions_expiry_idx (expires_at),
  constraint sessions_user_fk foreign key (user_id) references users (id) on delete cascade
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Map projects
--
-- NAMED map_projects, keeping the Supabase name, so the migration is a copy
-- rather than a rename and the two can be compared row for row while the
-- cutover is checked.
--
-- `data` holds the serialised map exactly as js/project/projectState.js
-- produces it.
--
-- LONGTEXT RATHER THAN JSON, deliberately. MySQL 8's JSON type is a binary
-- format that reformats on the way in — key order changes, whitespace goes —
-- so what comes out is equivalent to what went in without being identical to
-- it, and MariaDB's JSON is a LONGTEXT with a validity constraint, so the two
-- hosts would not even behave the same way. Nothing in the app queries inside
-- this column; it is written whole and read whole. LONGTEXT returns the exact
-- bytes on every MySQL and MariaDB a Hostinger plan might be running, which is
-- worth more here than a query capability nobody uses.
--
-- The summary columns are denormalised on purpose: the list page draws a row
-- from them without ever fetching `data`, which is the difference between a
-- list that opens instantly and one that downloads megabytes of geometry to
-- show four names.
-- ---------------------------------------------------------------------------

create table if not exists map_projects (
  id          char(36)     not null,
  owner_id    char(36)     not null,
  name        varchar(255) not null default 'Untitled map project',
  place       varchar(255) not null default '',
  data        longtext         null,
  n_locations int          not null default 0,
  n_sites     int          not null default 0,
  n_routes    int          not null default 0,
  n_shapes    int          not null default 0,
  bytes       int          not null default 0,
  created_at  datetime     not null default current_timestamp,
  updated_at  datetime     not null default current_timestamp on update current_timestamp,
  primary key (id),
  -- The list's only query: this owner's rows, newest change first.
  key map_projects_owner_updated_idx (owner_id, updated_at desc),
  constraint map_projects_owner_fk foreign key (owner_id) references users (id) on delete cascade
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Password resets
--
-- Same shape as sessions and for the same reason: the token that goes in the
-- email is not written down, only its hash. Somebody reading this table cannot
-- take over an account with what they find in it.
--
-- `used_at` rather than deleting the row on use, so a link that arrives twice
-- can be told apart from one that was never issued — the first says "that link
-- has already been used", the second says "that link is not valid", and those
-- are different problems for the person reading them.
-- ---------------------------------------------------------------------------

create table if not exists password_resets (
  id         char(64) not null,                -- sha256(token), hex
  user_id    char(36) not null,
  created_at datetime not null default current_timestamp,
  expires_at datetime not null,
  used_at    datetime     null,
  primary key (id),
  key password_resets_user_idx (user_id),
  constraint password_resets_user_fk foreign key (user_id) references users (id) on delete cascade
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Sign-in attempts
--
-- Supabase rate-limited sign-in for us. Nothing does now, so an unprotected
-- endpoint on a public URL would take a password list at whatever rate the
-- plan will serve requests.
--
-- Recorded by email AND by address, and api/lib/auth.php refuses when either
-- is over its limit: by-email alone lets one attacker walk a list of accounts
-- from one machine, and by-address alone lets a distributed attempt through.
--
-- Successful sign-ins are recorded too, with ok = 1, so the table also answers
-- "when did this account last sign in, and from where" — and the counting
-- query ignores them.
-- ---------------------------------------------------------------------------

create table if not exists login_attempts (
  id      bigint unsigned not null auto_increment,
  email   varchar(190) not null default '',
  ip      varchar(45)  not null default '',
  ok      tinyint(1)   not null default 0,
  at      datetime     not null default current_timestamp,
  primary key (id),
  key login_attempts_email_idx (email, at),
  key login_attempts_ip_idx (ip, at)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. The administrator's log
--
-- Every account an administrator creates, disables, promotes, re-passwords or
-- deletes, recorded with who did it.
--
-- BOTH EMAIL ADDRESSES ARE COPIED IN, and there are no foreign keys. That is
-- the whole design. A log of administrative actions is worth having precisely
-- when somebody asks "who gave that person access" — and by then the answer
-- may involve two accounts that have since been deleted. Referencing users(id)
-- with a cascade would mean deleting an account erases the record of it ever
-- having been created, which is the opposite of what a log is for.
--
-- `detail` is a short human sentence, not structured data. Nothing reads this
-- table programmatically; it is read by a person asking what happened.
-- ---------------------------------------------------------------------------

create table if not exists admin_log (
  id           bigint unsigned not null auto_increment,
  actor_id     char(36)         null,
  actor_email  varchar(190) not null default '',
  action       varchar(40)  not null,
  target_id    char(36)         null,
  target_email varchar(190) not null default '',
  detail       varchar(255) not null default '',
  at           datetime     not null default current_timestamp,
  primary key (id),
  key admin_log_at_idx (at),
  key admin_log_target_idx (target_id)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. Confirm it worked
--
-- Run this on its own afterwards. Six rows, and users/map_projects must both
-- report InnoDB — a MyISAM table would have accepted the CREATE and silently
-- dropped every foreign key above, so deleting a user would leave their
-- projects behind as unreachable rows.
-- ---------------------------------------------------------------------------

-- select table_name, engine, table_rows
--   from information_schema.tables
--  where table_schema = database()
--    and table_name in ('users','sessions','map_projects','password_resets',
--                       'login_attempts','admin_log');

-- ---------------------------------------------------------------------------
-- ALREADY RAN AN EARLIER VERSION OF THIS FILE?
--
-- The `create table if not exists` above will find `users` already there and
-- skip it — INCLUDING the role, status and must_change_password columns added
-- later, which is exactly the trap that makes "just run it again" the wrong
-- advice. Run this instead, from the command line:
--
--     php api/cli/migrate.php
--
-- It inspects what is actually in the database and adds only what is missing,
-- and it is safe to run as many times as you like. /api/health reports whether
-- it needs running, so you do not have to guess.
-- ---------------------------------------------------------------------------
