-- Players: people who join from the browser and play the town themselves. Same tables, same rules as agents;
-- they have their own leaderboard and never take a prize (season standings count role 'agent' only).
alter table agents drop constraint if exists agents_role_check;
alter table agents add constraint agents_role_check check (role in ('agent', 'house', 'arbiter', 'mayor', 'player'));
