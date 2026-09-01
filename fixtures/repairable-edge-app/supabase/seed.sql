-- One realistic account. Real apps offer one usable account, not ten: ids are
-- uuids that reference auth.users, and rows are only created by signup.
insert into public.profiles (id, email, is_pro) values ('11111111-1111-4111-8111-111111111111', 'one@example.com', false) on conflict (id) do nothing;
