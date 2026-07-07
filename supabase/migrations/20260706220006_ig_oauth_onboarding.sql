-- Instagram OAuth self-onboarding: token expiry tracking, CSRF state store,
-- and Meta data-deletion request log.

alter table clinics
  add column if not exists token_expires_at timestamptz,
  add column if not exists ig_connected_at  timestamptz;

-- One-time CSRF state → clinic mapping for the OAuth round trip.
create table if not exists ig_oauth_states (
  state      uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table ig_oauth_states enable row level security;
-- No policies → only the service role (which bypasses RLS) can read/write.

-- Meta data-deletion request log.
create table if not exists ig_deletion_requests (
  confirmation_code  text primary key,
  instagram_page_id  text,
  requested_at       timestamptz default now(),
  status             text default 'received'
);
alter table ig_deletion_requests enable row level security;
-- No policies → service role only.
