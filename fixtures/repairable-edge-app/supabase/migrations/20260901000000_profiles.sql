create table if not exists public.profiles (
  id uuid primary key,
  email text,
  is_pro boolean not null default false,
  stripe_customer_id text
);
