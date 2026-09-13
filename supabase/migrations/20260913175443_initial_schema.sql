-- Segue initial schema.
-- Every table lives in public with RLS enabled and a deny-all policy for anon and
-- authenticated, which also get no privileges. service_role (the server-only secret key)
-- gets explicit grants.
-- Atomic read-modify-write operations are security invoker functions with an empty
-- search_path, executable by service_role only.

-- Enums

create type public.inbox_message_status as enum (
  'pending',
  'not_sponsorship',
  'followup',
  'sponsorship',
  'skipped',
  'failed'
);

create type public.sponsorship_status as enum (
  'matching',
  'writing',
  'branched',
  'no_fit',
  'failed'
);

create type public.branch_status as enum (
  'pending',
  'approved',
  'rejected'
);

create type public.email_draft_kind as enum (
  'accept',
  'decline'
);

create type public.email_draft_status as enum (
  'generating',
  'draft',
  'failed',
  'sending',
  'sent'
);

-- updated_at trigger

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Tables

create table public.app_state (
  id boolean primary key default true,
  google_email text,
  refresh_token_enc text,
  history_id text,
  watch_expires_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  needs_reauth boolean not null default false,
  llm_paused_reason text,
  updated_at timestamptz not null default now(),
  constraint app_state_singleton check (id),
  constraint app_state_history_id_numeric check (history_id ~ '^[0-9]+$'),
  constraint app_state_last_error_length check (char_length(last_error) <= 500),
  constraint app_state_llm_paused_reason_length check (char_length(llm_paused_reason) <= 500)
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  script text not null default '',
  monitoring boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint videos_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint videos_script_length check (char_length(script) <= 60000)
);

create table public.inbox_messages (
  gmail_message_id text primary key,
  status public.inbox_message_status not null default 'pending',
  attempts integer not null default 0,
  lease_expires_at timestamptz,
  error text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbox_messages_id_length check (char_length(gmail_message_id) between 1 and 200),
  constraint inbox_messages_attempts_nonnegative check (attempts >= 0),
  constraint inbox_messages_tokens_nonnegative check (input_tokens >= 0 and output_tokens >= 0),
  constraint inbox_messages_error_length check (char_length(error) <= 500)
);

create table public.sponsorships (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null,
  thread_id text not null,
  from_name text,
  from_email text not null,
  reply_to text,
  cc text[] not null default '{}',
  subject text not null,
  body_text text not null,
  received_at timestamptz not null,
  brand text,
  product text,
  deliverable text,
  compensation text,
  deadline text,
  summary text,
  status public.sponsorship_status not null default 'matching',
  video_id uuid references public.videos (id) on delete set null,
  fit_reason text,
  attempts integer not null default 0,
  lease_expires_at timestamptz,
  error text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  last_reply_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sponsorships_gmail_message_id_key unique (gmail_message_id),
  constraint sponsorships_thread_id_key unique (thread_id),
  constraint sponsorships_ids_length check (
    char_length(gmail_message_id) between 1 and 200
    and char_length(thread_id) between 1 and 200
  ),
  constraint sponsorships_from_email_present check (char_length(from_email) >= 1),
  constraint sponsorships_writing_has_video check (status <> 'writing' or video_id is not null),
  constraint sponsorships_attempts_nonnegative check (attempts >= 0),
  constraint sponsorships_tokens_nonnegative check (input_tokens >= 0 and output_tokens >= 0),
  constraint sponsorships_error_length check (char_length(error) <= 500)
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  sponsorship_id uuid not null references public.sponsorships (id) on delete cascade,
  base_script text not null,
  script text not null,
  segment_summary text not null,
  status public.branch_status not null default 'pending',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_sponsorship_id_key unique (sponsorship_id),
  constraint branches_decided_at_present check (status = 'pending' or decided_at is not null)
);

create table public.email_drafts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete cascade,
  kind public.email_draft_kind not null,
  request_id uuid not null,
  based_on timestamptz not null,
  to_email text,
  cc text[] not null default '{}',
  subject text,
  body text,
  status public.email_draft_status not null default 'generating',
  error text,
  sending_started_at timestamptz,
  gmail_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_drafts_branch_id_key unique (branch_id),
  constraint email_drafts_content_present check (
    status not in ('draft', 'sending', 'sent')
    or (to_email is not null and subject is not null and body is not null)
  ),
  constraint email_drafts_sending_started check (
    status not in ('sending', 'sent') or sending_started_at is not null
  ),
  constraint email_drafts_sent_fields check (
    status <> 'sent' or (gmail_message_id is not null and sent_at is not null)
  ),
  constraint email_drafts_error_length check (char_length(error) <= 500)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_branch_id_key unique (branch_id)
);

-- Indexes: status columns and foreign keys. The unique constraints above already
-- index branches.sponsorship_id, email_drafts.branch_id and notifications.branch_id.

create index inbox_messages_status_created_at_idx on public.inbox_messages (status, created_at);
create index sponsorships_status_created_at_idx on public.sponsorships (status, created_at);
create index sponsorships_video_id_idx on public.sponsorships (video_id);
create index branches_video_id_idx on public.branches (video_id);
create index branches_status_idx on public.branches (status);
create index email_drafts_status_idx on public.email_drafts (status);

-- updated_at triggers

create trigger app_state_set_updated_at before update on public.app_state
  for each row execute function public.set_updated_at();
create trigger videos_set_updated_at before update on public.videos
  for each row execute function public.set_updated_at();
create trigger inbox_messages_set_updated_at before update on public.inbox_messages
  for each row execute function public.set_updated_at();
create trigger sponsorships_set_updated_at before update on public.sponsorships
  for each row execute function public.set_updated_at();
create trigger branches_set_updated_at before update on public.branches
  for each row execute function public.set_updated_at();
create trigger email_drafts_set_updated_at before update on public.email_drafts
  for each row execute function public.set_updated_at();

-- Row level security on every table. The only policies deny anon and authenticated
-- outright (they also hold no privileges). service_role bypasses RLS.

alter table public.app_state enable row level security;
alter table public.videos enable row level security;
alter table public.inbox_messages enable row level security;
alter table public.sponsorships enable row level security;
alter table public.branches enable row level security;
alter table public.email_drafts enable row level security;
alter table public.notifications enable row level security;

create policy "No client access" on public.app_state as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.videos as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.inbox_messages as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.sponsorships as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.branches as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.email_drafts as restrictive for all to anon, authenticated using (false) with check (false);
create policy "No client access" on public.notifications as restrictive for all to anon, authenticated using (false) with check (false);

-- Table privileges

revoke all on table
  public.app_state,
  public.videos,
  public.inbox_messages,
  public.sponsorships,
  public.branches,
  public.email_drafts,
  public.notifications
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.app_state,
  public.videos,
  public.inbox_messages,
  public.sponsorships,
  public.branches,
  public.email_drafts,
  public.notifications
to service_role;

-- Singleton row

insert into public.app_state (id) values (true);

-- Functions

-- Claims one pending inbox message: the given one, or the oldest claimable one when
-- p_gmail_message_id is null. Returns the claimed row or nothing.
create function public.claim_inbox_message(
  p_lease_seconds integer,
  p_max_attempts integer,
  p_gmail_message_id text default null
)
returns setof public.inbox_messages
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_lease_seconds, 0) <= 0 or coalesce(p_max_attempts, 0) <= 0 then
    raise exception 'claim_inbox_message: invalid parameters' using errcode = '22023';
  end if;

  return query
  update public.inbox_messages as m
  set attempts = m.attempts + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where m.gmail_message_id = (
    select c.gmail_message_id
    from public.inbox_messages as c
    where c.status = 'pending'
      and (c.lease_expires_at is null or c.lease_expires_at < now())
      and c.attempts < p_max_attempts
      and (p_gmail_message_id is null or c.gmail_message_id = p_gmail_message_id)
    order by c.created_at, c.gmail_message_id
    limit 1
    for update skip locked
  )
  returning m.*;
end;
$$;

-- Gives up a claim after a transient or account-level error. A transient error keeps
-- the spent attempt and fails the row once attempts reach the limit. An account-level
-- error refunds the attempt.
create function public.release_inbox_message(
  p_gmail_message_id text,
  p_refund_attempt boolean,
  p_max_attempts integer,
  p_error text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns setof public.inbox_messages
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_refund_attempt is null or coalesce(p_max_attempts, 0) <= 0 then
    raise exception 'release_inbox_message: invalid parameters' using errcode = '22023';
  end if;

  return query
  update public.inbox_messages as m
  set attempts = case when p_refund_attempt then greatest(m.attempts - 1, 0) else m.attempts end,
      status = case
        when not p_refund_attempt and m.attempts >= p_max_attempts
          then 'failed'::public.inbox_message_status
        else m.status
      end,
      lease_expires_at = null,
      error = p_error,
      input_tokens = m.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = m.output_tokens + greatest(coalesce(p_output_tokens, 0), 0)
  where m.gmail_message_id = p_gmail_message_id
    and m.status = 'pending'
    and m.lease_expires_at is not null
  returning m.*;
end;
$$;

-- Moves a claimed pending inbox message to its final status and ends the claim.
create function public.settle_inbox_message(
  p_gmail_message_id text,
  p_status public.inbox_message_status,
  p_error text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns setof public.inbox_messages
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status is null or p_status = 'pending' then
    raise exception 'settle_inbox_message: invalid status' using errcode = '22023';
  end if;

  return query
  update public.inbox_messages as m
  set status = p_status,
      lease_expires_at = null,
      error = p_error,
      input_tokens = m.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = m.output_tokens + greatest(coalesce(p_output_tokens, 0), 0)
  where m.gmail_message_id = p_gmail_message_id
    and m.status = 'pending'
    and m.lease_expires_at is not null
  returning m.*;
end;
$$;

-- Claims one sponsorship in one of the given working statuses: the given one, or the
-- oldest claimable one when p_id is null.
create function public.claim_sponsorship(
  p_statuses public.sponsorship_status[],
  p_lease_seconds integer,
  p_max_attempts integer,
  p_id uuid default null
)
returns setof public.sponsorships
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_lease_seconds, 0) <= 0
    or coalesce(p_max_attempts, 0) <= 0
    or coalesce(cardinality(p_statuses), 0) = 0
    or not (p_statuses <@ array['matching', 'writing']::public.sponsorship_status[])
  then
    raise exception 'claim_sponsorship: invalid parameters' using errcode = '22023';
  end if;

  return query
  update public.sponsorships as s
  set attempts = s.attempts + 1,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where s.id = (
    select c.id
    from public.sponsorships as c
    where c.status = any (p_statuses)
      and (c.lease_expires_at is null or c.lease_expires_at < now())
      and c.attempts < p_max_attempts
      and (p_id is null or c.id = p_id)
    order by c.created_at, c.id
    limit 1
    for update skip locked
  )
  returning s.*;
end;
$$;

create function public.release_sponsorship(
  p_id uuid,
  p_refund_attempt boolean,
  p_max_attempts integer,
  p_error text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns setof public.sponsorships
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_refund_attempt is null or coalesce(p_max_attempts, 0) <= 0 then
    raise exception 'release_sponsorship: invalid parameters' using errcode = '22023';
  end if;

  return query
  update public.sponsorships as s
  set attempts = case when p_refund_attempt then greatest(s.attempts - 1, 0) else s.attempts end,
      status = case
        when not p_refund_attempt and s.attempts >= p_max_attempts
          then 'failed'::public.sponsorship_status
        else s.status
      end,
      lease_expires_at = null,
      error = p_error,
      input_tokens = s.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = s.output_tokens + greatest(coalesce(p_output_tokens, 0), 0)
  where s.id = p_id
    and s.status in ('matching', 'writing')
    and s.lease_expires_at is not null
  returning s.*;
end;
$$;

-- Finishes a claimed step of a sponsorship. Allowed moves: matching to writing (with a
-- video), no_fit or failed; writing to branched, no_fit or failed. Moving to writing
-- starts a new unit of work, so attempts reset.
create function public.settle_sponsorship(
  p_id uuid,
  p_from public.sponsorship_status,
  p_to public.sponsorship_status,
  p_video_id uuid default null,
  p_fit_reason text default null,
  p_error text default null,
  p_input_tokens integer default 0,
  p_output_tokens integer default 0
)
returns setof public.sponsorships
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (
    (p_from = 'matching' and p_to in ('writing', 'no_fit', 'failed'))
    or (p_from = 'writing' and p_to in ('branched', 'no_fit', 'failed'))
  ) then
    raise exception 'settle_sponsorship: invalid transition' using errcode = '22023';
  end if;

  if p_to = 'writing' and p_video_id is null then
    raise exception 'settle_sponsorship: video required' using errcode = '22023';
  end if;

  return query
  update public.sponsorships as s
  set status = p_to,
      video_id = case
        when p_to = 'writing' then p_video_id
        when p_to = 'no_fit' then null
        else s.video_id
      end,
      fit_reason = coalesce(p_fit_reason, s.fit_reason),
      attempts = case when p_to = 'writing' then 0 else s.attempts end,
      lease_expires_at = null,
      error = p_error,
      input_tokens = s.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
      output_tokens = s.output_tokens + greatest(coalesce(p_output_tokens, 0), 0)
  where s.id = p_id
    and s.status = p_from
    and s.lease_expires_at is not null
  returning s.*;
end;
$$;

-- Retry button: a failed sponsorship goes back to writing when it still has a video,
-- otherwise to matching, with attempts reset.
create function public.retry_sponsorship(p_id uuid)
returns setof public.sponsorships
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  update public.sponsorships as s
  set status = case
        when s.video_id is null then 'matching'::public.sponsorship_status
        else 'writing'::public.sponsorship_status
      end,
      attempts = 0,
      lease_expires_at = null,
      error = null
  where s.id = p_id
    and s.status = 'failed'
  returning s.*;
end;
$$;

-- Records a sponsor reply in a known thread. last_reply_at only moves forward.
create function public.record_sponsor_reply(p_thread_id text, p_replied_at timestamptz)
returns setof public.sponsorships
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_replied_at is null then
    raise exception 'record_sponsor_reply: invalid parameters' using errcode = '22023';
  end if;

  return query
  update public.sponsorships as s
  set last_reply_at = greatest(s.last_reply_at, p_replied_at)
  where s.thread_id = p_thread_id
  returning s.*;
end;
$$;

-- Daily cron: ends expired leases. Rows whose attempts are used up become failed; the
-- rest become claimable again. Never touches failed rows.
create function public.reclaim_expired_leases(p_max_attempts integer, p_error text)
returns table (
  inbox_failed integer,
  inbox_released integer,
  sponsorships_failed integer,
  sponsorships_released integer
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(p_max_attempts, 0) <= 0 then
    raise exception 'reclaim_expired_leases: invalid parameters' using errcode = '22023';
  end if;

  update public.inbox_messages as m
  set status = 'failed', lease_expires_at = null, error = p_error
  where m.status = 'pending'
    and m.lease_expires_at < now()
    and m.attempts >= p_max_attempts;
  get diagnostics inbox_failed = row_count;

  update public.inbox_messages as m
  set lease_expires_at = null
  where m.status = 'pending'
    and m.lease_expires_at < now();
  get diagnostics inbox_released = row_count;

  update public.sponsorships as s
  set status = 'failed', lease_expires_at = null, error = p_error
  where s.status in ('matching', 'writing')
    and s.lease_expires_at < now()
    and s.attempts >= p_max_attempts;
  get diagnostics sponsorships_failed = row_count;

  update public.sponsorships as s
  set lease_expires_at = null
  where s.status in ('matching', 'writing')
    and s.lease_expires_at < now();
  get diagnostics sponsorships_released = row_count;

  return next;
end;
$$;

-- Moves app_state.history_id forward only, compared as numbers. Returns true when it moved.
create function public.advance_history_id(p_history_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_history_id is null or p_history_id !~ '^[0-9]+$' then
    raise exception 'advance_history_id: invalid history id' using errcode = '22023';
  end if;

  insert into public.app_state (id) values (true) on conflict (id) do nothing;

  update public.app_state as a
  set history_id = p_history_id
  where a.id
    and (a.history_id is null or a.history_id::numeric < p_history_id::numeric);

  return found;
end;
$$;

-- Deletes a video unless a reply for one of its branches is sending or sent. Its writing
-- and branched sponsorships become no_fit "Video deleted" first. Returns deleted,
-- not_found or reply_sent.
create function public.delete_video(p_video_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.videos as v where v.id = p_video_id for update;
  if not found then
    return 'not_found';
  end if;

  perform 1 from public.branches as b where b.video_id = p_video_id order by b.id for update;
  perform 1
  from public.email_drafts as d
  join public.branches as b on b.id = d.branch_id
  where b.video_id = p_video_id
  order by d.id
  for update of d;

  if exists (
    select 1
    from public.email_drafts as d
    join public.branches as b on b.id = d.branch_id
    where b.video_id = p_video_id
      and d.status in ('sending', 'sent')
  ) then
    return 'reply_sent';
  end if;

  update public.sponsorships as s
  set status = 'no_fit',
      fit_reason = 'Video deleted',
      lease_expires_at = null,
      error = null
  where s.video_id = p_video_id
    and s.status in ('writing', 'branched');

  delete from public.videos as v where v.id = p_video_id;
  return 'deleted';
end;
$$;

-- Edits a branch script unless its reply is sending or sent. An unchanged script leaves
-- updated_at alone so it does not look like an edit after the draft.
create function public.update_branch_script(p_branch_id uuid, p_script text)
returns setof public.branches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_draft_status public.email_draft_status;
begin
  if p_script is null then
    raise exception 'update_branch_script: invalid parameters' using errcode = '22023';
  end if;

  perform 1 from public.branches as b where b.id = p_branch_id for update;
  if not found then
    return;
  end if;

  select d.status into v_draft_status
  from public.email_drafts as d
  where d.branch_id = p_branch_id
  for update;

  if v_draft_status in ('sending', 'sent') then
    return;
  end if;

  update public.branches as b
  set script = p_script
  where b.id = p_branch_id
    and b.script is distinct from p_script;

  return query select b.* from public.branches as b where b.id = p_branch_id;
end;
$$;

-- Approve or Reject (also Redraft and Retry): sets the decision and resets the draft to
-- generating with a new request_id and based_on = the branch updated_at. Returns the
-- draft, or nothing when the branch is missing or its reply is sending or sent.
create function public.decide_branch(p_branch_id uuid, p_status public.branch_status)
returns setof public.email_drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_draft_status public.email_draft_status;
  v_updated_at timestamptz;
begin
  if p_status is null or p_status = 'pending' then
    raise exception 'decide_branch: invalid status' using errcode = '22023';
  end if;

  perform 1 from public.branches as b where b.id = p_branch_id for update;
  if not found then
    return;
  end if;

  select d.status into v_draft_status
  from public.email_drafts as d
  where d.branch_id = p_branch_id
  for update;

  if v_draft_status in ('sending', 'sent') then
    return;
  end if;

  update public.branches as b
  set status = p_status,
      decided_at = case
        when b.status = p_status and b.decided_at is not null then b.decided_at
        else now()
      end
  where b.id = p_branch_id
  returning b.updated_at into v_updated_at;

  return query
  insert into public.email_drafts as d (branch_id, kind, request_id, based_on, status)
  values (
    p_branch_id,
    case when p_status = 'approved'
      then 'accept'::public.email_draft_kind
      else 'decline'::public.email_draft_kind
    end,
    gen_random_uuid(),
    v_updated_at,
    'generating'
  )
  on conflict (branch_id) do update
  set kind = excluded.kind,
      request_id = excluded.request_id,
      based_on = excluded.based_on,
      status = 'generating',
      to_email = null,
      cc = '{}',
      subject = null,
      body = null,
      error = null,
      sending_started_at = null,
      gmail_message_id = null,
      sent_at = null
  returning d.*;
end;
$$;

-- Send claim: draft to sending, only while the draft kind still matches the branch
-- decision. Returns the claimed draft or nothing.
create function public.claim_draft_send(p_draft_id uuid)
returns setof public.email_drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_branch_status public.branch_status;
begin
  select b.status into v_branch_status
  from public.email_drafts as d
  join public.branches as b on b.id = d.branch_id
  where d.id = p_draft_id
  for share of b;

  if not found then
    return;
  end if;

  return query
  update public.email_drafts as d
  set status = 'sending',
      sending_started_at = now(),
      error = null
  where d.id = p_draft_id
    and d.status = 'draft'
    and d.kind = case v_branch_status
      when 'approved' then 'accept'::public.email_draft_kind
      when 'rejected' then 'decline'::public.email_draft_kind
    end
  returning d.*;
end;
$$;

-- Function privileges

revoke all on function
  public.set_updated_at(),
  public.claim_inbox_message(integer, integer, text),
  public.release_inbox_message(text, boolean, integer, text, integer, integer),
  public.settle_inbox_message(text, public.inbox_message_status, text, integer, integer),
  public.claim_sponsorship(public.sponsorship_status[], integer, integer, uuid),
  public.release_sponsorship(uuid, boolean, integer, text, integer, integer),
  public.settle_sponsorship(uuid, public.sponsorship_status, public.sponsorship_status, uuid, text, text, integer, integer),
  public.retry_sponsorship(uuid),
  public.record_sponsor_reply(text, timestamptz),
  public.reclaim_expired_leases(integer, text),
  public.advance_history_id(text),
  public.delete_video(uuid),
  public.update_branch_script(uuid, text),
  public.decide_branch(uuid, public.branch_status),
  public.claim_draft_send(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.set_updated_at(),
  public.claim_inbox_message(integer, integer, text),
  public.release_inbox_message(text, boolean, integer, text, integer, integer),
  public.settle_inbox_message(text, public.inbox_message_status, text, integer, integer),
  public.claim_sponsorship(public.sponsorship_status[], integer, integer, uuid),
  public.release_sponsorship(uuid, boolean, integer, text, integer, integer),
  public.settle_sponsorship(uuid, public.sponsorship_status, public.sponsorship_status, uuid, text, text, integer, integer),
  public.retry_sponsorship(uuid),
  public.record_sponsor_reply(text, timestamptz),
  public.reclaim_expired_leases(integer, text),
  public.advance_history_id(text),
  public.delete_video(uuid),
  public.update_branch_script(uuid, text),
  public.decide_branch(uuid, public.branch_status),
  public.claim_draft_send(uuid)
to service_role;
