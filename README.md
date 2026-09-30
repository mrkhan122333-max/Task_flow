# TaskFlow

An Asana-style project management tool for **Cosmic Info Solutions**, designed to
run as a single self-contained Node process behind your existing web server.

- **No external database** — everything lives in two folders the app creates
  itself: `data/data.json` (JSON persistence) and `uploads/` (file attachments).
- **No public sign-up** — an Admin provisions every account (or you use the seed
  script for the first one).
- **Two roles** — `admin` (full control) and `analyst` (their assigned work).
- **Session auth + CSRF** — salted scrypt password hashes, server-side sessions,
  double-submit CSRF protection, and a login brute-force limiter.
- **Polling chat** — direct 1:1 messages refresh every 3 seconds, no third-party
  service required.

---

## Quick start (local)

```bash
cd taskflow
npm install
npm run seed -- --username admin --password "ChangeThisNow!" --role admin
npm start
```

Open <http://localhost:4321/> and sign in as `admin` with the password you set.
Add more users via **Manage Users** (admin only), then create Projects, Tasks
and assign them to analysts.

> `npm run seed` alone generates and prints a strong random password the first
> time. Re-run with `--update` to change an account's password or role:
> `npm run seed -- --username admin --password "newpass" --update`

---

## Deploying at https://cosmicinfosolutions.com/taskflow/

Two equivalent setups. The app serves its UI and API under a configurable base
path, so both work without code changes.

### Option A — proxy strips the prefix (recommended)

The web server handles `/taskflow/` and forwards *everything else* to Node, so
the app sees plain `/` and `/api` paths.

```nginx
# nginx
location /taskflow/ {
    proxy_pass http://127.0.0.1:4321/;          # note trailing slash
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

Run with `BASE_PATH=` empty (the default) and the app binds `0.0.0.0:4321`.

### Option B — keep the prefix

```nginx
location /taskflow/ {
    proxy_pass http://127.0.0.1:4321;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

Run with `BASE_PATH=/taskflow` so cookies and asset URLs carry the prefix.

### Apache equivalent

```apache
ProxyPreserveHost On
ProxyPass        /taskflow/ http://127.0.0.1:4321/
ProxyPassReverse /taskflow/ http://127.0.0.1:4321/
```

For **Option A** use `ProxyPass /taskflow/ http://127.0.0.1:4321/` (again, the
trailing slash makes Apache strip the prefix).

### Production notes

- Put `COOKIE_SECURE=true` in the environment so session cookies are only sent
  over HTTPS (always set behind the proxy).
- Run `node server.js` with a process manager (e.g. systemd, pm2) that restarts
  on failure.
- Keep `data/` and `uploads/` out of the public web root, and back them up
  regularly — they contain all tasks, comments, messages and attachments.

---

## Configuration

All settings are optional. Create a `.env` file in `taskflow/` or export real
environment variables (real env vars always win). See `.env.example`.

| Variable          | Default      | Description                                       |
| ----------------- | ------------ | ------------------------------------------------- |
| `PORT`            | `4321`       | Port the app listens on                           |
| `HOST`            | `0.0.0.0`    | Bind address                                      |
| `BASE_PATH`       | *(empty)*    | Use `/taskflow` when the proxy does **not** strip |
| `DATA_DIR`        | `./data`     | Folder for the JSON database                      |
| `UPLOAD_DIR`      | `./uploads`  | Folder for file attachments                       |
| `SESSION_TTL_DAYS`| `30`         | How long a login lasts                            |
| `MAX_UPLOAD_MB`   | `25`         | Per-file upload limit                             |
| `COOKIE_SECURE`   | `false`      | `true` = cookies only over HTTPS                  |

---

## Roles

| Capability                          | Admin | Analyst |
| ----------------------------------- | :---: | :-----: |
| Create / edit / delete users        |  ✅   |    —    |
| Create / edit / delete projects          |  ✅   |    —    |
| Create / delete / edit any task     |  ✅   |    —    |
| See all company tasks (Oversight)   |  ✅   |    —    |
| See & update their assigned tasks   |  ✅   |   ✅    |
| Change a task's status              |  ✅   |  ✅ (own tasks only) |
| Toggle subtasks, comment, attach files | ✅ | ✅ (own tasks only) |
| Message anyone                     |  ✅   |   ✅    |

Task visibility is enforced server-side: list, detail, comments, attachments and
search are all scoped for analysts.

---

## Security summary

- Passwords stored as salted **scrypt** hashes; never plain text, never logged.
- Sessions: random 256-bit tokens, only their SHA-256 is stored; `httpOnly`
  cookie; expiry enforced server-side.
- CSRF: double-submit cookie (`taskflow_csrf`) checked against
  `X-CSRF-Token` for every state-changing API call (login exempt).
- Uploads: strict extension allow-list, filenames sanitised (no path
  traversal), and a magic-byte check so a renamed `.exe` can't be served as a
  PDF. Files stream with `nosniff` + sandboxed CSP.
- All user data is HTML-escaped in the UI and validated/discarded on the API.
- Uploaded files are only readable by the task's assignee or admins.

---

## Project structure

```
taskflow/
├─ package.json          deps + scripts (start / dev / seed / check)
├─ server.js             entry point: security headers, API mount, SPA + base-path
├─ .env.example          documented environment variables
├─ scripts/
│  ├─ seed.js            create/update accounts from the shell
│  └─ lint.js            syntax-check every .js file (npm run check)
├─ src/
│  ├─ config.js          env loading (no dotenv dependency) + config object
│  ├─ db.js              JSON-file store (atomic writes, corruption backup)
│  ├─ lib/
│  │  ├─ crypto.js       scrypt hashing, tokens, SHA-256, constant-time compare
│  │  └─ validate.js     validation, access rules, public user shape, JSON errors
│  ├─ middleware/
│  │  ├─ auth.js         sessions, role guard, CSRF
│  │  └─ uploads.js      multer setup, allow-list, magic bytes
│  └─ routes/
│     ├─ auth.js         login/logout/me (+ brute-force limiter)
│     ├─ users.js        admin CRUD
│     ├─ projects.js     admin CRUD
│     ├─ tasks.js        listing, CRUD, status, subtasks, cascading deletes
│     ├─ comments.js     task comments (+ file links)
│     ├─ files.js        upload/download/list/delete
│     ├─ messages.js     inbox + 1:1 threads + read receipts
│     └─ search.js       global search (scoped)
└─ public/               SPA (no build step)
   ├─ index.html
   ├─ css/app.css
   └─ js/
      ├─ app.js          bootstrap, hash router, event wiring
      ├─ api.js          fetch wrapper (JSON, uploads, CSRF header)
      ├─ store.js        cached state + pub/sub
      ├─ util.js         escaping, dates, icons/meta helpers
      ├─ components.js   avatars, badges, toasts, modals, task cards, task form
      └─ views/
         ├─ login.js      sign-in screen
         ├─ layout.js     sidebar + top bar + global search
         ├─ home.js       dashboard
         ├─ tasks.js      board / list with filters + drag & drop
         ├─ projects.js   project list + admin CRUD
         ├─ messages.js   chat (3 s polling)
         ├─ users.js      admin user management
         └─ taskDetail.js slide-out task drawer
```

## Verification

```bash
npm run check      # syntax-checks all JavaScript (server + browser modules)
```

There is no test framework by design; `check` guarantees every file at least
parses, which combined with the validation/authorisation rules above covers the
main failure modes.

## Requirements

- Node.js **>= 18** (uses `node --watch` for dev, `crypto.randomUUID`, etc.)
- Dependencies: `express` and `multer` only.