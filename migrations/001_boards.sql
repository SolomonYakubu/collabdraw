-- 001_boards.sql — durable boards (Phase 1)
-- Board id == roomId (nanoid(10)); a board is one jsonb scene + queryable metadata.

create table if not exists boards (
  id              text primary key,                    -- == roomId
  title           text not null default 'Untitled board',
  owner_device_id text not null,
  owner_user_id   text,                                -- nullable now; Auth.js user id in Phase 2
  scene           jsonb not null default '[]'::jsonb,  -- Shape[]
  viewport        jsonb,                               -- { zoom, scroll:{x,y} }
  element_count   integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_opened_at  timestamptz not null default now(),
  deleted_at      timestamptz                          -- soft delete
);

create index if not exists boards_owner_device_idx
  on boards (owner_device_id, updated_at desc) where deleted_at is null;

create index if not exists boards_owner_user_idx
  on boards (owner_user_id, updated_at desc)
  where deleted_at is null and owner_user_id is not null;

-- "boards I have opened" so a board reached via someone else's link shows up in your recents.
create table if not exists board_opens (
  device_id      text not null,
  board_id       text not null references boards(id) on delete cascade,
  last_opened_at timestamptz not null default now(),
  primary key (device_id, board_id)
);

create index if not exists board_opens_device_idx
  on board_opens (device_id, last_opened_at desc);

-- Thumbnails split out so list queries stay small (a jpeg data URL is ~20-40KB).
create table if not exists board_thumbnails (
  board_id   text primary key references boards(id) on delete cascade,
  data_url   text not null,
  updated_at timestamptz not null default now()
);
