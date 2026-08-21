"""
email_utils.py
--------------
Wraps Flask-Mail so the rest of the app can call one simple function
to send a notification. If Gmail credentials aren't configured
(MAIL_SUPPRESS_SEND == True, see config.py), messages are printed to
the console instead of raising an error - so the app runs fine with
zero email setup, and you can verify the *content* of notifications
before wiring up real credentials.

To switch to true Gmail API OAuth2 instead of SMTP + App Password:
replace send_email()'s body with a call to the Gmail API's
users.messages.send, authenticated via a google-auth-oauthlib flow
that has previously stored/refreshed a token.json. That is a larger
change (requires the google-api-python-client and
google-auth-oauthlib packages plus a Google Cloud OAuth consent
screen) which is why SMTP + App Password was chosen as the default -
see config.py for the flagged assumption.
"""

from flask import current_app
from flask_mail import Message
from extensions import mail


def send_email(to, subject, body):
    """Send a plain-text email, or log it to console if email is not
    configured (MAIL_SUPPRESS_SEND=True)."""
    if not to:
        return
    if current_app.config.get("MAIL_SUPPRESS_SEND"):
        print(f"\n--- [EMAIL SUPPRESSED - not configured] ---\n"
              f"To: {to}\nSubject: {subject}\n\n{body}\n"
              f"--------------------------------------------\n")
        return
    try:
        msg = Message(subject=subject, recipients=[to], body=body)
        mail.send(msg)
    except Exception as exc:  # pragma: no cover - network dependent
        current_app.logger.error(f"Failed to send email to {to}: {exc}")


def notify_task_assigned(task):
    if not task.assignee:
        return
    send_email(
        to=task.assignee.email,
        subject=f'You were assigned a task: "{task.title}"',
        body=(
            f"Hi {task.assignee.name},\n\n"
            f'You have been assigned the task "{task.title}" '
            f"in project \"{task.project.name}\".\n"
            f"Due date: {task.due_date or 'None set'}\n"
            f"Priority: {task.priority}\n\n"
            f"View it in the app to see full details."
        ),
    )


def notify_due_date_approaching(task):
    if not task.assignee:
        return
    send_email(
        to=task.assignee.email,
        subject=f'Reminder: "{task.title}" is due soon',
        body=(
            f"Hi {task.assignee.name},\n\n"
            f'The task "{task.title}" in project "{task.project.name}" '
            f"is due on {task.due_date}.\n"
            f"Please make sure it's completed on time."
        ),
    )


def notify_status_changed(task, changed_by, old_status, new_status):
    recipients = set()
    if task.assignee:
        recipients.add(task.assignee.email)
    if task.creator and task.creator.email != (task.assignee.email if task.assignee else None):
        recipients.add(task.creator.email)

    for email in recipients:
        send_email(
            to=email,
            subject=f'Task status changed: "{task.title}"',
            body=(
                f'The task "{task.title}" in project "{task.project.name}" '
                f"changed status from '{old_status}' to '{new_status}', "
                f"updated by {changed_by.name}."
            ),
        )
