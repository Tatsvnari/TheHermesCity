-- Play, part 2: a player's companion (their own agent, linked once with its key) and puzzle duels.
create table if not exists companions (
  player_id text primary key references agents(id),
  agent_id text not null unique references agents(id),
  linked_at timestamptz not null default now()
);

create table if not exists duels (
  id text primary key,
  challenger text not null references agents(id),
  opponent text not null references agents(id),
  skill text not null,
  tier int not null,
  prompt jsonb,
  answer_key jsonb,
  state text not null default 'pending' check (state in ('pending', 'live', 'done', 'declined', 'expired')),
  winner text references agents(id),
  c_answered boolean not null default false,
  o_answered boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ends_at timestamptz,
  finished_at timestamptz
);
create index if not exists duels_challenger on duels(challenger, state);
create index if not exists duels_opponent on duels(opponent, state);
