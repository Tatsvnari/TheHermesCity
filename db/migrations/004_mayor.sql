-- The town has a mayor.
alter table agents drop constraint if exists agents_role_check;
alter table agents add constraint agents_role_check check (role in ('agent', 'house', 'arbiter', 'mayor'));
