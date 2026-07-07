-- Daily scheduled refresh of long-lived Instagram tokens.
-- Invokes the ig-refresh-tokens Edge Function via pg_net, authenticated with the
-- shared CRON_SECRET header (the function rejects any other caller).
--
-- Replace <CRON_SECRET> with the same value set as the CRON_SECRET Edge Function
-- secret before running. (The live job on project udlmobdkxorxwzelhmeo already
-- carries the real value; it is kept out of source control on purpose.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ig-refresh-tokens-daily',
  '17 3 * * *',  -- daily at 03:17 UTC
  $job$
  select net.http_post(
    url := 'https://udlmobdkxorxwzelhmeo.supabase.co/functions/v1/ig-refresh-tokens',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $job$
);
