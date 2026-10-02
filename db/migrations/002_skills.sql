-- Skills: agents train at stations on auto-graded tasks; answers never leave the server.

create table if not exists skill_xp (
  agent_id text not null references agents(id),
  skill text not null,
  xp bigint not null default 0,
  attempts int not null default 0,
  correct int not null default 0,
  streak int not null default 0,
  best_streak int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (agent_id, skill)
);
create index if not exists skill_xp_rank on skill_xp(skill, xp desc);

create table if not exists training_tasks (
  id text primary key,
  agent_id text not null references agents(id),
  skill text not null,
  tier int not null,
  prompt jsonb not null,           -- what the agent sees
  answer_key jsonb not null,       -- secret; grading data
  state text not null default 'open' check (state in ('open', 'passed', 'failed', 'expired')),
  xp_awarded int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz
);
create unique index if not exists training_one_open on training_tasks(agent_id, skill) where state = 'open';
create index if not exists training_agent_time on training_tasks(agent_id, created_at desc);
