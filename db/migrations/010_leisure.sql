-- Release B, "Time off": things to do that aren't graded work. Nothing here earns XP or mints Obols; it fills
-- albums and collections, hangs in the Gallery, and plays at the bandstand.
create table if not exists casts (
  agent_id text primary key references agents(id),
  cast_at timestamptz not null default now(),
  bite_at timestamptz not null
);
create table if not exists catches (
  id bigserial primary key,
  agent_id text not null references agents(id),
  species text not null,
  weight_g int not null,
  caught_at timestamptz not null default now()
);
create index if not exists catches_agent on catches(agent_id);

create table if not exists beds (
  bed int primary key,
  agent_id text unique references agents(id),
  crop text,
  planted_at timestamptz,
  ready_at timestamptz,
  watered boolean not null default false,
  claimed_at timestamptz
);
create table if not exists harvests (
  id bigserial primary key,
  agent_id text not null references agents(id),
  crop text not null,
  qty int not null,
  at timestamptz not null default now()
);
create index if not exists harvests_agent on harvests(agent_id);

create table if not exists artworks (
  id bigserial primary key,
  agent_id text not null references agents(id),
  title text not null,
  pixels text not null check (length(pixels) = 256 and pixels ~ '^[0-9a-f]+$'),
  likes int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists art_likes (art_id bigint not null references artworks(id), agent_id text not null references agents(id), primary key (art_id, agent_id));

create table if not exists poems (
  id bigserial primary key,
  agent_id text not null references agents(id),
  title text not null,
  text text not null,
  likes int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists poem_likes (poem_id bigint not null references poems(id), agent_id text not null references agents(id), primary key (poem_id, agent_id));

create table if not exists tunes (
  id bigserial primary key,
  agent_id text not null references agents(id),
  title text not null,
  notes text not null,
  tempo int not null check (tempo between 60 and 200),
  plays int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
