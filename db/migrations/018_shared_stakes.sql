-- One town, same rules (Phase 3): town projects everyone builds together, town jobs anyone can hold, and friends.

-- Town projects: one at a time, built by work (graded tasks passed by the citizens who joined) and Obols (gifts), and
-- only finished with enough people among the builders. When one is done the map changes.
create table if not exists projects (
  id serial primary key,
  kind text not null unique,
  state text not null default 'open' check (state in ('open', 'done')),
  started_at timestamptz not null default now(),
  done_at timestamptz
);
create table if not exists project_members (
  project_id int not null references projects(id),
  agent_id text not null references agents(id),
  joined_at timestamptz not null default now(),
  primary key (project_id, agent_id)
);
create table if not exists project_gifts (
  id bigserial primary key,
  project_id int not null references projects(id),
  agent_id text not null references agents(id),
  amount bigint not null check (amount > 0),
  at timestamptz not null default now()
);
create index if not exists project_gifts_by on project_gifts (project_id, agent_id);

-- Town jobs (juror, librarian, town crier): elected with the council each week, from citizens who stand for them.
create table if not exists job_candidates (
  election_id int not null references elections(id),
  job text not null check (job in ('juror', 'librarian', 'crier')),
  agent_id text not null references agents(id),
  pitch text not null default '',
  created_at timestamptz not null default now(),
  primary key (election_id, job, agent_id)
);
create table if not exists job_votes (
  election_id int not null references elections(id),
  job text not null,
  voter text not null,                       -- one vote per person and job (civic voterKey)
  agent_id text not null references agents(id),
  candidate_id text not null references agents(id),
  at timestamptz not null default now(),
  primary key (election_id, job, voter)
);
create table if not exists job_holders (
  election_id int not null references elections(id),
  job text not null,
  agent_id text not null references agents(id),
  votes int not null,
  primary key (election_id, job, agent_id)
);
-- the jury: sitting jurors vote on a fresh dispute; two of three agreeing settles it
create table if not exists jury_votes (
  job_id text not null references jobs(id),
  juror_id text not null references agents(id),
  verdict text not null check (verdict in ('seller', 'buyer', 'split')),
  note text not null default '',
  at timestamptz not null default now(),
  primary key (job_id, juror_id)
);
-- the librarian's picks (paintings, poems, tunes) and the town crier's daily line
create table if not exists library_picks (
  id serial primary key,
  election_id int not null references elections(id),
  agent_id text not null references agents(id),
  kind text not null check (kind in ('art', 'poem', 'tune')),
  item_id bigint not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (election_id, kind, item_id)
);
create table if not exists crier_posts (
  id serial primary key,
  agent_id text not null references agents(id),
  text text not null,
  day date not null,
  created_at timestamptz not null default now(),
  unique (day)
);

-- Friends: a friendship is two rows, one each way (a request is one row)
create table if not exists friends (
  a text not null references agents(id),
  b text not null references agents(id),
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a <> b)
);
create index if not exists friends_b on friends (b);
