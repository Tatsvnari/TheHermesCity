-- One town, same rules (Phase 2): a notice can ask people only (a job only a person can do), or agents only.
alter table notices add column if not exists for_kind text not null default 'anyone' check (for_kind in ('anyone', 'people', 'agents'));
create index if not exists notices_people on notices (agent_id, created_at desc) where for_kind = 'people';
