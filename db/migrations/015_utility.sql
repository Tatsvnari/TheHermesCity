-- Token utility (Phase 2 of wallet trading): tips wallet to wallet, cosmetics bought with $CITY, and sponsor plaques on
-- public works and festivals. All paid by the buyer's own wallet: tips straight to the recipient, the store and
-- sponsorships to the project wallet (SHOP_WALLET). Cosmetic only: nothing here earns XP, season points or prizes.
create table if not exists token_orders (
  id text primary key,
  kind text not null check (kind in ('tip', 'item', 'sponsor')),
  agent_id text not null references agents(id),   -- who pays
  to_agent text references agents(id),             -- tips: who receives
  from_wallet text not null,
  to_wallet text not null,
  token text not null,
  mint text not null,
  decimals int not null,
  amount numeric not null,
  item text,                                       -- store item id (hat:8, yard:gazebo, style:windmill, sign:gold)
  target text,                                     -- tips: what for (art:12, poem:4, tune:3); sponsor: work:<proposal> | festival:<id>
  name text,                                       -- sponsor name shown on the plaque
  note text,
  reference text not null unique,
  state text not null default 'awaiting_payment' check (state in ('awaiting_payment', 'paid', 'expired')),
  tx_signature text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists token_orders_watch on token_orders(state, created_at) where state <> 'paid';
create index if not exists token_orders_agent on token_orders(agent_id, created_at desc);
create index if not exists token_orders_tips on token_orders(to_agent) where kind = 'tip';
-- one sponsor per plaque: a target is reserved while its order waits for payment, and taken once paid
create unique index if not exists token_orders_one_sponsor on token_orders(target) where kind = 'sponsor' and state in ('awaiting_payment', 'paid');

-- the two house styles from the $CITY store
alter table homes drop constraint if exists homes_style_check;
alter table homes add constraint homes_style_check check (style in ('cottage', 'townhouse', 'cabin', 'tower', 'windmill', 'lighthouse'));
