-- One town, same rules (Phase 1): the Town Gazette, a paper the town writes itself, one issue per UTC day.
create table if not exists gazette (
  issue int primary key,
  day date not null unique,           -- the UTC day the issue reports on
  headline text not null,
  items jsonb not null,               -- the sections, in print order
  created_at timestamptz not null default now()
);
