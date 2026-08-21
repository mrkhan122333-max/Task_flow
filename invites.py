"""
invites.py
----------
Admin-only project invitations sent by email, plus the public
"accept invite" flow a recipient uses to join without already having
an account.

New DB objects used: models.ProjectInvite, models.ProjectMembership.
Emails sent via email_service.py (which itself picks Gmail API
OAuth2 vs SMTP vs console - see that module).

RBAC:
    - Only admins can create/resend/cancel invites for a project
      (@role_required(ROLE_ADMIN)) and, via _get_project_or_404
      (imported from main.routes, unchanged), an admin can act on
      ANY project - matching the existing app-wide rule that admins
      aren't scoped to "their" projects the way analysts are.
    - Accepting an invite requires no login: the token itself is the
      credential. It's a 32-byte url-safe random value
      (ProjectInvite.generate_token), so it isn't guessable/brute
      -forceable in any practical sense.
"""

from datetime import datetime, timedelta

from flask import (
    Blueprint, render_template, redirect, url_for, flash, request,
    current_app, abort,
)
from flask_login import login_required, current_user, login_user
from email_validator import validate_email, EmailNotValidError
from sqlalchemy.exc import IntegrityError

from extensions import db
from decorators import role_required
from models import (
    ProjectInvite, ProjectMembership, User,
    ROLE_ADMIN, ROLE_ANALYST, VALID_ROLES,
    INVITE_PENDING, INVITE_ACCEPTED, INVITE_EXPIRED,
)
from main.routes import _get_project_or_404
from email_service import notify_invite_sent, notify_invite_accepted

invites_bp = Blueprint("invites", __name__, template_folder="../templates")


def _default_expiry():
    hours = current_app.config.get("INVITE_EXPIRY_HOURS", 72)
    return datetime.utcnow() + timedelta(hours=hours)


def _sync_membership_role(project_id, user_id, role):
    """After adding someone to project.members (which defaults the
    new ProjectMembership's role to their *account* role), overwrite
    it with the role the admin actually picked in the invite form -
    the two can differ (e.g. inviting an existing admin account to
    join a project as an analyst-level contributor)."""
    membership = ProjectMembership.query.filter_by(project_id=project_id, user_id=user_id).first()
    if membership:
        membership.role = role


@invites_bp.route("/projects/<int:project_id>/invites", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def invite_create(project_id):
    """Create + email a project invite.

    - Validates the email address (email_validator - already a
      project dependency, used the same way auth/routes.py's signup
      validates input).
    - Rejects a second *pending, non-expired* invite to the same
      address on the same project (duplicate-invite guard).
    - If the address already belongs to an existing user who isn't
      yet a member, adds them to the project directly instead of
      generating a signup token - an existing account doesn't need
      to "sign up" again.
    """
    project = _get_project_or_404(project_id)

    raw_email = request.form.get("email", "").strip()
    role = request.form.get("role", ROLE_ANALYST)

    if role not in VALID_ROLES:
        flash("Invalid role selected.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))

    try:
        valid = validate_email(raw_email, check_deliverability=False)
        email = valid.normalized.lower()
    except EmailNotValidError as exc:
        flash(f"Invalid email address: {exc}", "error")
        return redirect(url_for("main.project_team", project_id=project.id))

    # ASSUMPTION: the spec says "entering their Gmail address", read
    # here as "an email address, delivered via Gmail" rather than a
    # strict @gmail.com requirement - hard-blocking Google Workspace
    # addresses (which aren't @gmail.com but ARE Gmail) would almost
    # certainly be the wrong call. Flip this on if a literal
    # @gmail.com-only restriction is actually wanted:
    # if not email.endswith("@gmail.com"):
    #     flash("Please enter a Gmail address.", "error")
    #     return redirect(url_for("main.project_team", project_id=project.id))

    existing_user = User.query.filter_by(email=email).first()
    if existing_user and existing_user in project.members:
        flash(f"{email} is already a member of this project.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))

    # --- duplicate-invite guard -------------------------------------
    # Checked at the application layer (query, then insert). SQLite's
    # locking model doesn't give us a real SELECT ... FOR UPDATE, so
    # there's a narrow race window under simultaneous double-submits;
    # the IntegrityError catch further down is the backstop for that.
    dup = ProjectInvite.query.filter_by(
        project_id=project.id, email=email, status=INVITE_PENDING
    ).first()
    if dup and not dup.is_expired():
        flash(f"An invite is already pending for {email}.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))
    if dup and dup.is_expired():
        dup.status = INVITE_EXPIRED  # settle the stale row before creating a new one

    if existing_user:
        try:
            project.members.append(existing_user)
            _sync_membership_role(project.id, existing_user.id, role)
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            current_app.logger.error(
                f"Failed to add existing user {email} to project {project.id}: {exc}"
            )
            flash("Something went wrong adding that user. Please try again.", "error")
            return redirect(url_for("main.project_team", project_id=project.id))

        try:
            notify_invite_accepted(project, existing_user, added_directly=True)
        except Exception as exc:
            current_app.logger.error(f"Failed to notify admins that {email} was added: {exc}")

        flash(
            f"{existing_user.name} was added to the project directly "
            f"(they already had an account).",
            "success",
        )
        return redirect(url_for("main.project_team", project_id=project.id))

    invite = ProjectInvite(
        project_id=project.id,
        email=email,
        role=role,
        token=ProjectInvite.generate_token(),
        status=INVITE_PENDING,
        invited_by_id=current_user.id,
        expires_at=_default_expiry(),
    )

    try:
        db.session.add(invite)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        flash(f"An invite is already pending for {email}.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))
    except Exception as exc:
        db.session.rollback()
        current_app.logger.error(f"Failed to create invite for {email}: {exc}")
        flash("Could not create the invite. Please try again.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))

    join_url = url_for("invites.invite_accept", token=invite.token, _external=True)
    try:
        notify_invite_sent(invite, join_url)
    except Exception as exc:
        # The invite row already exists and is valid - don't roll it
        # back just because the email failed to send. The admin can
        # hit "Resend" once the underlying email problem is fixed.
        current_app.logger.error(f"Failed to email invite to {email}: {exc}")
        flash(
            f"Invite created for {email}, but the notification email failed to send "
            f"(see server logs). You can retry with Resend below.",
            "error",
        )
        return redirect(url_for("main.project_team", project_id=project.id))

    flash(f"Invite sent to {email}.", "success")
    return redirect(url_for("main.project_team", project_id=project.id))


@invites_bp.route("/projects/<int:project_id>/invites/<int:invite_id>/resend", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def invite_resend(project_id, invite_id):
    project = _get_project_or_404(project_id)
    invite = ProjectInvite.query.get_or_404(invite_id)
    if invite.project_id != project.id:
        abort(404)

    invite.token = ProjectInvite.generate_token()
    invite.status = INVITE_PENDING
    invite.expires_at = _default_expiry()

    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        current_app.logger.error(f"Failed to resend invite {invite_id}: {exc}")
        flash("Could not resend the invite. Please try again.", "error")
        return redirect(url_for("main.project_team", project_id=project.id))

    try:
        join_url = url_for("invites.invite_accept", token=invite.token, _external=True)
        notify_invite_sent(invite, join_url)
        flash(f"Invite resent to {invite.email}.", "success")
    except Exception as exc:
        current_app.logger.error(f"Failed to email resent invite {invite_id}: {exc}")
        flash("Invite was refreshed, but the notification email failed to send.", "error")

    return redirect(url_for("main.project_team", project_id=project.id))


@invites_bp.route("/projects/<int:project_id>/invites/<int:invite_id>/cancel", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def invite_cancel(project_id, invite_id):
    project = _get_project_or_404(project_id)
    invite = ProjectInvite.query.get_or_404(invite_id)
    if invite.project_id != project.id:
        abort(404)

    try:
        db.session.delete(invite)
        db.session.commit()
        flash(f"Invite to {invite.email} cancelled.", "info")
    except Exception as exc:
        db.session.rollback()
        current_app.logger.error(f"Failed to cancel invite {invite_id}: {exc}")
        flash("Could not cancel the invite. Please try again.", "error")

    return redirect(url_for("main.project_team", project_id=project.id))


@invites_bp.route("/invites/<token>", methods=["GET", "POST"])
def invite_accept(token):
    """Public join page - deliberately no @login_required, since the
    token itself is the credential that authorizes access to it."""
    invite = ProjectInvite.query.filter_by(token=token).first()
    if invite is None:
        flash("This invite link is invalid.", "error")
        return redirect(url_for("auth.login"))

    if invite.status == INVITE_ACCEPTED:
        flash("This invite has already been used. Please log in instead.", "info")
        return redirect(url_for("auth.login"))

    if invite.is_expired():
        if invite.status == INVITE_PENDING:
            invite.status = INVITE_EXPIRED
            db.session.commit()
        flash("This invite link has expired. Ask the project admin to resend it.", "error")
        return redirect(url_for("auth.login"))

    # ASSUMPTION (edge case): if the invited email already has an
    # account - e.g. they signed up independently in the time between
    # being invited and clicking the link - we don't have their
    # password to log them in automatically, and creating a second
    # account for the same email would violate User.email's unique
    # constraint. Rather than silently failing there, just attach
    # them to the project and send them to log in normally.
    existing_user = User.query.filter_by(email=invite.email).first()
    if existing_user:
        try:
            project = invite.project
            if existing_user not in project.members:
                project.members.append(existing_user)
                _sync_membership_role(project.id, existing_user.id, invite.role)
            invite.status = INVITE_ACCEPTED
            invite.accepted_at = datetime.utcnow()
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            current_app.logger.error(f"Failed to attach existing user to invite {token}: {exc}")
            flash("Something went wrong. Please contact the project admin.", "error")
            return redirect(url_for("auth.login"))

        flash(
            "An account with this email already exists — you've been added to the "
            "project. Please log in.",
            "success",
        )
        return redirect(url_for("auth.login"))

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        if not name or not password:
            flash("All fields are required.", "error")
            return render_template("invites/accept.html", invite=invite)
        if password != confirm:
            flash("Passwords do not match.", "error")
            return render_template("invites/accept.html", invite=invite)
        if len(password) < 6:
            flash("Password must be at least 6 characters.", "error")
            return render_template("invites/accept.html", invite=invite)

        try:
            user = User(name=name, email=invite.email, role=invite.role)
            user.set_password(password)
            db.session.add(user)
            db.session.flush()  # assigns user.id before we create the membership row

            project = invite.project
            project.members.append(user)
            _sync_membership_role(project.id, user.id, invite.role)

            invite.status = INVITE_ACCEPTED
            invite.accepted_at = datetime.utcnow()
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            flash("An account with that email already exists. Please log in instead.", "error")
            return redirect(url_for("auth.login"))
        except Exception as exc:
            db.session.rollback()
            current_app.logger.error(f"Failed to complete invite acceptance for {token}: {exc}")
            flash("Something went wrong creating your account. Please try again.", "error")
            return render_template("invites/accept.html", invite=invite)

        login_user(user)
        try:
            notify_invite_accepted(invite.project, user, added_directly=False)
        except Exception as exc:
            current_app.logger.error(f"Failed to notify admins for accepted invite {token}: {exc}")

        flash(f"Welcome to {invite.project.name}!", "success")
        return redirect(url_for("main.dashboard"))

    return render_template("invites/accept.html", invite=invite)
