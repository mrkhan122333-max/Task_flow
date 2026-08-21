"""
config.py
---------
Central configuration for the application. Values are pulled from
environment variables (via a .env file in development) so that no
secrets are hard-coded into source control.

ASSUMPTION: SQLite is used as the database for local development and
demo purposes because it requires zero setup. For production, swap
SQLALCHEMY_DATABASE_URI for a Postgres/MySQL connection string - the
rest of the app (SQLAlchemy models/queries) will work unchanged.
"""

import os
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(basedir, ".env"))


class Config:
    # --- Core Flask settings ---
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")

    # --- Database ---
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", f"sqlite:///{os.path.join(basedir, 'app.db')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # --- Gmail / SMTP email settings ---
    # ASSUMPTION: We use Gmail's SMTP relay with an "App Password"
    # (https://myaccount.google.com/apppasswords) rather than a full
    # OAuth2 Gmail API integration. A true OAuth2 flow requires a
    # registered Google Cloud project, a consent screen, and a
    # server-side token refresh loop - it is the "correct" production
    # approach but is far too heavy to configure for a first run.
    # SMTP + App Password uses the same Gmail servers and requires
    # only two environment variables. If you need the OAuth2 Gmail
    # API version instead, say so and it can be swapped in
    # (see email_utils.py for where that swap would happen).
    MAIL_SERVER = os.environ.get("MAIL_SERVER", "smtp.gmail.com")
    MAIL_PORT = int(os.environ.get("MAIL_PORT", 587))
    MAIL_USE_TLS = True
    MAIL_USERNAME = os.environ.get("GMAIL_ADDRESS")
    MAIL_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD")
    MAIL_DEFAULT_SENDER = os.environ.get("GMAIL_ADDRESS")

    # If Gmail credentials are not configured, emails are logged to
    # console instead of sent - so the app is fully runnable without
    # any email setup at all.
    MAIL_SUPPRESS_SEND = not (MAIL_USERNAME and MAIL_PASSWORD)

    # --- Scheduler ---
    # How often (in hours) to check for tasks whose due date is
    # approaching, for the "due date approaching" email notification.
    DUE_DATE_CHECK_INTERVAL_HOURS = int(
        os.environ.get("DUE_DATE_CHECK_INTERVAL_HOURS", 24)
    )
    DUE_DATE_WARNING_WINDOW_HOURS = int(
        os.environ.get("DUE_DATE_WARNING_WINDOW_HOURS", 24)
    )

    # --- Project invitations ---
    # How long a generated invite link/token stays valid before it
    # flips to "expired" (see models.ProjectInvite.is_expired and
    # invites.py's _default_expiry).
    INVITE_EXPIRY_HOURS = int(os.environ.get("INVITE_EXPIRY_HOURS", 72))

    # --- Automatic database migration on startup ---
    # When true (the default), app.py brings the DB schema up to date
    # every time the app starts - no manual `flask db upgrade` needed,
    # including on a completely fresh checkout or an existing
    # pre-migrations database. Set to false in .env if you'd rather
    # run migrations as an explicit step yourself (e.g. in a deploy
    # pipeline, so schema changes don't happen silently at boot).
    AUTO_MIGRATE = os.environ.get("AUTO_MIGRATE", "true").lower() not in ("false", "0", "no")

    # --- Comment file attachments ---
    # Deliberately NOT under static/ - see attachments.py's module
    # docstring for why (static/ is served with zero permission
    # checks; attachments need per-project membership checks on every
    # download).
    COMMENT_UPLOAD_FOLDER = os.environ.get(
        "COMMENT_UPLOAD_FOLDER", os.path.join(basedir, "uploads", "comments")
    )
    # Hard cap on request body size (defense in depth on top of the
    # explicit per-file size check in attachments.save_comment_attachment).
    # A little headroom over the per-file 10MB cap for multipart
    # boundary/form-field overhead.
    MAX_CONTENT_LENGTH = 11 * 1024 * 1024

    # --- Gmail API OAuth2 (real "send via Gmail API" path) ---
    # This is the actual OAuth2 Gmail API integration on top of the
    # SMTP+App-Password path above. It is fully optional: if
    # GOOGLE_OAUTH_TOKEN_FILE doesn't exist on disk, gmail_oauth.py's
    # is_configured() returns False and email_service.py silently
    # falls back to the SMTP path (then to console logging), so the
    # app runs end-to-end with zero Google Cloud setup.
    #
    # One-time setup to actually enable this path:
    #   1. Create a Google Cloud project, enable the Gmail API, and
    #      create an OAuth "Desktop app" client ID.
    #   2. Download its client secrets JSON to the path below
    #      (GOOGLE_OAUTH_CLIENT_SECRETS_FILE).
    #   3. Run `python scripts/gmail_oauth_setup.py` once - it opens a
    #      browser for one-time consent and writes token.json
    #      (GOOGLE_OAUTH_TOKEN_FILE) containing the access+refresh
    #      token. gmail_oauth.py refreshes the access token
    #      automatically from then on.
    GOOGLE_OAUTH_CLIENT_SECRETS_FILE = os.environ.get(
        "GOOGLE_OAUTH_CLIENT_SECRETS_FILE",
        os.path.join(basedir, "client_secret.json"),
    )
    GOOGLE_OAUTH_TOKEN_FILE = os.environ.get(
        "GOOGLE_OAUTH_TOKEN_FILE",
        os.path.join(basedir, "token.json"),
    )
