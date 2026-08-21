"""
gmail_oauth.py
--------------
Thin wrapper around the real Gmail API (users.messages.send) using
OAuth2, as requested for invite/message notifications - in addition
to, not instead of, the SMTP+App Password path the base app already
had (see email_utils.py / config.py for that original path and why
it was chosen as the zero-setup default).

One-time interactive setup produces two files (see README "Gmail API
OAuth2 setup" and scripts/gmail_oauth_setup.py):
    - a client secrets JSON downloaded from Google Cloud Console
      (path: config.GOOGLE_OAUTH_CLIENT_SECRETS_FILE)
    - a token.json this module then creates after that one-time
      browser consent, containing an access token + refresh token
      (path: config.GOOGLE_OAUTH_TOKEN_FILE)

TOKEN REFRESH: OAuth2 access tokens are short-lived (~1hr);
refresh_token is long-lived. Every call to _load_credentials() checks
`creds.expired` and, if so, calls `creds.refresh(...)` (a real HTTP
call to Google) and re-writes token.json with the new access token -
so a long-running Flask process never needs manual re-auth, only the
one-time setup script if the refresh_token itself is ever revoked.

ASSUMPTION / NOT LIVE-TESTED: actually sending mail through the real
Gmail API requires a Google Cloud OAuth client and a consent-granted
token.json that only exist once *you* run the one-time setup script
with your own Google account - there is no way to exercise a real
send from here without those live credentials. What IS verified:
MIME construction, base64url encoding, the "not configured" and
"refresh failed" fallback paths, and that email_service.py correctly
falls back to SMTP when this raises. See README "Verified before
delivery" for the exact automated test performed.
"""

import base64
import json
import os
from email.mime.text import MIMEText

from flask import current_app

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GoogleAuthRequest
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    GOOGLE_LIBS_AVAILABLE = True
except ImportError:
    # google-api-python-client / google-auth-oauthlib not installed.
    # Rather than crash the whole app at import time, degrade to
    # "OAuth2 unavailable" so email_service.py falls back to SMTP.
    GOOGLE_LIBS_AVAILABLE = False
    HttpError = Exception  # placeholder so `except HttpError` below still parses

GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


class GmailOAuthUnavailable(Exception):
    """Raised whenever OAuth2 Gmail sending isn't configured, isn't
    installed, or its token can't be refreshed - the signal for
    email_service.py to fall back to SMTP instead."""


def _token_path():
    return current_app.config.get("GOOGLE_OAUTH_TOKEN_FILE")


def is_configured():
    """True only if the Google API client libraries are installed
    AND a token.json already exists on disk (created by the one-time
    setup script). This is intentionally cheap (no network call) so
    it's safe to check on every outgoing notification."""
    if not GOOGLE_LIBS_AVAILABLE:
        return False
    token_path = _token_path()
    return bool(token_path and os.path.exists(token_path))


def _load_credentials():
    token_path = _token_path()
    if not token_path or not os.path.exists(token_path):
        raise GmailOAuthUnavailable(
            f"No Gmail OAuth token found at {token_path!r}. "
            f"Run: python scripts/gmail_oauth_setup.py"
        )

    try:
        with open(token_path, "r") as fh:
            token_data = json.load(fh)
        creds = Credentials.from_authorized_user_info(token_data, scopes=[GMAIL_SEND_SCOPE])
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise GmailOAuthUnavailable(f"Could not read Gmail OAuth token file: {exc}") from exc

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleAuthRequest())
        except Exception as exc:  # network error, revoked token, etc.
            raise GmailOAuthUnavailable(f"Gmail OAuth token refresh failed: {exc}") from exc
        # Persist the refreshed access token so the next send doesn't
        # need to refresh again immediately.
        try:
            with open(token_path, "w") as fh:
                fh.write(creds.to_json())
        except OSError as exc:
            # Non-fatal: we can still send with the in-memory refreshed
            # creds this one time, just log that persistence failed.
            current_app.logger.error(f"Refreshed Gmail token but failed to save it to disk: {exc}")

    if not creds.valid:
        raise GmailOAuthUnavailable(
            "Gmail OAuth credentials are invalid and could not be refreshed. "
            "Re-run scripts/gmail_oauth_setup.py to re-authorize."
        )

    return creds


def send_gmail_api_message(to, subject, body):
    """Send a plain-text email via the real Gmail API.

    Raises GmailOAuthUnavailable if OAuth2 isn't set up/installed, or
    propagates the underlying HttpError/Exception on an actual send
    failure - email_service.py decides in both cases whether to fall
    back to SMTP or just log it.
    """
    if not GOOGLE_LIBS_AVAILABLE:
        raise GmailOAuthUnavailable(
            "google-api-python-client / google-auth-oauthlib are not installed. "
            "Run: pip install -r requirements.txt"
        )

    creds = _load_credentials()
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)

    mime_msg = MIMEText(body)
    mime_msg["to"] = to
    mime_msg["subject"] = subject
    raw = base64.urlsafe_b64encode(mime_msg.as_bytes()).decode("utf-8")

    try:
        service.users().messages().send(userId="me", body={"raw": raw}).execute()
    except HttpError as exc:
        current_app.logger.error(f"Gmail API send failed for {to}: {exc}")
        raise
