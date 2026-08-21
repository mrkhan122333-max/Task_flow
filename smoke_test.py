"""
smoke_test.py
-------------
Automated end-to-end verification of TaskFlow's invite + messaging
features, PLUS (as of this update) start/due dates, rich comments
with link auto-detection and file attachments, and the admin
analytics dashboard - all driven through Flask's test client against
a real in-memory SQLite DB (no live server, no live Gmail credentials
needed - MAIL_SUPPRESS_SEND / gmail_oauth "not configured" means
notifications fall through to the console-log path, which this
script's log capture also inspects to confirm the *content* of what
would have been sent).

Run with:  python smoke_test.py
Exits non-zero (and prints which check failed) on any failure.
"""
import io
import os
import re
import sys
import contextlib

os.environ["FLASK_TESTING"] = "1"

sys.path.insert(0, os.path.dirname(__file__))

from config import Config


class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    WTF_CSRF_ENABLED = False
    SERVER_NAME = "localhost"


from app import create_app
from extensions import db
from models import (
    User, Project, Task, Comment, CommentAttachment, ProjectInvite, Message, ProjectMembership,
    ROLE_ADMIN, ROLE_ANALYST, INVITE_PENDING, INVITE_ACCEPTED,
    STATUS_NOT_STARTED, STATUS_ONGOING, STATUS_HOLD, STATUS_COMPLETE, VALID_STATUSES,
)

app = create_app(TestConfig)

failures = []


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        failures.append(label)


def extract_token(join_url_or_text):
    m = re.search(r"/invites/([A-Za-z0-9_\-]+)", join_url_or_text)
    return m.group(1) if m else None


with app.app_context():
    db.drop_all()
    db.create_all()

    client = app.test_client()

    # 1. First signup becomes admin ----------------------------------
    r = client.post("/signup", data={
        "name": "Alina Admin", "email": "alina@example.com",
        "password": "password1", "confirm_password": "password1",
    }, follow_redirects=True)
    admin = User.query.filter_by(email="alina@example.com").first()
    check("First signup auto-promoted to admin", admin is not None and admin.role == ROLE_ADMIN)
    client.get("/logout")

    # Second signup is a plain analyst, used as a *non-member* control.
    client.post("/signup", data={
        "name": "Outsider", "email": "outsider@example.com",
        "password": "password1", "confirm_password": "password1",
    })
    client.get("/logout")

    # Log back in as admin, create a project.
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})
    r = client.post("/projects/new", data={"name": "Xtachi Launch", "description": "GTM"},
                     follow_redirects=True)
    project = Project.query.filter_by(name="Xtachi Launch").first()
    check("Project created", project is not None)
    check("Owner auto-added as member", admin in project.members)

    # 2. Create an invite (new email, no existing account) -----------
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = client.post(f"/projects/{project.id}/invites",
                         data={"email": "siddharth@gmail.com", "role": "analyst"},
                         follow_redirects=True)
    console_output = buf.getvalue()
    invite = ProjectInvite.query.filter_by(email="siddharth@gmail.com").first()
    check("Invite row created", invite is not None)
    check("Invite status is pending", invite is not None and invite.status == INVITE_PENDING)
    check("Invite role stored correctly", invite is not None and invite.role == "analyst")
    check("Invite console-fallback email contains join link",
          "/invites/" in console_output and "siddharth@gmail.com" in console_output)

    # 2b. Duplicate invite to same email+project must be rejected.
    r = client.post(f"/projects/{project.id}/invites",
                     data={"email": "siddharth@gmail.com", "role": "analyst"},
                     follow_redirects=True)
    dup_count = ProjectInvite.query.filter_by(email="siddharth@gmail.com").count()
    check("Duplicate invite NOT created (still exactly 1 row)", dup_count == 1)
    check("Duplicate invite shows error flash", b"already pending" in r.data)

    # 2c. Invalid email is rejected.
    r = client.post(f"/projects/{project.id}/invites",
                     data={"email": "not-an-email", "role": "analyst"},
                     follow_redirects=True)
    check("Invalid email rejected", b"Invalid email" in r.data)

    token = extract_token(console_output)
    check("Extracted invite token from notification", bool(token))
    check("Token matches DB row", token == invite.token if invite else False)

    client.get("/logout")

    # 3. Accept the invite (public flow, no login) --------------------
    r = client.get(f"/invites/{token}")
    check("Accept page loads (200)", r.status_code == 200)

    r = client.post(f"/invites/{token}", data={
        "name": "Siddharth Analyst", "password": "password1", "confirm_password": "password1",
    }, follow_redirects=True)
    new_user = User.query.filter_by(email="siddharth@gmail.com").first()
    db.session.refresh(invite)
    check("Invited user account created", new_user is not None)
    check("Invited user got the invite's role (analyst)", new_user is not None and new_user.role == ROLE_ANALYST)
    check("Invite marked accepted", invite.status == INVITE_ACCEPTED)
    check("New user auto-logged-in and redirected to dashboard", r.status_code == 200 and b"Xtachi Launch" in r.data)
    db.session.refresh(project)
    check("New user added to project.members", new_user in project.members)

    membership = ProjectMembership.query.filter_by(project_id=project.id, user_id=new_user.id).first()
    check("ProjectMembership row has correct role", membership is not None and membership.role == "analyst")

    client.get("/logout")

    # 3b. Re-using an already-accepted token must fail.
    r = client.get(f"/invites/{token}", follow_redirects=True)
    check("Re-using accepted token redirects with 'already been used'", b"already been used" in r.data)

    # 4. RBAC: analyst cannot create invites --------------------------
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    r = client.post(f"/projects/{project.id}/invites",
                     data={"email": "another@gmail.com", "role": "analyst"})
    check("Analyst blocked from creating invites (403)", r.status_code == 403)
    client.get("/logout")

    # 5. Messaging: admin -> analyst ----------------------------------
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})
    buf2 = io.StringIO()
    with contextlib.redirect_stdout(buf2):
        r = client.post(f"/projects/{project.id}/messages/{new_user.id}",
                         data={"content": "Welcome to the project!"}, follow_redirects=True)
    msg = Message.query.filter_by(project_id=project.id).first()
    check("Message saved to DB", msg is not None)
    check("Message sender is admin", msg is not None and msg.sender_id == admin.id)
    check("Message receiver is the analyst", msg is not None and msg.receiver_id == new_user.id)
    check("Message content matches", msg is not None and msg.content == "Welcome to the project!")
    check("New-message notification email logged", "New message from" in buf2.getvalue())

    # Empty message must be rejected.
    r = client.post(f"/projects/{project.id}/messages/{new_user.id}",
                     data={"content": "   "}, follow_redirects=True)
    check("Empty message rejected", b"can&#39;t be empty" in r.data or b"can't be empty" in r.data)
    same_count = Message.query.filter_by(project_id=project.id).count()
    check("Empty message did not create a row", same_count == 1)

    client.get("/logout")

    # 6. Analyst replies to admin --------------------------------------
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    r = client.post(f"/projects/{project.id}/messages/{admin.id}",
                     data={"content": "Thanks, excited to get started."}, follow_redirects=True)
    check("Analyst reply saved", Message.query.filter_by(sender_id=new_user.id).first() is not None)

    # Thread view should show both messages, and mark admin's message read.
    r = client.get(f"/projects/{project.id}/messages/{admin.id}")
    check("Thread view loads for analyst", r.status_code == 200)
    check("Thread shows both messages", b"Welcome to the project" in r.data and b"Thanks, excited" in r.data)
    db.session.refresh(msg)
    check("Admin's message marked read after analyst opens thread", msg.read_at is not None)

    # 7. RBAC: analyst cannot message another analyst -------------------
    client.get("/logout")
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})
    client.post(f"/projects/{project.id}/invites", data={"email": "vishwa@gmail.com", "role": "analyst"})
    invite2 = ProjectInvite.query.filter_by(email="vishwa@gmail.com").first()
    client.get("/logout")
    client.post(f"/invites/{invite2.token}", data={
        "name": "Vishwa Two", "password": "password1", "confirm_password": "password1",
    })
    client.get("/logout")
    second_analyst = User.query.filter_by(email="vishwa@gmail.com").first()
    check("Second analyst account created", second_analyst is not None)

    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    r = client.post(f"/projects/{project.id}/messages/{second_analyst.id}",
                     data={"content": "hey fellow analyst"})
    check("Analyst -> analyst messaging blocked (403)", r.status_code == 403)
    client.get("/logout")

    # 8. RBAC: outsider (not a project member) cannot message into this project
    client.post("/login", data={"email": "outsider@example.com", "password": "password1"})
    r = client.get(f"/projects/{project.id}/messages/{new_user.id}")
    check("Non-member blocked from project (403, since outsider isn't admin/member)", r.status_code == 403)
    client.get("/logout")

    # 9. Inviting an existing account adds them directly (no token flow)
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})
    r = client.post(f"/projects/{project.id}/invites",
                     data={"email": "outsider@example.com", "role": "analyst"}, follow_redirects=True)
    outsider = User.query.filter_by(email="outsider@example.com").first()
    db.session.refresh(project)
    check("Existing-account invite adds user directly to project", outsider in project.members)
    check("Direct-add confirmation flash shown", b"added to the project directly" in r.data)

    # 10. Cancel + resend invite flows -----------------------------------
    r = client.post(f"/projects/{project.id}/invites", data={"email": "cancel-me@gmail.com", "role": "analyst"})
    cancel_invite = ProjectInvite.query.filter_by(email="cancel-me@gmail.com").first()
    r = client.post(f"/projects/{project.id}/invites/{cancel_invite.id}/cancel", follow_redirects=True)
    check("Cancelled invite removed from DB", ProjectInvite.query.get(cancel_invite.id) is None)

    r = client.post(f"/projects/{project.id}/invites", data={"email": "resend-me@gmail.com", "role": "analyst"})
    resend_invite = ProjectInvite.query.filter_by(email="resend-me@gmail.com").first()
    old_token = resend_invite.token
    r = client.post(f"/projects/{project.id}/invites/{resend_invite.id}/resend", follow_redirects=True)
    db.session.refresh(resend_invite)
    check("Resend generates a new token", resend_invite.token != old_token)
    check("Resend keeps status pending", resend_invite.status == INVITE_PENDING)

    # 11. Team tab renders with members + invites for admin -------------
    r = client.get(f"/projects/{project.id}/team")
    check("Team tab loads (200)", r.status_code == 200)
    check("Team tab lists members", b"Siddharth Analyst" in r.data)
    check("Team tab lists invites", b"resend-me@gmail.com" in r.data)
    client.get("/logout")

    # 12. Gmail OAuth2 module: not-configured path is safe -------------
    from gmail_oauth import is_configured, GOOGLE_LIBS_AVAILABLE
    with app.test_request_context():
        check("Gmail OAuth libs import without crashing", GOOGLE_LIBS_AVAILABLE is True)
        check("Gmail OAuth correctly reports 'not configured' (no token.json present)",
              is_configured() is False)

    # ==================================================================
    # Feature 1: Task start date + due date
    # ==================================================================
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})

    r = client.post(f"/projects/{project.id}/tasks/new", data={
        "title": "Design the onboarding flow", "description": "",
        "start_date": "2026-08-01", "due_date": "2026-08-10",
        "priority": "high",
    }, follow_redirects=True)
    good_task = Task.query.filter_by(title="Design the onboarding flow").first()
    check("Task created with valid start<=due dates", good_task is not None)
    check("start_date stored correctly", good_task is not None and str(good_task.start_date) == "2026-08-01")
    check("due_date stored correctly", good_task is not None and str(good_task.due_date) == "2026-08-10")

    # Invalid: start AFTER due must be rejected server-side.
    r = client.post(f"/projects/{project.id}/tasks/new", data={
        "title": "Bad date task", "description": "",
        "start_date": "2026-08-15", "due_date": "2026-08-10",
        "priority": "medium",
    }, follow_redirects=True)
    check("Task with start_date > due_date rejected", b"on or before" in r.data)
    check("Invalid-date task NOT created", Task.query.filter_by(title="Bad date task").first() is None)

    # Task with only a due_date (no start_date) - must remain valid
    # (dates are both optional; the rule only applies when BOTH are set).
    r = client.post(f"/projects/{project.id}/tasks/new", data={
        "title": "Due-date-only task", "description": "",
        "start_date": "", "due_date": "2026-08-20", "priority": "low",
    }, follow_redirects=True)
    due_only_task = Task.query.filter_by(title="Due-date-only task").first()
    check("Task with only due_date (no start_date) accepted", due_only_task is not None)

    # is_overdue() must still key off due_date only - no regression.
    from datetime import date, timedelta
    good_task.due_date = date.today() - timedelta(days=1)
    good_task.start_date = date.today() - timedelta(days=10)
    db.session.commit()
    check("is_overdue() still true based on due_date regardless of start_date",
          good_task.is_overdue() is True)

    # Edit: fix the dates back, and confirm the edit-time validation also fires.
    r = client.post(f"/tasks/{good_task.id}/edit", data={
        "title": good_task.title, "description": "", "priority": "high", "status": STATUS_NOT_STARTED,
        "start_date": "2026-09-01", "due_date": "2026-08-01",  # start AFTER due
        "assignee_id": "",
    }, follow_redirects=True)
    check("Edit with start_date > due_date rejected", b"on or before" in r.data)

    r = client.get(f"/tasks/{good_task.id}")
    check("Task detail page shows the Start -> Due timeline", b"Timeline" in r.data)
    client.get("/logout")

    # ==================================================================
    # Feature 2: Rich comments - hyperlinks + attachments
    # ==================================================================
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})

    # 2a. Link auto-detection: a raw URL in a plain-text comment must
    # render as a clickable <a> tag, and any HTML in the same comment
    # must be escaped (not executed) - this is the XSS check.
    r = client.post(f"/tasks/{good_task.id}/comments", data={
        "body": "See https://example.com/spec for details <script>alert(1)</script>",
    }, follow_redirects=True)
    check("Comment with URL renders a clickable link",
          b'<a href="https://example.com/spec"' in r.data)
    check("Raw <script> tag in comment body is escaped, not executed",
          b"<script>alert(1)</script>" not in r.data and b"&lt;script&gt;" in r.data)

    # 2b. File attachment - valid image upload succeeds.
    tiny_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0"
        b"\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    r = client.post(f"/tasks/{good_task.id}/comments", data={
        "body": "Here's the mockup",
        "attachment": (io.BytesIO(tiny_png), "mockup.png"),
    }, content_type="multipart/form-data", follow_redirects=True)
    png_attachment = CommentAttachment.query.filter_by(filename="mockup.png").first()
    check("Valid image attachment saved to DB", png_attachment is not None)
    check("Attachment categorized as 'image'", png_attachment is not None and png_attachment.file_type == "image")
    check("Attachment stored under a randomized filename (not 'mockup.png')",
          png_attachment is not None and png_attachment.stored_path != "mockup.png")
    stored_file_path = os.path.join(app.config["COMMENT_UPLOAD_FOLDER"], png_attachment.stored_path) if png_attachment else None
    check("Attachment file actually written to disk (outside static/)",
          stored_file_path is not None and os.path.exists(stored_file_path))
    check("Upload folder is NOT inside static/",
          "static" not in os.path.normpath(app.config["COMMENT_UPLOAD_FOLDER"]).split(os.sep))

    # 2c. Disallowed extension (.exe) must be rejected - whitelist enforcement.
    r = client.post(f"/tasks/{good_task.id}/comments", data={
        "body": "sneaky",
        "attachment": (io.BytesIO(b"MZ fake exe content"), "virus.exe"),
    }, content_type="multipart/form-data", follow_redirects=True)
    check("Disallowed .exe extension rejected", b"aren&#39;t allowed" in r.data or b"aren't allowed" in r.data)
    check(".exe attachment NOT created in DB", CommentAttachment.query.filter_by(filename="virus.exe").first() is None)
    check(".exe file NOT written to disk",
          not os.path.exists(os.path.join(app.config["COMMENT_UPLOAD_FOLDER"], "virus.exe")))

    # 2d. Oversized file (> 10MB) must be rejected.
    oversized = io.BytesIO(b"0" * (11 * 1024 * 1024))
    r = client.post(f"/tasks/{good_task.id}/comments", data={
        "body": "big file",
        "attachment": (oversized, "huge.csv"),
    }, content_type="multipart/form-data", follow_redirects=True)
    check("Oversized (>10MB) attachment rejected", r.status_code in (200, 302, 413))
    check("Oversized attachment NOT created in DB", CommentAttachment.query.filter_by(filename="huge.csv").first() is None)

    # 2e. Permission: only the uploader (or an admin) can delete an attachment.
    r = client.get(f"/attachments/{png_attachment.id}")
    check("Attachment download accessible to a project member", r.status_code == 200)
    client.get("/logout")

    # Second analyst (project member, but did NOT upload the file) must be blocked from deleting it.
    client.post("/login", data={"email": "vishwa@gmail.com", "password": "password1"})
    r = client.post(f"/attachments/{png_attachment.id}/delete")
    check("Non-uploader analyst blocked from deleting another user's attachment (403)", r.status_code == 403)
    client.get("/logout")

    # Outsider (not even a project member) must be blocked from viewing it.
    client.get("/logout")
    client.post("/signup", data={
        "name": "True Outsider", "email": "trueoutsider@example.com",
        "password": "password1", "confirm_password": "password1",
    })
    client.get("/logout")
    client.post("/login", data={"email": "trueoutsider@example.com", "password": "password1"})
    r = client.get(f"/attachments/{png_attachment.id}")
    check("Non-project-member blocked from viewing attachment (403)", r.status_code == 403)
    client.get("/logout")

    # Uploader deleting their own attachment succeeds, and removes the file from disk too.
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    r = client.post(f"/attachments/{png_attachment.id}/delete", follow_redirects=True)
    check("Uploader can delete their own attachment", db.session.get(CommentAttachment, png_attachment.id) is None)
    check("Deleted attachment's file removed from disk", not os.path.exists(stored_file_path))
    client.get("/logout")

    # ==================================================================
    # Feature 3: Admin analytics dashboard
    # ==================================================================
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})

    r = client.get("/admin/dashboard")
    check("Admin dashboard page loads (200)", r.status_code == 200)
    check("Dashboard shows the project", b"Xtachi Launch" in r.data)

    r = client.get("/admin/dashboard/data")
    check("Dashboard JSON data endpoint returns 200", r.status_code == 200)
    dash_data = r.get_json()
    check("JSON has status_counts", "status_counts" in dash_data)
    check("JSON has timeline with labels/created/completed", set(dash_data.get("timeline", {}).keys()) >= {"labels", "created", "completed"})

    # Cross-check the JSON status_counts against a real, independent DB query,
    # for all 4 statuses (not just complete) - catches a miscount on any one
    # of them, not just the one that happens to get exercised elsewhere.
    for status_value in VALID_STATUSES:
        real_count = Task.query.filter_by(status=status_value).count()
        check(f"Dashboard '{status_value}' count matches a real DB query",
              dash_data["status_counts"][status_value] == real_count)

    client.get("/logout")

    # RBAC: analyst must be blocked from the admin dashboard.
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    r = client.get("/admin/dashboard")
    check("Analyst blocked from admin dashboard (403)", r.status_code == 403)
    r = client.get("/admin/dashboard/data")
    check("Analyst blocked from admin dashboard JSON endpoint (403)", r.status_code == 403)
    client.get("/logout")

    # ==================================================================
    # Feature 4: new 4-status set (not_started/ongoing/hold/complete)
    # and color-coded due-date urgency
    # ==================================================================
    from datetime import date, timedelta

    check("New task defaults to 'not_started'",
          Task.query.filter_by(title="Due-date-only task").first().status == STATUS_NOT_STARTED)

    # Assign good_task to Siddharth (new_user) so we can test the
    # assignee-only status-setting permission below - it was created
    # earlier in this file (Feature 1 section) without an assignee.
    good_task.assignee_id = new_user.id
    db.session.commit()

    # Assignee (Siddharth) can set status to any of the 4 values via
    # the new /tasks/<id>/status route.
    client.post("/login", data={"email": "siddharth@gmail.com", "password": "password1"})
    for target_status in (STATUS_ONGOING, STATUS_HOLD, STATUS_NOT_STARTED, STATUS_COMPLETE):
        r = client.post(f"/tasks/{good_task.id}/status", data={"status": target_status}, follow_redirects=True)
        db.session.refresh(good_task)
        check(f"Assignee can set status to '{target_status}'", good_task.status == target_status)
    check("Task detail page renders all 4 status options",
          all(bytes(f'value="{s}"', "utf-8") in client.get(f"/tasks/{good_task.id}").data for s in VALID_STATUSES))

    # Invalid status value must be rejected, not silently written to the DB.
    good_task.status = STATUS_ONGOING
    db.session.commit()
    r = client.post(f"/tasks/{good_task.id}/status", data={"status": "bogus_status"}, follow_redirects=True)
    db.session.refresh(good_task)
    check("Invalid status value rejected, task status unchanged", good_task.status == STATUS_ONGOING)
    client.get("/logout")

    # A second analyst (Vishwa - project member, but NOT the assignee)
    # must be blocked from setting status.
    client.post("/login", data={"email": "vishwa@gmail.com", "password": "password1"})
    r = client.post(f"/tasks/{good_task.id}/status", data={"status": STATUS_HOLD})
    check("Non-assignee analyst blocked from changing task status (403)", r.status_code == 403)
    client.get("/logout")

    # Admin can set status on any task regardless of assignee.
    client.post("/login", data={"email": "alina@example.com", "password": "password1"})
    r = client.post(f"/tasks/{good_task.id}/status", data={"status": STATUS_HOLD}, follow_redirects=True)
    db.session.refresh(good_task)
    check("Admin can set status on any task", good_task.status == STATUS_HOLD)
    client.get("/logout")

    # Due-date urgency tiers, independent of the route/view layer.
    good_task.status = STATUS_ONGOING
    good_task.due_date = date.today() - timedelta(days=1)
    check("due_urgency(): overdue -> 'overdue'", good_task.due_urgency() == "overdue")
    good_task.due_date = date.today()
    check("due_urgency(): due today -> 'overdue'", good_task.due_urgency() == "overdue")
    good_task.due_date = date.today() + timedelta(days=2)
    check("due_urgency(): 2 days out -> 'soon'", good_task.due_urgency() == "soon")
    good_task.due_date = date.today() + timedelta(days=6)
    check("due_urgency(): 6 days out -> 'upcoming'", good_task.due_urgency() == "upcoming")
    good_task.due_date = date.today() + timedelta(days=10)
    check("due_urgency(): 10 days out -> None (default/gray)", good_task.due_urgency() is None)
    good_task.due_date = date.today() - timedelta(days=1)
    good_task.status = STATUS_COMPLETE
    check("due_urgency(): completed task -> None even if overdue", good_task.due_urgency() is None)
    db.session.commit()

# ======================================================================
# Real-startup regression test: `python app.py` on a totally fresh
# checkout must work with ZERO manual `flask db upgrade` commands.
#
# Everything above runs through TESTING=True, which takes a shortcut
# (db.create_all() straight from models.py) that bypasses Alembic
# entirely - so it could never have caught the bug this section
# guards against: a fresh, non-TESTING app.py startup against an
# empty file-backed DB previously left NO tables at all (see
# app.py's _auto_migrate docstring). This exercises the exact
# non-TESTING startup path a real user hits.
# ======================================================================
import tempfile
import shutil

real_startup_dir = tempfile.mkdtemp(prefix="taskflow_real_startup_")
try:
    real_db_path = os.path.join(real_startup_dir, "app.db")

    class RealStartupConfig(Config):
        TESTING = False
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{real_db_path}"
        WTF_CSRF_ENABLED = False
        SERVER_NAME = "localhost"
        SECRET_KEY = "real-startup-check"

    real_app = create_app(RealStartupConfig)
    real_client = real_app.test_client()

    r = real_client.post("/signup", data={
        "name": "Fresh Admin", "email": "freshadmin@test.com",
        "password": "password1", "confirm_password": "password1",
    }, follow_redirects=True)
    check("Real (non-TESTING) startup: signup succeeds on a brand new empty DB", r.status_code == 200)

    r = real_client.post("/logout", follow_redirects=True)
    r = real_client.post("/login", data={"email": "freshadmin@test.com", "password": "password1"}, follow_redirects=True)
    check("Real startup: login works with zero manual `flask db upgrade` (the reported bug)", r.status_code == 200)
    check("Real startup: no 'no such table' error leaked into the response", b"no such table" not in r.data)

    with real_app.app_context():
        from models import User as RealUser
        check("Real startup: user actually persisted to the file-backed DB",
              RealUser.query.filter_by(email="freshadmin@test.com").first() is not None)
finally:
    shutil.rmtree(real_startup_dir, ignore_errors=True)

print("\n" + "=" * 60)
if failures:
    print(f"{len(failures)} CHECK(S) FAILED:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
else:
    print("ALL CHECKS PASSED")
    sys.exit(0)
