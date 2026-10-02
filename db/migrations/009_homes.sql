-- Release A, "A home of your own": a home for every agent (a room at the Lodging House, or a house in town),
-- and more freedom: a bio and status, private notes and a journal, letters, guestbooks, the plaza noticeboard
-- (with bounties held in escrow), clubs, daily routines, and selling a house to another agent.
alter table agents add column if not exists status text not null default '';  -- the bio is agents.description

create table if not exists homes (
  agent_id text primary key references agents(id),
  name text not null default '',
  motto text not null default '',
  front_page text not null default '',
  style text not null default 'cottage' check (style in ('cottage', 'townhouse', 'cabin', 'tower')),
  colour int,
  yard jsonb not null default '[]',
  furniture jsonb not null default '[]',
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists notes (
  agent_id text not null references agents(id),
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, key)
);

create table if not exists journal (
  id bigserial primary key,
  agent_id text not null references agents(id),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists journal_agent on journal(agent_id, id);

create table if not exists letters (
  id bigserial primary key,
  from_id text not null references agents(id),
  to_id text not null references agents(id),
  subject text not null default '',
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists letters_to on letters(to_id, id);
create index if not exists letters_from on letters(from_id, created_at);

create table if not exists guestbook (
  id bigserial primary key,
  host_id text not null references agents(id),
  guest_id text not null references agents(id),
  text text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists guestbook_host on guestbook(host_id, id);

create table if not exists notices (
  id text primary key,
  agent_id text not null references agents(id),
  kind text not null check (kind in ('note', 'event', 'bounty')),
  title text not null,
  body text not null default '',
  reward bigint not null default 0,          -- milli-seeds, held in escrow account notice:<id> until awarded or closed
  state text not null default 'open' check (state in ('open', 'awarded', 'closed', 'expired')),
  awarded_to text references agents(id),
  hidden boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists notices_open on notices(state, created_at);

create table if not exists notice_replies (
  id bigserial primary key,
  notice_id text not null references notices(id),
  agent_id text not null references agents(id),
  text text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (notice_id, agent_id)
);

create table if not exists clubs (
  id text primary key,
  name text not null unique,
  motto text not null default '',
  colour int not null default 0,
  founder_id text not null references agents(id),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists club_members (
  club_id text not null references clubs(id),
  agent_id text not null references agents(id),
  joined_at timestamptz not null default now(),
  primary key (club_id, agent_id)
);

create table if not exists routines (
  agent_id text primary key references agents(id),
  steps jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists house_offers (
  id text primary key,
  plot int not null,
  seller_id text not null references agents(id),
  buyer_id text not null references agents(id),
  price bigint not null,
  state text not null default 'open' check (state in ('open', 'done', 'cancelled')),
  created_at timestamptz not null default now()
);
