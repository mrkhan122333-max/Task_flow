"""
messaging.py
------------
Private, per-project 1-on-1 direct messaging between an Admin and an
Analyst assigned to the same project.

RBAC (deliberately mirrors the account-wide roles main/routes.py
already enforces, per the "preserve reporting structure" spec
requirement):
    - Admins may message any Analyst who is a member of a project the
      admin can access (admins aren't scoped to "their" projects
      elsewhere in this app - see main.routes._get_project_or_404 -
      so the same applies here).
    - Analysts may message only Admin(s) who are members of a project
      the analyst belongs to. Analyst -> Analyst is always rejected
      with 403, even if both are on the same project, and even if an
      analyst tries to hit the endpoint directly (e.g. via curl) with
      another analyst's user_id.
    - Nobody can message themselves, and both participants must
      actually be members of the project the thread is scoped to -
      a message can't "leak" across projects.

Every message is scoped to a project (Message.project_id): if the
same two people are members of two different shared projects, they
get two independent threads, matching Asana-style per-project
messaging rather than one global DM.
"""

from datetime import datetime

from flask import Blueprint, render_template, redirect, url_for, flash, request, abort
from flask_login import login_required, current_user

from extensions import db
from models import Message, User, ROLE_ADMIN, ROLE_ANALYST
from main.routes import _get_project_or_404
from email_service import notify_new_message

messaging_bp = Blueprint("messaging", __name__, template_folder="../templates")

MAX_MESSAGE_LENGTH = 4000


def _conversation_partners(project):
    """Return the list of users the current viewer is allowed to
    message on this project: Analysts if you're an Admin, Admins if
    you're an Analyst. Both directions exclude the current user
    themselves (no self-messaging)."""
    if current_user.is_admin:
        wanted_role = ROLE_ANALYST
    else:
        wanted_role = ROLE_ADMIN
    return [
        m for m in project.members
        if m.role == wanted_role and m.id != current_user.id
    ]


def _assert_valid_partner(project, other_user):
    """Enforce the Admin<->Analyst-only, same-project rule on the
    *server* side (never trust that the link/button shown to the
    user was the only way to reach this route). Aborts with 403/404
    rather than returning a value, since every caller needs the same
    "stop processing now" behavior.
    """
    if other_user.id == current_user.id:
        abort(403)

    if other_user not in project.members:
        abort(404)

    if current_user.is_admin:
        if other_user.role != ROLE_ANALYST:
            # Admin trying to message another admin (or anything
            # other than an analyst) - not supported per spec.
            abort(403)
    elif current_user.role == ROLE_ANALYST:
        if other_user.role != ROLE_ADMIN:
            # This is the core "reporting structure" rule: an analyst
            # may NEVER message another analyst.
            abort(403)
    else:
        abort(403)


@messaging_bp.route("/projects/<int:project_id>/messages")
@login_required
def inbox(project_id):
    """List this project's conversation partners (admins see their
    analysts, analysts see their admins) with a preview of the last
    message and an unread count for each thread."""
    project = _get_project_or_404(project_id)
    partners = _conversation_partners(project)

    threads = []
    for partner in partners:
        last_message = (
            Message.query.filter_by(project_id=project.id)
            .filter(
                db.or_(
                    db.and_(Message.sender_id == current_user.id, Message.receiver_id == partner.id),
                    db.and_(Message.sender_id == partner.id, Message.receiver_id == current_user.id),
                )
            )
            .order_by(Message.created_at.desc())
            .first()
        )
        unread_count = Message.query.filter_by(
            project_id=project.id,
            sender_id=partner.id,
            receiver_id=current_user.id,
            read_at=None,
        ).count()
        threads.append({"partner": partner, "last_message": last_message, "unread_count": unread_count})

    # Most recently active conversations first; partners with no
    # messages yet (e.g. just invited) sort to the end.
    threads.sort(
        key=lambda t: t["last_message"].created_at if t["last_message"] else datetime.min,
        reverse=True,
    )

    return render_template("messaging/inbox.html", project=project, threads=threads)


@messaging_bp.route("/projects/<int:project_id>/messages/<int:user_id>", methods=["GET", "POST"])
@login_required
def thread(project_id, user_id):
    """View (GET) and send (POST) messages in a single 1-on-1 thread."""
    project = _get_project_or_404(project_id)
    other_user = User.query.get_or_404(user_id)
    _assert_valid_partner(project, other_user)

    if request.method == "POST":
        content = request.form.get("content", "").strip()
        if not content:
            flash("Message can't be empty.", "error")
            return redirect(url_for("messaging.thread", project_id=project.id, user_id=other_user.id))
        if len(content) > MAX_MESSAGE_LENGTH:
            flash(f"Message is too long (max {MAX_MESSAGE_LENGTH} characters).", "error")
            return redirect(url_for("messaging.thread", project_id=project.id, user_id=other_user.id))

        message = Message(
            project_id=project.id,
            sender_id=current_user.id,
            receiver_id=other_user.id,
            content=content,
        )
        try:
            db.session.add(message)
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            from flask import current_app
            current_app.logger.error(
                f"Failed to save message from {current_user.id} to {other_user.id} "
                f"on project {project.id}: {exc}"
            )
            flash("Something went wrong sending your message. Please try again.", "error")
            return redirect(url_for("messaging.thread", project_id=project.id, user_id=other_user.id))

        # Email notification is best-effort: a failed send must never
        # roll back a message that was already saved successfully.
        try:
            notify_new_message(message)
        except Exception as exc:
            from flask import current_app
            current_app.logger.error(f"Failed to email notification for message {message.id}: {exc}")

        return redirect(url_for("messaging.thread", project_id=project.id, user_id=other_user.id))

    # --- GET: load the thread and mark incoming messages as read ---
    thread_messages = (
        Message.query.filter_by(project_id=project.id)
        .filter(
            db.or_(
                db.and_(Message.sender_id == current_user.id, Message.receiver_id == other_user.id),
                db.and_(Message.sender_id == other_user.id, Message.receiver_id == current_user.id),
            )
        )
        .order_by(Message.created_at.asc())
        .all()
    )

    unread = [m for m in thread_messages if m.receiver_id == current_user.id and m.read_at is None]
    if unread:
        now = datetime.utcnow()
        for m in unread:
            m.read_at = now
        try:
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            from flask import current_app
            current_app.logger.error(f"Failed to mark messages read for user {current_user.id}: {exc}")

    return render_template(
        "messaging/thread.html", project=project, other_user=other_user, messages=thread_messages
    )
