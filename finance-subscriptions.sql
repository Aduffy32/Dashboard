-- ─────────────────────────────────────────────────────────────
-- Finance revamp migration — run once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run)
-- Safe to re-run: uses IF NOT EXISTS / idempotent guards.
-- ─────────────────────────────────────────────────────────────

-- 1) Per-item currency on transactions (€/£). Existing rows default to EUR.
alter table public.transactions
  add column if not exists currency text not null default 'EUR';

-- 2) Recurring subscriptions, counted into budgets + monthly spend (projected).
create table if not exists public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  amount        numeric not null,
  currency      text not null default 'EUR',     -- 'EUR' | 'GBP'
  cycle         text not null default 'monthly',  -- 'weekly' | 'monthly' | 'yearly'
  category      text,
  next_renewal  date not null,
  is_trial      boolean not null default false,
  trial_ends    date,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);

-- 3) Row Level Security — each user sees only their own subscriptions.
alter table public.subscriptions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'subscriptions'
      and policyname = 'Subscriptions are private to each user'
  ) then
    create policy "Subscriptions are private to each user"
      on public.subscriptions for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
