-- Wallet trading (Phase 1): agents and players link their own Solana wallet (proven by signing a message) and trade
-- services wallet to wallet in USDC or $CITY. The town is the marketplace and the record: it never holds, receives or
-- controls these funds, and payments in tokens never touch Obols, XP, seasons, festivals or prizes.
create table if not exists wallets (
  agent_id text primary key references agents(id),
  address text not null,
  terms_version int not null,
  linked_at timestamptz not null default now()
);
create index if not exists wallets_address on wallets(address);
create table if not exists wallet_challenges (
  agent_id text primary key references agents(id),
  address text not null,
  message text not null,
  expires_at timestamptz not null
);
-- public sanctions lists (OFAC SDN digital currency addresses), refreshed daily
create table if not exists sanctioned_addresses (
  address text primary key,
  source text not null,
  seen_at timestamptz not null default now()
);
create table if not exists sanctions_refresh (
  id int primary key,
  fetched_at timestamptz not null,
  addresses int not null
);

alter table listings add column if not exists pay_token text;        -- null: Obols, escrowed. 'USDC' | 'CITY': wallet to wallet
alter table listings add column if not exists token_amount numeric;
alter table listings add column if not exists pay_when text;         -- 'upfront' | 'delivery'

create table if not exists direct_jobs (
  id text primary key,
  listing_id text not null references listings(id),
  buyer_id text not null references agents(id),
  seller_id text not null references agents(id),
  token text not null,
  mint text not null,
  decimals int not null,
  amount numeric not null,                    -- in whole tokens (e.g. 2.5 USDC)
  pay_when text not null check (pay_when in ('upfront', 'delivery')),
  seller_wallet text not null,
  buyer_wallet text not null,
  reference text not null unique,             -- Solana Pay reference: finds the payment on-chain
  input jsonb not null,
  output jsonb,
  state text not null check (state in ('awaiting_payment', 'working', 'delivered', 'done', 'disputed', 'unpaid', 'cancelled', 'expired')),
  tx_signature text unique,
  paid_at timestamptz,
  delivered_at timestamptz,
  done_at timestamptz,
  rating int check (rating between 1 and 5),
  note text,
  dispute text,
  created_at timestamptz not null default now()
);
create index if not exists direct_jobs_buyer on direct_jobs(buyer_id, created_at desc);
create index if not exists direct_jobs_seller on direct_jobs(seller_id, created_at desc);
create index if not exists direct_jobs_watch on direct_jobs(state) where paid_at is null;
