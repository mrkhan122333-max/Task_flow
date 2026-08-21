"""
scripts/gmail_oauth_setup.py
-----------------------------
One-time interactive setup for the real Gmail API OAuth2 send path
(gmail_oauth.py). Run this once, locally, with the Google account you
want invite/message notification emails to be sent FROM:

    python scripts/gmail_oauth_setup.py

What it does:
    1. Loads the OAuth "Desktop app" client secrets JSON you downloaded
       from Google Cloud Console (path: Config.GOOGLE_OAUTH_CLIENT_SECRETS_FILE,
       defaults to <project_root>/client_secret.json).
    2. Opens a browser for you to sign in and grant the
       'gmail.send' scope (send-only - this app never reads your
       mailbox).
    3. Writes the resulting access + refresh token to
       Config.GOOGLE_OAUTH_TOKEN_FILE (defaults to <project_root>/token.json).

After this file exists, gmail_oauth.is_configured() returns True and
email_service.py starts routing invite/message notifications through
the real Gmail API instead of SMTP. token.json contains a long-lived
refresh token - keep it out of version control (already covered by
the existing .gitignore entry for *.json secrets - verify before
committing).

NOT RUN IN THIS ENVIRONMENT: this script requires an interactive
browser + a real Google Cloud OAuth client, neither of which exist in
an automated dev/test environment. It has been reviewed for
correctness but not executed end-to-end - see gmail_oauth.py's module
docstring and the README's "Verified before delivery" section for
exactly what WAS verified.
"""

import json
import os
import sys

# Make sibling modules (config.py) importable when run as a script
# from the scripts/ subdirectory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print(
        "google-auth-oauthlib is not installed. Run:\n"
        "    pip install -r requirements.txt\n"
        "then try again."
    )
    sys.exit(1)

from config import Config

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def main():
    secrets_path = Config.GOOGLE_OAUTH_CLIENT_SECRETS_FILE
    token_path = Config.GOOGLE_OAUTH_TOKEN_FILE

    if not os.path.exists(secrets_path):
        print(
            f"Client secrets file not found at: {secrets_path}\n\n"
            "Create one at https://console.cloud.google.com/apis/credentials\n"
            "(OAuth client ID -> Application type: Desktop app), download it,\n"
            "and save it at that path (or set GOOGLE_OAUTH_CLIENT_SECRETS_FILE\n"
            "in your .env to point elsewhere)."
        )
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(secrets_path, SCOPES)
    # run_local_server spins up a temporary local web server to catch
    # the OAuth redirect - the standard flow for "Desktop app" clients.
    creds = flow.run_local_server(port=0)

    with open(token_path, "w") as fh:
        fh.write(creds.to_json())

    print(f"Success! Gmail OAuth2 token saved to: {token_path}")
    print("Invite and message notification emails will now send via the real Gmail API.")


if __name__ == "__main__":
    main()
