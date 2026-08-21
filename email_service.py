"""
email_service.py
-----------------
Notification layer for the new invite + direct-messaging features.

Send order for every notification in this module:
    1. Real Gmail API via OAuth2 (gmail_oauth.py), if a token.json is
       present - this is the "actual email invite via Gmail API
       (OAuth2)" path the spec asked for.
    2. SMTP + Gmail App Password - the existing email_utils.py path
       already used for task-assignment/status/due-date emails.
    3. Console log - email_utils.py's built-in no-config fallback.

This keeps the app runnable end-to-end with zero setup (falls all
the way through to step 3), while supporting real OAuth2 sending the
moment real credentials are provided, without touching email_utils.py
(kept as-is per "extend, don't restructure").
"""

from flask import current_app

from email_utils import send_email as _send_email_smtp_or_console
import gmail_oauth


def send_notification_email(to, subject, body):
    """Single entry point every new-feature notification goes
    through. Never raises - a failed notification must never roll
    back the invite/message that triggered it. Callers in
    invites.py / messaging.py still wrap calls to this in try/except
    as a second line of defense and to log context-specific errors,
    but this function itself already swallows and logs send failures
    at each fallback tier.
    """
    if not to:
        return

    if gmail_oauth.is_configured():
        try:
            gmail_oauth.send_gmail_api_message(to, subject, body)
            return
        except Exception as exc:
            current_app.logger.error(
                f"Gmail API send failed for {to}, falling back to SMTP: {exc}"
            )
            # fall through to the SMTP/console path below

    _send_email_smtp_or_console(to, subject, body)


def notify_invite_sent(invite, join_url):
    """Email the invitee their secure signup/join link."""
    send_notification_email(
        to=invite.email,
        subject=f'You\'ve been invited to join "{invite.project.name}" on TaskFlow',
        body=(
            f"Hi,\n\n"
            f'{invite.invited_by.name} has invited you to join the project '
            f'"{invite.project.name}" on TaskFlow as a {invite.role}.\n\n'
            f"Click the link below to set a password and join:\n{join_url}\n\n"
            f"This link expires on {invite.expires_at.strftime('%d %b %Y, %H:%M UTC')}.\n"
            f"If you weren't expecting this invite, you can safely ignore this email."
        ),
    )


def notify_invite_accepted(project, user, added_directly=False):
    """Email every admin on the project that the invite was accepted
    (or that the invitee was added directly because they already had
    an account with that email)."""
    admins = [m for m in project.members if m.role == "admin"]
    verb = "was added to" if added_directly else "accepted their invite and joined"
    for admin in admins:
        send_notification_email(
            to=admin.email,
            subject=f'{user.name} joined "{project.name}"',
            body=(
                f"Hi {admin.name},\n\n"
                f'{user.name} ({user.email}) {verb} "{project.name}".'
            ),
        )


def notify_new_message(message):
    """Email the receiver about a new direct message, so they don't
    need to be logged in / actively watching the app to know
    something needs their attention (per spec's "notification sync"
    requirement)."""
    receiver = message.receiver
    sender = message.sender
    project = message.project
    preview = message.content if len(message.content) <= 300 else message.content[:300] + "..."
    send_notification_email(
        to=receiver.email,
        subject=f'New message from {sender.name} on "{project.name}"',
        body=(
            f"Hi {receiver.name},\n\n"
            f'{sender.name} sent you a message on "{project.name}":\n\n'
            f'"{preview}"\n\n'
            f"Log in to TaskFlow to reply."
        ),
    )
