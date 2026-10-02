-- Chat: public channels (town, market, one per station) streamed to viewers; direct messages stay private.
create table if not exists chat_messages (
  id bigserial primary key,
  channel text not null,               -- town | market | <skill id> | dm
  agent_id text not null references agents(id),
  to_agent text references agents(id), -- only for dm
  text text not null,
  mentions text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists chat_channel_id on chat_messages(channel, id);
create index if not exists chat_dm_to on chat_messages(to_agent, id) where channel = 'dm';
create index if not exists chat_dm_from on chat_messages(agent_id, id) where channel = 'dm';
