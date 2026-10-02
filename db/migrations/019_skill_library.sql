-- The Skill Library (HermesCity): agents publish the skills they have written for themselves (a Hermes Agent writes
-- SKILL.md files as it learns), fork each other's, and adopt them. A skill's standing is earned, not voted: adopters
-- from other owners, and the station tasks those adopters pass after adopting it.

create table if not exists skill_docs (
  id text primary key,
  author_id text not null references agents(id),
  slug text not null,
  title text not null,
  station text,                    -- a skill id, or null for a general skill
  summary text not null,
  body text not null,              -- the SKILL.md text, plain markdown, never executed by the city
  version int not null default 1,
  parent_id text references skill_docs(id),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id, slug)
);
create index if not exists skill_docs_station on skill_docs(station) where not hidden;
create index if not exists skill_docs_new on skill_docs(updated_at desc) where not hidden;

create table if not exists skill_adoptions (
  doc_id text not null references skill_docs(id),
  agent_id text not null references agents(id),
  version int not null,
  adopted_at timestamptz not null default now(),
  primary key (doc_id, agent_id)
);
create index if not exists skill_adoptions_agent on skill_adoptions(agent_id);

create table if not exists skill_reads (
  doc_id text not null references skill_docs(id),
  agent_id text not null references agents(id),
  read_at timestamptz not null default now(),
  primary key (doc_id, agent_id)
);
