-- HermesCity schema. Amounts are integer milli-seeds (1 Obol = 1000).

create table if not exists accounts (
  id text primary key,
  kind text not null check (kind in ('system', 'agent')),
  balance bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists transfers (
  id uuid primary key,
  idempotency_key text unique not null,
  kind text not null,            -- mint | pay | escrow_in | escrow_out | fee | refund | grant
  memo text,
  created_at timestamptz not null default now()
);

create table if not exists entries (
  id bigserial primary key,
  transfer_id uuid not null references transfers(id),
  account_id text not null references accounts(id),
  amount bigint not null         -- negative = debit, positive = credit
);
create index if not exists entries_account_idx on entries(account_id, id);
create index if not exists entries_transfer_idx on entries(transfer_id);

create table if not exists agents (
  id text primary key,
  handle text unique not null,
  description text not null default '',
  owner_email text not null,
  avatar jsonb not null default '{}',
  role text not null default 'agent' check (role in ('agent', 'house', 'arbiter')),
  api_key_hash text unique not null,
  tranches_released int not null default 0,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists agents_owner_idx on agents(owner_email);

create table if not exists listings (
  id text primary key,
  agent_id text not null references agents(id),
  name text not null,
  description text not null default '',
  price bigint not null check (price > 0),
  unit text not null default 'job',   -- job | unit (per-unit pricing uses input.units)
  input_schema jsonb not null default '{}',
  output_schema jsonb not null default '{}',
  check_kind text not null default 'none',
  max_turnaround_s int not null default 600,
  plot int not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists listings_plot_active on listings(plot) where active;

create table if not exists jobs (
  id text primary key,
  idem_key text unique not null,
  listing_id text not null references listings(id),
  buyer_id text not null references agents(id),
  seller_id text not null references agents(id),
  input jsonb not null,
  output jsonb,
  price bigint not null,
  state text not null check (state in
    ('open','assigned','delivered','accepted','disputed','settled','expired','cancelled')),
  check_passed boolean,
  was_disputed boolean not null default false,
  verdict text,                  -- seller | buyer | split (after dispute)
  note text,
  deadline timestamptz not null,
  delivered_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_seller_state on jobs(seller_id, state);
create index if not exists jobs_buyer_state on jobs(buyer_id, state);
create index if not exists jobs_state on jobs(state);

create table if not exists events (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

insert into accounts (id, kind) values ('treasury', 'system'), ('fees', 'system')
  on conflict do nothing;
