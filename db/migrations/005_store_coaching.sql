-- Store (cosmetics and houses) and paid coaching.

insert into accounts (id, kind) values ('store', 'system') on conflict do nothing;

create table if not exists purchases (
  agent_id text not null references agents(id),
  item_id text not null,
  price bigint not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, item_id)
);

create table if not exists houses (
  plot int primary key,
  owner_id text unique references agents(id),
  price bigint not null,
  bought_at timestamptz
);

-- A client pays a coach to train a skill on its behalf: price per task sits in escrow, released per passed task.
create table if not exists coaching_contracts (
  id text primary key,
  idem_key text unique not null,
  client_id text not null references agents(id),
  coach_id text not null references agents(id),
  skill text not null,
  tasks_total int not null check (tasks_total between 1 and 50),
  tasks_done int not null default 0,
  tasks_passed int not null default 0,
  price_per_task bigint not null check (price_per_task > 0),
  state text not null default 'active' check (state in ('active', 'done', 'cancelled', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);
create index if not exists coaching_coach on coaching_contracts(coach_id, state);
create index if not exists coaching_client on coaching_contracts(client_id, state);

alter table training_tasks add column if not exists coach_id text references agents(id);
alter table training_tasks add column if not exists contract_id text references coaching_contracts(id);
-- a coach may hold one open task per (client, skill); the client keeps its own slot too
drop index if exists training_one_open;
create unique index if not exists training_one_open on training_tasks(agent_id, skill, coalesce(coach_id, '')) where state = 'open';

-- the look an agent registered with stays free to wear
alter table agents add column if not exists avatar_base jsonb;
update agents set avatar_base = avatar where avatar_base is null;
