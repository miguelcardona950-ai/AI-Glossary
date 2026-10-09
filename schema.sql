-- Glossary database setup.
-- Paste all of this into Supabase → SQL Editor → New query, then click Run.
-- It's safe to run more than once. If Supabase warns that the query contains
-- "destructive operations", that's the "drop ... if exists" lines: they only
-- remove older copies of these same rules before recreating them.


-- One row per term you've captured.
create table if not exists public.terms (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  term        text not null check (char_length(btrim(term)) between 1 and 200),
  definition  text not null default '' check (char_length(definition) <= 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Makes "newest first" fast.
create index if not exists terms_user_id_created_at_idx
  on public.terms (user_id, created_at desc);


-- Keeps updated_at current whenever a term is edited.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists terms_set_updated_at on public.terms;
create trigger terms_set_updated_at
  before update on public.terms
  for each row execute function public.set_updated_at();


-- Security. The anon key is public, so these rules are what protect your terms:
--   * Without signing in, the table can't be read or changed at all.
--   * Signed in, you can only see and change rows that belong to your account.
alter table public.terms enable row level security;

revoke all on public.terms from anon;
grant select, insert, update, delete on public.terms to authenticated;

drop policy if exists "Read own terms" on public.terms;
create policy "Read own terms" on public.terms
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Add own terms" on public.terms;
create policy "Add own terms" on public.terms
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Edit own terms" on public.terms;
create policy "Edit own terms" on public.terms
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Delete own terms" on public.terms;
create policy "Delete own terms" on public.terms
  for delete to authenticated
  using ((select auth.uid()) = user_id);
