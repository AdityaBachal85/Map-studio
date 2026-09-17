-- diagnostics/accounts-sqlite.sql — the test harness's database.
--
-- A mirror of sql/hostinger-mysql.sql in the dialect PHP can open here without
-- a MySQL server: same tables, same columns, same constraints. SQLite is not
-- what this ships on, so the two could drift — which is why every timestamp in
-- api/ is computed in PHP and passed as a parameter rather than left to a
-- column default, and why nothing in api/ uses a MySQL-only construct such as
-- `insert … on duplicate key update`. The SQL the tests exercise is the SQL
-- that runs in production.
--
-- What this cannot check: that the MySQL file above parses, that its index
-- lengths fit, and that InnoDB actually applied the foreign keys. Those are
-- checked by running it — see docs/ACCOUNTS-SETUP.md, which has the query.

create table users (
  id             text primary key,
  email          text not null unique,
  password_hash  text,
  full_name      text not null default '',
  avatar_url     text not null default '',
  created_at     text not null,
  updated_at     text not null
);

create table sessions (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  csrf         text not null,
  created_at   text not null,
  last_seen_at text not null,
  expires_at   text not null,
  user_agent   text not null default '',
  ip           text not null default ''
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

create table map_projects (
  id          text primary key,
  owner_id    text not null references users (id) on delete cascade,
  name        text not null default 'Untitled map project',
  place       text not null default '',
  data        text,
  n_locations integer not null default 0,
  n_sites     integer not null default 0,
  n_routes    integer not null default 0,
  n_shapes    integer not null default 0,
  bytes       integer not null default 0,
  created_at  text not null,
  updated_at  text not null
);
create index map_projects_owner_updated_idx on map_projects (owner_id, updated_at desc);

create table password_resets (
  id         text primary key,
  user_id    text not null references users (id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  used_at    text
);
create index password_resets_user_idx on password_resets (user_id);

create table login_attempts (
  id      integer primary key autoincrement,
  email   text not null default '',
  ip      text not null default '',
  ok      integer not null default 0,
  at      text not null
);
create index login_attempts_email_idx on login_attempts (email, at);
create index login_attempts_ip_idx on login_attempts (ip, at);
