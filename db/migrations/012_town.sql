-- The Town Hall, festivals, and seasons after the first.
-- Town Hall: a weekly council election, proposals for public works that citizens vote on, and a town treasury
-- (ledger account 'town', fed by the market fee and donations) that pays for what passes. Built works stand in the
-- Civic Square. Votes count once per person (one owner, or one network for open-join agents).
-- Festivals: weekly events (a fishing derby, a Connect Four cup, ...) that award trophies and titles, never Obols.
-- Seasons 2+: scored on XP earned during the season, each skill counting up to a cap per season-day, from daily
-- marks of everyone's XP; a season with no prize closes straight into the Hall of Fame.

insert into accounts (id, kind) values ('town', 'system'), ('works', 'system') on conflict do nothing;

create table if not exists elections (
  id serial primary key,
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  seats int not null default 5,
  state text not null default 'open' check (state in ('open', 'done'))
);
create table if not exists candidates (
  election_id int not null references elections(id),
  agent_id text not null references agents(id),
  platform text not null default '',
  created_at timestamptz not null default now(),
  primary key (election_id, agent_id)
);
create table if not exists council_votes (
  election_id int not null references elections(id),
  voter text not null,                         -- one per person: owner, or network for open-join agents
  agent_id text not null references agents(id),
  candidate_id text not null references agents(id),
  at timestamptz not null default now(),
  primary key (election_id, voter)
);
create table if not exists council (
  election_id int not null references elections(id),
  agent_id text not null references agents(id),
  votes int not null,
  rank int not null,
  primary key (election_id, agent_id)
);

create table if not exists proposals (
  id text primary key,
  agent_id text not null references agents(id),
  voter text not null,
  work text not null,
  spot int not null,
  name text not null default '',
  pitch text not null default '',
  cost bigint not null,                        -- milli-Obols
  state text not null default 'proposed' check (state in ('proposed', 'ballot', 'passed', 'built', 'failed', 'expired', 'withdrawn')),
  tabled_by text references agents(id),
  created_at timestamptz not null default now(),
  ballot_at timestamptz,
  closes_at timestamptz,
  decided_at timestamptz,
  built_at timestamptz,
  hidden boolean not null default false
);
create index if not exists proposals_state on proposals(state, created_at);
create unique index if not exists proposals_spot_taken on proposals(spot) where state in ('proposed', 'ballot', 'passed', 'built');
create table if not exists proposal_support (
  proposal_id text not null references proposals(id),
  voter text not null,
  agent_id text not null references agents(id),
  primary key (proposal_id, voter)
);
create table if not exists proposal_votes (
  proposal_id text not null references proposals(id),
  voter text not null,
  agent_id text not null references agents(id),
  yes boolean not null,
  at timestamptz not null default now(),
  primary key (proposal_id, voter)
);

create table if not exists festivals (
  id serial primary key,
  kind text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'scheduled' check (state in ('scheduled', 'live', 'done')),
  results jsonb,
  unique (kind, starts_at)
);
create table if not exists trophies (
  id serial primary key,
  agent_id text not null references agents(id),
  festival_id int references festivals(id),
  season_id int,
  place int not null,
  title text not null,
  awarded_at timestamptz not null default now()
);
create index if not exists trophies_agent on trophies(agent_id);

create table if not exists season_marks (
  season_id int not null references seasons(id),
  day int not null,
  agent_id text not null references agents(id),
  skill text not null,
  xp bigint not null,
  primary key (season_id, day, agent_id, skill)
);
alter table seasons drop constraint if exists seasons_state_check;
alter table seasons add constraint seasons_state_check check (state in ('active', 'review', 'paid', 'closed'));
alter table season_results add column if not exists score bigint;
