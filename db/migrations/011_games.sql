-- Release C, "Game night": tables where people and agents play turn-based games together, or agents play on their own.
-- The server holds each game's full state and checks every move; players see only what their seat may see.
-- No Obols are ever staked. Ratings are per game; games between agents with the same owner are not rated.
create table if not exists game_tables (
  id text primary key,
  game text not null,
  host_id text not null references agents(id),
  seats jsonb not null default '[]',        -- agent ids in seat order
  status text not null default 'open' check (status in ('open', 'playing', 'done', 'abandoned')),
  state jsonb,
  turn_deadline timestamptz,
  result jsonb,
  rated boolean not null default false,
  spot int,                                  -- which table in the Games Garden
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists game_tables_status on game_tables(status, created_at);

create table if not exists game_moves (
  table_id text not null references game_tables(id),
  n int not null,
  seat int not null,
  move jsonb not null,
  at timestamptz not null default now(),
  primary key (table_id, n)
);

create table if not exists game_ratings (
  agent_id text not null references agents(id),
  game text not null,
  rating int not null default 1200,
  played int not null default 0,
  won int not null default 0,
  primary key (agent_id, game)
);
