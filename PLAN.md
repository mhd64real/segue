# Segue

A personal dashboard for one YouTube channel. It watches Gmail for sponsorship offers. When one fits a video you are monitoring, an agent writes a new version of that video's script with the sponsor blended in. You approve or reject, and it drafts the reply for you to send.

## 1. The flow

1. Sign in with Google. Only your account gets in. The app gets permission to read and send your Gmail.
2. Videos page: **New video** with a title and a script.
3. Inside a video, turn on **Monitor sponsorships**.
4. A new email arrives. The agent decides: sponsorship or not.
   - Not a sponsorship: ignored, nothing stored.
   - Sponsorship: appears on the Sponsorships page as **Processing**.
5. The agent checks it against every monitored video and picks the single best fit.
   - No fit: status **No fit**, with the reason.
   - Fit: a branch is created on that video, status **Branched**, and the topbar bell shows "New branch".
6. Branch page: original script on the left, branch on the right, sponsor lines highlighted. The branch is editable.
7. **Approve** marks the branch approved and drafts an acceptance reply. **Reject** marks it rejected and drafts a polite decline.
8. Emails page: review, edit, **Send**. It goes out as a reply in the sponsor's original Gmail thread.

## 2. Screens (stock MUI components, theme tokens only)

- **Sidebar:** Videos, Sponsorships, Emails.
- **Topbar:** notification bell (new branches), Gmail monitor health (last checked, last error, Check now), account menu.
- **Videos:** list, New video, and a Video page (edit title and script, monitoring switch, branches with sponsor and status).
- **Branch:** side-by-side view, editable right side, Approve and Reject.
- **Sponsorships:** every sponsorship email with sender, brand, subject, received date, status (Processing, Branched, No fit, Failed), matched video, reason, and Retry on Failed.
- **Emails:** Drafts and Sent tabs. Edit subject and body, then Send.

## 3. Stack

- Next.js App Router, TypeScript, pnpm, deployed on Vercel.
- MUI, stock components.
- Supabase: Postgres and Auth (Google provider).
- Gmail API, with Google Pub/Sub for new-mail notifications.
- Claude API through `@anthropic-ai/sdk`, structured JSON output validated with zod.

## 4. Mail watching

- When the first video gets monitoring on, the app starts a Gmail watch. Google then pushes a Pub/Sub message to `/api/gmail/push` on every inbox change. When the last monitored video is turned off, the watch stops.
- The webhook verifies the Pub/Sub token, reads what changed since the last saved history ID, records new message IDs, answers Google right away, then processes in the background.
- A daily Vercel cron renews the watch (Google expires it after 7 days), syncs anything a push missed, and retries stuck items.
- Every sync saves "last checked" and "last error", shown in the topbar. Failure is never silent.

## 5. The agent

Each step saves its result, so a failure resumes where it stopped.

1. **Classify:** sponsorship or not. If yes, extract brand, product, what they want, offered pay, deadline.
2. **Match:** compare the offer with every monitored video (title and script). Return the best video or no fit, with a one-line reason.
3. **Write branch:** rewrite the script with the sponsor placed at the most natural point, a clean transition in and out, in the script's own voice. The highlights come from diffing original against branch in code, not from the model.
4. **On Approve or Reject:** write the acceptance or decline draft.

- **Model:** Claude Opus 5 for every step. Haiku 4.5 on the classify step is an option if you want it cheaper.
- **Safety:** sponsor emails are untrusted text. The model only returns JSON. It has no tools and cannot send anything. Nothing leaves your Gmail without your Send click.

## 6. Data (Supabase, RLS deny-all, server-side access only)

| Table | Holds |
|---|---|
| `google_account` | email, encrypted refresh token, history ID, watch expiry, last checked, last error |
| `videos` | title, script, monitoring on/off |
| `seen_messages` | Gmail message ID, is sponsorship (dedupe only, no content for normal mail) |
| `sponsorships` | message and thread ID, sender, subject, body, received, brand, offer summary, status, matched video, reason, error |
| `branches` | video, sponsorship, snapshot of the original, branch script, status (pending, approved, rejected) |
| `email_drafts` | sponsorship, branch, kind (accept, decline), to, subject, body, status (draft, sent), sent at |
| `notifications` | branch, read at |

## 7. Build phases

| # | Phase | Done when |
|---|---|---|
| 0 | Setup: repo, Next.js and MUI shell, Supabase project, Vercel project, Google Cloud project (OAuth client, Gmail API, Pub/Sub topic and push subscription), Anthropic key | The empty dashboard is live on Vercel |
| 1 | Sign in: Google with Gmail permissions, one allowed email, refresh token stored encrypted. OAuth app published (you click past "unverified app" once) | You sign in on the live URL, another account is refused |
| 2 | Videos: list, new, edit, monitoring switch | Videos save and reload |
| 3 | Mail watching: watch start and stop, webhook, history sync, daily cron, Check now, topbar health | Emailing yourself updates "last checked" within seconds |
| 4 | Agent: classify, match, write branch, statuses, retry, Sponsorships page | A test sponsorship becomes a branch on the right video, a normal email leaves no trace |
| 5 | Branches: side-by-side with highlights, edit, Approve and Reject, bell | Approve and Reject each create the right draft |
| 6 | Emails: drafts, edit, send as a thread reply, Sent tab | A sent reply shows inside the sponsor's thread in Gmail |
| 7 | Harden: sample email set (real-looking sponsorships, normal mail, brand newsletters, an email that tries to give the agent instructions) run against classify and match, final deploy | Every sample lands in the right status |

## 8. Defaults (accepted 2026-09-13)

- Only your Google account can sign in.
- Only emails that arrive after monitoring is on are checked. No backlog scan.
- A branch is a snapshot. If you edit the original script later, the branch shows "Original changed since this branch".
- Several sponsorships can branch the same video. Approving one does not affect the others.
- The sponsor segment always says clearly that it is sponsored (FTC and YouTube paid promotion rules). Blended into the story, never hidden.
- Once a draft is sent, that branch's decision is locked.
