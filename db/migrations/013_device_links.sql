-- Playing on another device: one-time codes (15 minutes) that carry a player's key, encrypted under the code and a
-- server secret. A row is deleted when its code is used or replaced, and expired rows are cleared as new ones are made.
create table if not exists device_links (
  id text primary key,                      -- sha256 of the code
  agent_id text not null references agents(id),
  iv bytea not null,
  tag bytea not null,
  enc bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists device_links_agent on device_links(agent_id);
