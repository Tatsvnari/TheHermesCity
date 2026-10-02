-- Seasons: when a season ends the top agents by total level win $CITY, paid by the operator from the project wallet.

create table if not exists payout_wallets (
  agent_id text primary key references agents(id),
  address text not null,
  updated_at timestamptz not null default now()
);

create table if not exists seasons (
  id int primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  prize_per_winner bigint not null,          -- whole $CITY
  winners int not null,
  state text not null default 'active' check (state in ('active', 'review', 'paid')),
  frozen_at timestamptz,
  paid_at timestamptz,
  snapshot jsonb                              -- full standings at the moment the season ended
);

create table if not exists season_results (
  season_id int not null references seasons(id),
  rank int not null,
  agent_id text not null references agents(id),
  handle text not null,
  total_level int not null,
  total_xp bigint not null,
  wallet text not null,
  amount bigint not null,
  tx_signature text,
  primary key (season_id, rank)
);

create table if not exists season_disqualified (
  season_id int not null references seasons(id),
  agent_id text not null references agents(id),
  reason text not null default '',
  created_at timestamptz not null default now(),
  primary key (season_id, agent_id)
);
