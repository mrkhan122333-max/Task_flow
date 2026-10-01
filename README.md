# Cosmic Info Solutions — Task Management

Internal task assignment and tracking for **Cosmic Info Solutions**, deployed at
**<https://tasks.cosmicinfosolutions.com>**.

A single self-contained Node/Express process — no build step, no external
database, no third-party services.

- **Roles** — `admin` (full control) and `employee` (their assigned work plus the
  projects they belong to).
- **Employee records** — every account carries a Name, Email address, Department,
  Designation and Role. Accounts can be deactivated, reactivated and have their
  password reset by an Admin.
- **Task lifecycle** — Not Started · In Progress · On Hold · Completed, with
  Critical / High / Medium / Low priority, start & due dates, subtasks,
  attachments and comments.
- **Automatic Overdue** — a task is overdue when it is unfinished and its due date
  is in the past. It is never a stored flag, so it can never go stale.
- **Audit history** — every creation, assignment, status change, date/priority
  edit, comment and file upload is appended to a permanent per-task history that
  cannot be edited or deleted through the API.
- **Dashboards** — Admins see Total / In Progress / Completed / Overdue / Due
  Today across the company; Employees see My Tasks / Due Today / Overdue /
  Completed.
- **No public sign-up** — an Admin provisions every account, or you use the seed
  script for the first one.
- **Security** — salted scrypt password hashes, server-side sessions, CSRF
  protection, a login rate limiter, upload magic-byte checks and server-side
  authorisation on every endpoint.

---

## Quick start (local)

```bash
cd taskflow
npm install
cp .env.example .env          # optional for local dev; defaults work as-is
npm run seed -- --username admin --password "ChangeThisNow!" --role admin
npm start
```

Open <http://localhost:4321/> and sign in as `admin`. Add employees via
**Manage Users**, then create Projects, Tasks and assign them.

> `npm run seed` with no password generates and prints a strong random one.
> Re-run with `--update` to change an account's details or password:
> `npm run seed -- --username admin --password "newpass" --update`

---

## Configuration

Settings are read from the environment, with `.env` in the project root as a
fallback (real environment variables always win). See `.env.example` for the
annotated template.

| Variable            | Default                  | Description                                        |
| ------------------- | ------------------------ | -------------------------------------------------- |
| `NODE_ENV`          | `development`            | **Set `production` in production**                 |
| `PORT`              | `4321`                   | Port the app listens on                            |
| `HOST`              | `0.0.0.0`                | Bind address                                       |
| `BASE_PATH`         | *(empty)*                | Only if the app is served from a subdirectory      |
| `SESSION_SECRET`    | *(required in prod.)*    | 32+ random bytes; signs session tokens & CSRF      |
| `PUBLIC_URL`        | `https://tasks.cosmicinfosolutions.com` | Canonical public origin               |
| `TRUST_PROXY_HOPS`  | `1`                      | Number of trusted `X-Forwarded-*` proxy hops       |
| `DATA_DIR`          | `./data`                 | Folder for `data.json` (persistent volume)         |
| `UPLOAD_DIR`        | `./uploads`              | Folder for attachments (persistent volume)         |
| `SESSION_TTL_DAYS`  | `30`                     | How long a login lasts                             |
| `MAX_UPLOAD_MB`     | `25`                     | Per-file upload limit                              |
| `COOKIE_SECURE`     | `true` in production     | Send cookies only over HTTPS                       |
| `SMTP_HOST`         | *(empty)*                | Optional SMTP server for password-reset e-mails    |
| `SMTP_ENABLED`      | `true` when a host is set | Set `false` to keep credentials parked, unsent   |

**Persistence** — `data/` and `uploads/` hold *all* state (users, projects,
tasks, subtasks, comments, the audit trail, messages and attachments). They must
live on a persistent volume, must be excluded from git (they already are), and
must be backed up. Losing them loses the installation.

---

## Deployment — https://tasks.cosmicinfosolutions.com

The app is a **Node process**, not a WSGI app: there is no Flask or Gunicorn
here. The equivalent production shape is

> one Node process (systemd or Docker) + Nginx terminating TLS in front of it,
> bound to loopback/an internal network only.

### Option A — Docker Compose (recommended)

```bash
cp .env.example .env
# Edit .env: SESSION_SECRET is mandatory, COOKIE_SECURE=true, TRUST_PROXY_HOPS=1
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
docker compose up -d --build
docker compose logs -f
```

`docker-compose.yml` runs the app and an Nginx container on an internal network.
Only Nginx publishes ports 80/443; the Node port is never exposed. The app
container's `/app/data` and `/app/uploads` are named volumes, so state survives
rebuilds. Nginx waits for the app's `/api/health` check and re-resolves the app
container on every request, so restarting the app never causes a stale 502.

Obtain the certificate once:

```bash
mkdir -p deploy/certbot/conf deploy/certbot/www
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d tasks.cosmicinfosolutions.com --agree-tos -m admin@cosmicinfosolutions.com
```

Then reload Nginx: `docker compose exec proxy nginx -s reload`.
Renew automatically with a `certbot renew` cron entry.

### Option B — bare metal with systemd + Nginx

```bash
sudo useradd --system --home /opt/cosmic-tasks --shell /usr/sbin/nologin cosmic-tasks
sudo mkdir -p /opt/cosmic-tasks
sudo cp -r . /opt/cosmic-tasks
sudo chown -R cosmic-tasks:cosmic-tasks /opt/cosmic-tasks
cd /opt/cosmic-tasks && sudo -u cosmic-tasks npm ci --omit=dev

sudo install -m 600 -o cosmic-tasks -g cosmic-tasks .env /etc/cosmic-tasks.env
sudo cp deploy/systemd/cosmic-tasks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cosmic-tasks
sudo systemctl status cosmic-tasks
```

Nginx then proxies to `127.0.0.1:4321`:

```nginx
server {
    listen 443 ssl;
    server_name tasks.cosmicinfosolutions.com;

    ssl_certificate     /etc/letsencrypt/live/tasks.cosmicinfosolutions.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tasks.cosmicinfosolutions.com/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:4321;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

A complete, ready-to-use server block is in
`deploy/nginx/tasks.cosmicinfosolutions.com.conf`.

### Creating the first Admin on the server

```bash
cd /opt/cosmic-tasks
sudo -u cosmic-tasks COSMIC_ADMIN_USERNAME=admin \
  COSMIC_ADMIN_PASSWORD='<strong password>' \
  COSMIC_ADMIN_NAME='System Administrator' \
  npm run seed
# or, inside Docker:
docker compose exec -e COSMIC_ADMIN_PASSWORD='<strong password>' app npm run seed
```

Everything else — additional employees, departments, resets — is done from the
**Manage Users** screen.

### Production checklist

- [ ] `NODE_ENV=production`
- [ ] `SESSION_SECRET` set to 32+ random bytes and **not** committed
      (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))`;
      the server refuses to start on the `.env.example` placeholder)
- [ ] `COOKIE_SECURE=true` (the default in production)
- [ ] `TRUST_PROXY_HOPS` matches your real proxy depth (1 for a single Nginx)
- [ ] Node port not reachable from the internet — only the proxy is exposed
- [ ] `data/` and `uploads/` on persistent, backed-up storage
- [ ] TLS certificate installed and auto-renewing
- [ ] The process auto-restarts (systemd `Restart=always` / `restart: unless-stopped`)
- [ ] `.env` is `chmod 600` and owned by the **service user** (`cosmic-tasks`), so
      systemd can read `/etc/cosmic-tasks.env` as `User=cosmic-tasks`
- [ ] `GET /api/health` returns `200` from your monitoring

No `DEBUG` flag is used anywhere: there is no development mode to accidentally
leave switched on, and production errors return a generic message while the full
error goes to the service log only.

---

## Roles and permissions

| Capability                              | Admin | Employee |
| --------------------------------------- | :---: | :------: |
| Create / edit / deactivate users        |  ✅   |    —     |
| Reset anyone's password                 |  ✅   | own only |
| Create / edit / delete projects         |  ✅   |    —     |
| Create / delete / edit any task         |  ✅   |    —     |
| Oversight view of every task            |  ✅   |    —     |
| View / update assigned tasks            |  ✅   |   ✅     |
| View / update tasks in their projects   |  ✅   |   ✅     |
| Change status, subtasks, comments, files | ✅  |   ✅     |
| Read a task's audit history             |  ✅   |   ✅     |
| Message anyone                          |  ✅   |   ✅     |

Task access is enforced server-side on **every** endpoint — list, detail,
comments, attachments, audit history and search. An employee sees a task if it
is assigned to them **or** its project lists them in `memberIds`.

Deactivating an employee signs them out immediately, blocks sign-in, and hides
them from assignee lists — while keeping every task, comment and attachment they
created so history and audit trails stay intact.

---

## Task rules

| Field       | Values                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| Status      | `Not Started` · `In Progress` · `On Hold` · `Completed`                 |
| Priority    | `Critical` · `High` · `Medium` · `Low`                                  |
| **Overdue** | Derived: unfinished **and** due date is before today                     |
| **Due today** | Derived: unfinished **and** due date is today                           |

Overdue and Due Today are computed on the server for every request, so a
dashboard left open overnight is never stale. Moving a task to *In Progress*
without a start date records today; moving it to *Completed* records the
completion timestamp, and reopening it clears that timestamp.

**Filters** (board and list): status, priority, project, assignee (admin),
overdue-only, and due window (overdue / today / next 7 days / next 30 days /
no due date), plus sorting by updated, created, due date or priority.

---

## Audit history

Each task keeps an append-only history of who did what and when: creation,
assignment, status changes, priority/due/start date edits, project moves,
comments and file uploads. Entries are written by the server only — there is no
API to modify or delete them, and they are purged only when the task itself is
deleted. It is visible at the bottom of the task detail drawer and through
`GET /api/tasks/:id/activity`.

---

## Security summary

- Passwords stored as salted **scrypt** hashes; never plain text, never logged.
- Sessions: 256-bit random tokens; only an HMAC digest is stored; `httpOnly`,
  `SameSite=Lax` cookies, and they are `Secure` in production.
- Deactivating a user destroys their sessions immediately.
- CSRF: double-submit cookie (`cosmic_csrf`) checked against `X-CSRF-Token` on
  every state-changing API call (login exempt).
- Uploads: strict extension allow-list, sanitised filenames, and a magic-byte
  check so a renamed executable cannot be served as a PDF. Files stream with
  `nosniff`.
- All user data is HTML-escaped in the UI and validated server-side.
- Security headers on every response: CSP, `nosniff`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, and HSTS whenever the request arrived
  over HTTPS.

---

## Project structure

```
taskflow/
├─ package.json            deps + scripts (start / dev / seed / check / docker)
├─ server.js               entry point: security headers, API mount, SPA, shutdown
├─ Dockerfile              single-stage production image, non-root
├─ docker-compose.yml      app + Nginx on an internal network
├─ .env.example            documented production environment
├─ deploy/
│  ├─ nginx/tasks.cosmicinfosolutions.com.conf
│  └─ systemd/cosmic-tasks.service
├─ scripts/
│  ├─ seed.js              create/update the first Admin from the shell
│  └─ lint.js              syntax-check every .js file (npm run check)
├─ src/
│  ├─ config.js            env loading (no dotenv dependency) + config object
│  ├─ db.js                JSON-file store (atomic writes, corruption backup, migrations)
│  ├─ lib/
│  │  ├─ crypto.js         scrypt hashing, tokens, HMAC digests, constant-time compare
│  │  ├─ activity.js       append-only audit trail helpers
│  │  ├─ mailer.js         minimal SMTP client for password-reset e-mails
│  │  └─ validate.js       validation, RBAC, overdue rules, public projections
│  ├─ middleware/
│  │  ├─ auth.js           sessions, role guard, CSRF
│  │  ├─ rbac.js           task/project access rules
│  │  └─ uploads.js        multer setup, allow-list, magic bytes
│  └─ routes/
│     ├─ auth.js           login/logout/me (+ brute-force limiter)
│     ├─ users.js          employee admin CRUD, deactivate/reactivate, password reset
│     ├─ projects.js       admin CRUD + member management
│     ├─ tasks.js          listing, CRUD, status, subtasks, audit writes
│     ├─ comments.js       task comments (+ file links, audit)
│     ├─ files.js          upload/download/list/delete (+ audit)
│     ├─ activity.js       read-only task history
│     ├─ stats.js          dashboard metrics + workload + headcount
│     ├─ messages.js       inbox + 1:1 threads + read receipts
│     └─ search.js         global search (scoped)
└─ public/                 SPA (no build step)
   ├─ index.html
   ├─ css/app.css
   └─ js/
      ├─ app.js            bootstrap, hash router, event wiring
      ├─ api.js            fetch wrapper (JSON, uploads, CSRF header)
      ├─ store.js          cached state + pub/sub
      ├─ util.js           escaping, dates, status/priority/role metadata
      ├─ components.js     avatars, badges, toasts, modals, task cards, audit trail
      └─ views/
         ├─ login.js       sign-in screen
         ├─ layout.js      sidebar + top bar + global search
         ├─ home.js        role-aware dashboard
         ├─ tasks.js       board / list with filters + drag & drop
         ├─ projects.js    project list + admin CRUD
         ├─ messages.js    chat (3 s polling)
         ├─ users.js       employee management
         └─ taskDetail.js  slide-out task drawer (incl. Activity history)
```

## API

All endpoints are under `/api` and require a session except `/auth/login` and
`/health`.

| Method   | Path                              | Access                |
| -------- | --------------------------------- | --------------------- |
| `POST`   | `/auth/login`                     | public                |
| `GET`    | `/auth/me`                        | any signed-in user    |
| `POST`   | `/auth/logout`                    | any signed-in user    |
| `GET`    | `/users`                          | any signed-in user    |
| `GET`    | `/users/departments`              | any signed-in user    |
| `POST`   | `/users`                          | admin                 |
| `PUT`    | `/users/:id`                      | admin                 |
| `POST`   | `/users/:id/active`               | admin                 |
| `POST`   | `/users/:id/reset-password`       | admin                 |
| `DELETE` | `/users/:id`                      | admin                 |
| `GET`    | `/projects`, `/projects/:id`       | scoped by membership  |
| `POST`   | `/projects`                       | admin                 |
| `PUT`    | `/projects/:id`                   | admin                 |
| `DELETE` | `/projects/:id`                   | admin                 |
| `GET`    | `/tasks`                          | RBAC-scoped           |
| `POST`   | `/tasks`                          | admin                 |
| `GET`    | `/tasks/:id`                      | task access           |
| `PUT`    | `/tasks/:id`, `/:id/status`       | admin / task access   |
| `DELETE` | `/tasks/:id`                      | admin                 |
| `POST`   | `/tasks/:id/subtasks`             | admin / task access   |
| `PUT`    | `/tasks/:id/subtasks/:subId`      | admin / task access   |
| `GET`    | `/tasks/:id/comments`             | task access           |
| `POST`   | `/comments`                       | task access           |
| `DELETE` | `/comments/:id`                   | author or admin       |
| `GET`    | `/tasks/:id/files`                | task access           |
| `POST`   | `/upload`                         | task access           |
| `DELETE` | `/files/:id`                      | uploader or admin     |
| `GET`    | `/tasks/:id/activity`             | task access           |
| `GET`    | `/activity/recent`                | RBAC-scoped           |
| `GET`    | `/stats`                          | any signed-in user    |
| `GET`    | `/stats/workload`, `/stats/headcount` | admin              |
| `GET`    | `/inbox`, `/conversations/:id`    | any signed-in user    |
| `POST`   | `/messages`, `/conversations/:id/read` | any signed-in user |
| `GET`    | `/search`                         | scoped                |
| `GET`    | `/health`                         | public                |

## Verification

```bash
npm run check      # syntax-checks all JavaScript (server + browser modules)
```

There is no test framework by design; `check` guarantees every file at least
parses, which combined with the validation/authorisation rules above covers the
main failure modes.

## Requirements

- Node.js **>= 18**
- Dependencies: `express` and `multer` only
- Production: Nginx (or equivalent) in front of the process, TLS terminated there
