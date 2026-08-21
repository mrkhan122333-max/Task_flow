# TaskFlow — Asana-style Project & Task Manager

A Flask-based project management app with role-based access control
(RBAC) and Gmail email notifications, built to mirror Asana's
navigation and visual style.

## Features

- Projects with member lists and a status-column board view (To do /
  In progress / Complete)
- Tasks with title, description, due date, priority, status, and
  assignee
- Subtasks and threaded comments on each task
- Dashboard showing your tasks and project progress bars
- Email/password signup & login (Flask-Login)
- Two enforced roles:
  - **Admin** — full control: create/edit/delete tasks & projects,
    reassign, change dates, manage everyone's role
  - **Analyst** — can only view tasks they're a member of, and may
    toggle the status of tasks *assigned to them* between complete /
    incomplete. Every other write route rejects analysts with a
    403, enforced server-side via a `@role_required(...)` decorator
    — not just hidden buttons.
- Gmail notifications for: task assigned, status changed, due date
  approaching, project invite sent, invite accepted, and new direct
  messages (checked by a background job every N hours, or sent
  immediately for the invite/message events)
- **Team invitations**: an admin invites anyone by email from a
  project's **Team** tab. New addresses get a real emailed signup
  link (72h expiry, configurable); addresses that already have an
  account are added to the project immediately, no signup needed.
  Invite status (Pending / Accepted / Expired) is tracked and shown
  live, with Resend / Cancel actions.
- **Direct messaging**: a private, per-project, 1-on-1 inbox between
  each Admin and each Analyst on a project (**Messages** tab).
  Analysts can only message the project's Admin(s) — never other
  analysts — to preserve the reporting structure. Unread counts and
  email notifications keep people in the loop without needing to stay
  logged in.

## 1. Setup

```bash
cd asana_clone
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Configure (optional but recommended)

```bash
cp .env.example .env
```

Open `.env` and set:
- `SECRET_KEY` — any random string (a command to generate one is in
  the comments of `.env.example`)
- `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` — see below

**You can skip this step entirely.** Without Gmail credentials, the
app still runs fully — it just prints emails to the console instead
of sending them, so you can see exactly what notification would have
gone out.

### Setting up Gmail sending

1. Turn on 2-Step Verification on the Gmail account:
   https://myaccount.google.com/security
2. Create an App Password (choose "Mail"):
   https://myaccount.google.com/apppasswords
3. Put the Gmail address and the 16-character app password into
   `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` in `.env`.

This uses Gmail's SMTP relay. It is the zero-setup default and is
enough on its own to run everything, including invite/message emails.

### Setting up the real Gmail API (OAuth2) — optional, additive

The invite/message notifications spec asked for actual sending via
the **Gmail API with OAuth2**, on top of the SMTP path above. This is
implemented in `gmail_oauth.py` / `email_service.py` and is fully
optional — if you skip this section, invite and message emails still
send fine over the SMTP path (or log to console if you skipped that
too).

To turn it on:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create a project, enable the **Gmail API**, and create an OAuth
   client of type **Desktop app**.
2. Download its client secrets JSON and save it as
   `asana_clone/client_secret.json` (or point
   `GOOGLE_OAUTH_CLIENT_SECRETS_FILE` in `.env` elsewhere).
3. Run the one-time interactive setup:
   ```bash
   python scripts/gmail_oauth_setup.py
   ```
   This opens a browser for consent (scope: `gmail.send` only — this
   app never reads your mailbox) and writes `token.json`
   (`GOOGLE_OAUTH_TOKEN_FILE`) with an access + refresh token.
4. From then on, every invite/message notification is sent through
   the real Gmail API first. `gmail_oauth.py` automatically refreshes
   the access token on every send (they expire hourly; the refresh
   token does not) and re-persists it to `token.json` — no manual
   re-auth needed unless the refresh token itself is revoked from
   your Google Account's security settings, in which case re-run step
   3. If a Gmail API send ever fails (network issue, revoked token,
   etc.), it automatically falls back to the SMTP path above rather
   than losing the notification.

**Not live-tested**: sending a real message through the Gmail API
requires your own Google Cloud OAuth client and a consent-granted
`token.json`, neither of which can exist in this environment. What
*was* verified automatically (see `smoke_test.py`): the module
imports cleanly whether or not the Google client libraries are
installed, `is_configured()` correctly reports `False` when no
`token.json` is present (so the app degrades gracefully to SMTP), and
`email_service.py`'s fallback-on-exception logic. Please run
`scripts/gmail_oauth_setup.py` with your own credentials and send one
real invite to confirm delivery end-to-end before relying on it in
production.

## 3. Database setup — none needed

`python app.py` handles this automatically. TaskFlow uses
Flask-Migrate (Alembic) to manage the schema, and `app.py` runs the
migrations itself on startup (see `_auto_migrate()` in `app.py`) - so
there's no separate command to remember, on a brand new checkout, on
an existing database from an earlier version of this app, or after
pulling a future update that adds another migration. Just run the
app (step 4 below) and it brings the DB up to date before serving any
requests.

If you'd rather control migrations explicitly yourself (e.g. as a
separate step in a deploy pipeline, so schema changes never happen
silently at boot), set `AUTO_MIGRATE=false` in `.env` and run:
```bash
flask db upgrade
```
And if you're doing that on an app.db from *before* this app used
Alembic at all (tables exist, but there's no `alembic_version` table
yet), tell Alembic where you actually are first:
```bash
flask db stamp 0b003ebbc203   # marks you at the pre-migrations baseline, without touching data
flask db upgrade              # applies everything newer
```
(`_auto_migrate()` does exactly this stamp-then-upgrade sequence
automatically when `AUTO_MIGRATE` is left on - this manual version is
only needed if you've turned that off.)

## 4. Run

```bash
python app.py
```

Visit **http://127.0.0.1:5000**. The first account you sign up with
is automatically made an **admin** (so there's always at least one
admin on a fresh install); every account after that defaults to
**analyst**. Promote/demote people from **People** in the sidebar
(admin-only), invite them straight onto a project from that
project's **Team** tab, and check overall progress from **Analytics**
(admin-only).

## Project structure

```
asana_clone/
├── app.py                    # App factory / entry point (registers all 6 blueprints)
├── config.py                 # Env-based configuration (flagged assumptions inline)
├── extensions.py             # db / login_manager / mail / migrate singletons
├── models.py                 # User, Project, Task, Subtask, Comment,
│                              #   ProjectMembership, ProjectInvite, Message,
│                              #   CommentAttachment
├── decorators.py              # @role_required — server-side RBAC enforcement (reused everywhere)
├── text_utils.py               # linkify() — safe URL auto-linking for comments
├── attachments.py               # Comment file uploads: validate, store, serve, delete
├── analytics.py                  # Admin analytics dashboard + JSON chart-data endpoint
├── email_utils.py                 # Original task-notification Gmail/SMTP helpers
├── email_service.py                # Invite/message notifications (tries Gmail API
│                                    #   OAuth2 first, then SMTP, then console — see below)
├── gmail_oauth.py                   # Gmail API OAuth2 client (token refresh handled here)
├── invites.py                        # Admin invite create/resend/cancel + public accept flow
├── messaging.py                       # Admin<->Analyst 1-on-1 direct messaging
├── scheduler.py                        # Background job for "due date approaching" emails
├── scripts/gmail_oauth_setup.py         # One-time interactive OAuth2 consent script
├── migrations/                           # Flask-Migrate/Alembic - see "Set up the database"
│   └── versions/
│       ├── 0001_baseline_schema.py         # schema as of the invites/messaging delivery
│       └── 0002_add_start_date_and_comment_attachments.py
├── auth/                                   # signup / login / logout blueprint
├── main/                                    # dashboard / projects / tasks / team / admin blueprint
├── templates/                                # Jinja2 templates (Asana-style dark sidebar)
│   ├── invites/accept.html
│   ├── messaging/{inbox,thread}.html
│   ├── projects/team.html
│   └── admin/dashboard.html                    # Chart.js graphs + project/analyst tables
├── uploads/comments/                             # comment attachment storage (outside static/)
├── static/css/style.css
├── requirements.txt
└── .env.example
```

## Start date + due date, rich comments, and analytics — how they work

**Start/due dates** (`main/routes.py`'s `task_new`/`task_edit`,
`models.Task.start_date`):
- Both are optional `db.Date` fields; the only rule is that *if both
  are set*, start ≤ due, enforced server-side in
  `_validate_task_dates()` on both create and edit, with a flash
  error and the form re-rendered with what was typed (not silently
  discarded).
- `Task.is_overdue()` is untouched - still keys off `due_date` alone,
  exactly as before, so overdue badges/sorting don't regress.
- Task cards and the task detail page show "Start → Due" as a single
  timeline field, Asana-style.

**Rich comments** (`text_utils.linkify`, `attachments.py`,
`models.CommentAttachment`):
- URLs in a comment are auto-linked via `linkify()`, which escapes
  the *entire* comment body first and only then wraps `http(s)://`
  matches in generated `<a>` tags - so a comment containing
  `<script>` or `onerror=` renders as inert text, not executable
  markup. See `text_utils.py`'s module docstring for the full
  security reasoning.
- Attachments are validated against a **whitelist** (jpg/jpeg/png,
  pdf/docx, xlsx/csv), capped at 10MB, and written to disk under a
  **randomized filename** in `uploads/comments/` - a sibling of, not
  inside, `static/` - specifically so a leaked/guessed URL can't
  bypass the per-project membership check every download goes
  through (`attachments.serve_attachment`). Deleting an attachment
  removes the DB row and the file (via a SQLAlchemy `after_delete`
  event, so cascade-deletes of a comment/task/project clean up their
  files too, not just explicit attachment deletes) - only the
  comment's author or an admin can delete it.

**Admin analytics dashboard** (`analytics.py`,
`templates/admin/dashboard.html`, `/admin/dashboard`):
- Admin-only via the same `@role_required(ROLE_ADMIN)` decorator used
  everywhere else in the app - no new permission system.
- Two Chart.js charts (tasks-by-status bar chart, created-vs-completed
  line chart over the last 14 days) are fed by a separate JSON
  endpoint (`/admin/dashboard/data`) so the numbers are always a live
  query result; per-project and per-user tables are rendered
  server-side from real SQLAlchemy aggregations (`_per_project_stats`,
  `_per_user_stats` in `analytics.py`) and reuse the existing
  `Project.progress_percent()` / `Task.is_overdue()` logic rather than
  recomputing it. The analyst table sorts client-side on header click
  (plain JS, no new dependency).
- **Flagged assumption**: there's no dedicated `completed_at` column
  on `Task`, so "completed over time" uses `updated_at` (refreshed
  automatically whenever `status` changes) as a proxy for "the day
  this task most recently became complete." Accurate for the normal
  case; can be imprecise if a task is toggled complete/incomplete
  more than once on the same day. Adding a real `completed_at` column
  was left out since the spec's migration list only asked for
  `start_date` + `CommentAttachment` - see `analytics.py`'s module
  docstring for how to tighten this later.

## Team invitations & messaging — how it works


**Invitations** (`invites.py`, Team tab on each project):
- Admin enters an email + picks a role (Admin or Analyst) *for that
  project*. If the address already has an account, they're added to
  the project immediately (no signup step needed). Otherwise a
  32-byte random token is generated, stored on `ProjectInvite`, and
  emailed as a `/invites/<token>` link that expires after
  `INVITE_EXPIRY_HOURS` (default 72).
- The accept page (no login required — the token *is* the
  credential) lets the invitee set a name + password, creates their
  `User` row with the invited role, adds them to the project, and
  logs them straight in.
- **Duplicate-invite guard**: creating a second invite to the same
  email on the same project while one is still pending is rejected
  with a flash message, checked both at the application layer (a
  query before insert) and as a DB-level composite index as a
  backstop for the narrow race window a naive check-then-insert has
  under concurrent double-submits.
- Resend rotates the token and expiry (old link stops working);
  Cancel deletes the invite row outright.

**Messaging** (`messaging.py`, Messages tab on each project):
- Strictly Admin ↔ Analyst, one project at a time. An analyst can
  never message another analyst — enforced server-side in
  `_assert_valid_partner()`, not just hidden in the UI, so hitting the
  endpoint directly (curl/Postman) with another analyst's user id
  still gets a 403.
- Both participants must actually be members of the project the
  thread is scoped to; messages can't leak across projects even if
  the same two people share more than one.
- Every new message triggers an email to the recipient (in addition
  to appearing in-app), and opening a thread marks the other
  person's messages as read (`Message.read_at`) so unread badges stay
  accurate.

## Assumptions made (flagged per your instructions)

1. **Database**: SQLite for zero-setup local use. Swap
   `DATABASE_URL` in `.env` for a Postgres/MySQL URI for production —
   no code changes needed since it's all SQLAlchemy.
2. **Gmail integration**: implemented via SMTP + App Password rather
   than the full Gmail API OAuth2 flow, because OAuth2 requires a
   registered Google Cloud project, consent screen, and token-refresh
   handling that can't be configured without your own Google Cloud
   credentials. SMTP + App Password sends through the same Gmail
   servers with two env vars. Swap-in path for true OAuth2 is noted
   in `email_utils.py`.
3. **First user = admin**: since a brand-new install has no users at
   all, the very first signup is auto-promoted to admin so someone
   can actually manage roles. All later signups default to analyst.
4. **Due-date reminders**: run via an in-process APScheduler job
   (interval configurable in `.env`) rather than an external cron
   service, so the whole notification system works out of the box
   with just `python app.py`.
5. **Hosting**: designed for local/dev use via `python app.py`
   (Flask's built-in server). For production, run behind a WSGI
   server (gunicorn/uwsgi) — not included here since it wasn't asked
   for, but the app factory pattern in `app.py` makes that a drop-in
   change (`gunicorn "app:app"`).
6. **"Entering their Gmail address"** (invite spec) is read as "an
   email address, delivered via Gmail" rather than a hard
   `@gmail.com`-only restriction, since blocking Google Workspace
   addresses (which use Gmail but aren't `@gmail.com`) would almost
   certainly be the wrong call. A commented-out one-line check in
   `invites.py` flips this to a strict `@gmail.com` requirement if
   that's actually what's wanted.
7. **Admin-to-admin messaging is out of scope**: the spec describes
   Admin↔Analyst messaging and analysts being restricted from
   messaging other analysts; it doesn't ask for admin-to-admin DMs,
   so `messaging.py` doesn't add them. Straightforward to add later
   by relaxing `_assert_valid_partner()` if wanted.
8. **Per-project role vs. account role**: `ProjectMembership.role`
   (the role picked at invite time) is independent of `User.role`
   (the account-wide role `main/routes.py` already used for all
   permission checks). All RBAC in this update — who can invite, who
   can message whom — continues to key off the account-wide role,
   exactly like the pre-existing codebase did; the per-project role
   is additive and used for what's *displayed* on the Team tab.
9. **Real Gmail API OAuth2 sending was not live-tested** — see
   "Setting up the real Gmail API" above for exactly what was and
   wasn't verified, and why (no Google Cloud credentials exist in
   this environment).
10. **"Completed over time" uses `updated_at` as a proxy for
    completion date** (no dedicated `completed_at` column was added -
    see the Analytics section above for the full reasoning).
11. **Attachment "who uploaded it" = the comment's author**: since a
    file is attached to a comment in the same form submission that
    creates it, `CommentAttachment` doesn't carry its own uploader
    column (matching the exact schema you specified) - permission
    checks use `attachment.comment.user_id`.
12. **Extension whitelist is deliberately narrow**: exactly
    jpg/jpeg/png, pdf/docx, xlsx/csv per the spec's examples - nothing
    broader (no gif/webp/pptx/txt/zip) was added on the assumption
    that an explicit list beats guessing at what else might be
    wanted; extending `attachments.ALLOWED_EXTENSIONS` is a one-line
    change if more types are needed.
13. **Auto-linking is `http(s)://`-prefixed URLs only**, per the
    spec ("only auto-link http(s):// patterns") - bare domains like
    `example.com` (no scheme) are intentionally left as plain text
    rather than guessed at, since guessing schemes for arbitrary text
    is exactly the kind of ambiguity that leads to false-positive
    links.
14. **Existing-DB migration path requires one extra manual step**
    (`flask db stamp <baseline>` before `flask db upgrade`) - this is
    inherent to adopting Alembic on a database that already has
    tables Alembic doesn't know about yet; it's a one-time step per
    existing install, documented above in "Set up the database."

## Changelog (every file touched in this update)

**Bugfix (post-delivery):** the previous version of this update
required manually running `flask db upgrade` before the app's tables
existed, which produced `sqlalchemy.exc.OperationalError: no such
table: user` on login for anyone who just ran `python app.py`
directly - a bad default. Fixed by having `app.py` run migrations
itself on startup (`_auto_migrate()`), including auto-detecting and
stamping a pre-Alembic database so existing installs upgrade
transparently too. See "Database setup — none needed" above.
Touched: `app.py` (added `_auto_migrate()`), `config.py` (added
`AUTO_MIGRATE`), `smoke_test.py` (added a real, non-TESTING-mode
startup check that reproduces the exact reported error and confirms
the fix - see "Verified before delivery" below).

**New files:**
- `text_utils.py` - safe URL auto-linking (`linkify` Jinja filter)
- `attachments.py` - comment file upload/serve/delete + validation
- `analytics.py` - admin dashboard routes + JSON chart-data endpoint
- `templates/admin/dashboard.html` - analytics page (Chart.js + tables)
- `migrations/` (new directory) - Flask-Migrate/Alembic setup,
  `versions/0001_baseline_schema.py`, `versions/0002_add_start_date_and_comment_attachments.py`

**Modified files:**
- `models.py` - added `Task.start_date`; added `CommentAttachment`
  model; added `Comment.attachments` relationship
- `main/routes.py` - `task_new`/`task_edit` now parse, validate
  (`start_date <= due_date`), and persist `start_date`; added
  `_validate_task_dates()`; `comment_add` now accepts an optional
  file upload alongside the comment body
- `app.py` - registers `attachments_bp` and `analytics_bp`; registers
  the `linkify` Jinja filter; wires up `Flask-Migrate`; removed the
  unconditional `db.create_all()` in favor of `flask db upgrade`
  (still calls `db.create_all()` for `TESTING` config, so
  `smoke_test.py`'s in-memory DB is unaffected); added a 413
  (payload-too-large) error handler
- `extensions.py` - added the `migrate = Migrate()` singleton
- `config.py` - added `COMMENT_UPLOAD_FOLDER` and `MAX_CONTENT_LENGTH`
- `requirements.txt` - added `Flask-Migrate`
- `templates/tasks/new.html`, `templates/tasks/edit.html` - added
  Start date field; forms now re-populate from the submitted values
  on a validation error instead of resetting
- `templates/tasks/detail.html` - "Timeline" (Start → Due) replaces
  the old due-date-only line; comments render via `|linkify`; comment
  form now accepts a file (`enctype="multipart/form-data"`);
  attachments render as an image thumbnail or a download link, with
  a delete button gated on uploader-or-admin
- `templates/projects/board.html` - task cards show the Start → Due
  timeline when a start date is set
- `templates/base.html` - added the admin-only "Analytics" nav link
- `static/css/style.css` - styles for the date-range row, attachment
  list/thumbnails, and the analytics dashboard (chart grid, sortable
  table, progress bars)
- `smoke_test.py` - extended with checks for date validation
  (valid/invalid/date-optional cases), `is_overdue()` non-regression,
  link auto-detection + XSS escaping, attachment upload success/
  rejection (bad extension, oversized file), attachment permission
  checks (view/delete), and dashboard data accuracy + RBAC
- `README.md` - this changelog, the new "Set up the database"
  migration instructions, and the "Start date + due date, rich
  comments, and analytics" section above

**Untouched, verified still working:** `auth/`, `invites.py`,
`messaging.py`, `email_service.py`, `email_utils.py`,
`gmail_oauth.py`, `scheduler.py`, `decorators.py` - no changes were
needed; all existing RBAC/invite/messaging smoke-test checks
(sections 1-12 in `smoke_test.py`) still pass unmodified.

## Verified before delivery

Four layers of testing were run against this codebase, not just
visual inspection:

1. **Original task/project features** (pre-existing, re-verified
   after these changes): admin/analyst signup, task CRUD, 403s on
   analyst write attempts outside their assigned tasks, and status
   toggling.
2. **Invite + messaging features** (from the previous update,
   re-verified unmodified after this one) and **start date / rich
   comments / analytics dashboard** (new in this update) —
   `smoke_test.py` (included in this delivery; run it yourself with
   `python smoke_test.py`) drives the whole stack through Flask's
   test client against a real in-memory SQLite DB and asserts on
   actual database state, not just HTTP status codes. **84/84 checks
   pass.** New in this update, it explicitly confirms:
   - A task with `start_date <= due_date` is created correctly, with
     both fields stored exactly as submitted
   - A task with `start_date > due_date` is rejected with a flash
     error and NOT created, on both the create and edit forms
   - A task with only a `due_date` (no `start_date`) is still
     accepted - the rule only applies when both are present
   - `Task.is_overdue()` still keys off `due_date` alone even when a
     `start_date` is also set - no regression
   - A comment body containing a raw `http(s)://` URL renders as a
     clickable `<a>` tag
   - A comment body containing a raw `<script>` tag is HTML-escaped
     in the rendered page, not executed - the core XSS check
   - A valid image upload (real PNG bytes) is saved, categorized as
     `image`, written to disk under a **randomized** filename (not
     the original), and that the upload directory is **not** inside
     `static/`
   - A disallowed extension (`.exe`) is rejected and never reaches
     the DB or disk
   - An oversized file (>10MB) is rejected and never reaches the DB
   - A project member can download an attachment; a project member
     who did NOT upload it is blocked (403) from deleting it; a
     complete non-member of the project is blocked (403) from even
     viewing it
   - The uploader successfully deletes their own attachment, and the
     file is confirmed removed from disk (not just the DB row)
   - The admin dashboard page and its JSON data endpoint both load
     (200) for an admin and are blocked (403) for an analyst
   - The JSON endpoint's `status_counts` are cross-checked against an
     independent, direct DB query (not just "the endpoint returned
     something") to confirm the chart data is real, not mocked
   - **The exact reported bug**: a real (non-`TESTING`) `create_app()`
     against a brand-new, empty, file-backed SQLite DB - i.e. the
     literal `python app.py` + fresh signup + login flow from the bug
     report - succeeds with no manual commands, and the response body
     is checked to confirm no `"no such table"` error leaks through.
     This check was confirmed to actually fail with the original
     `sqlite3.OperationalError: no such table: user` traceback when
     temporarily reverted, proving it would catch a regression, not
     just pass trivially.
3. **Database migrations** — verified with the actual Flask-Migrate/
   Alembic tooling, not hand-typed SQL or assumptions:
   - **Fresh-install path**: `flask db upgrade` against an empty DB
     was run and the resulting schema inspected directly (via
     `sqlite3`) to confirm every table and column - including
     `task.start_date` and `comment_attachment` - exists exactly as
     `models.py` defines them.
   - **Existing-install path**: a separate DB was seeded with the
     *old* schema (via `db.create_all()`, exactly how the app used to
     initialize a DB before this update) and real data - 2 users, a
     project, a task, and a comment. `flask db stamp <baseline>` then
     `flask db upgrade` was run against it (the exact commands in
     "Database setup" above), and every row was re-queried
     afterward to confirm **zero data loss**, with the new
     `task.start_date` column correctly `NULL` on the pre-existing
     row (not some guessed default) and `comment_attachment` present
     as an empty new table.
4. **Automatic migration on startup** (`_auto_migrate()` in
   `app.py`) - three real scenarios, each run against the real,
   unmodified `app.py`/`create_app()`, not a simulation:
   - **Brand new checkout**: an empty file-backed SQLite DB, `python
     app.py`-style startup, signup + login with no manual commands -
     succeeds (this is the scenario from the bug report).
   - **Legacy pre-migrations DB**: a DB seeded with the *old* schema
     and real data (a user, project, task, and comment) and
     deliberately no `alembic_version` table - starting the real app
     against it auto-detects this, stamps the baseline, upgrades, and
     every piece of seeded data was re-queried afterward and
     confirmed present, with the new admin dashboard immediately
     accessible.
   - **Idempotency**: starting the app a second time against an
     already-current DB is a safe no-op - no errors, no duplicated
     rows.
   - **Opt-out**: `AUTO_MIGRATE=false` was confirmed to actually skip
     migration on startup (no tables created), for anyone who wants
     to manage schema changes as an explicit deploy step instead.
   
   Every page (dashboard, project list/board/team/messages/new-task/
   edit-task/detail, admin users, admin analytics dashboard,
   invite-accept) was also hit directly through the real app factory
   and confirmed to render with HTTP 200 and no Jinja template
   errors, and all 30 registered routes were enumerated and checked
   for import-time errors.

**What could not be verified without live external credentials** (see
assumption #9): an actual send through the real Gmail API. Everything
up to that boundary — MIME construction, token-refresh logic, and the
fallback path when it's unavailable — was verified; the network call
to Google itself was not.
