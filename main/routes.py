"""
main/routes.py
---------------
Core application routes: dashboard, projects (board view), task CRUD,
subtasks, comments, and admin user management.

RBAC summary (enforced via @role_required, not just hidden buttons):
    - Analysts: can view projects/tasks they're a member of, and may
      set the status of tasks assigned to them to any of the 4 valid
      statuses (not started / ongoing / hold / complete). Nothing
      else.
    - Admins: everything - create/edit/delete tasks & projects,
      reassign, change due dates, and manage user roles.
"""

from datetime import datetime, date, timedelta

from flask import render_template, redirect, url_for, flash, request, abort, current_app
from flask_login import login_required, current_user

from main import main_bp
from extensions import db
from decorators import role_required
from models import (
    User, Project, Task, Subtask, Comment,
    ProjectMembership, ProjectInvite,
    ROLE_ADMIN, ROLE_ANALYST, VALID_ROLES,
    STATUS_NOT_STARTED, STATUS_ONGOING, STATUS_HOLD, STATUS_COMPLETE,
    VALID_STATUSES, STATUS_LABELS,
    VALID_PRIORITIES, INVITE_PENDING, INVITE_EXPIRED,
)
from email_utils import (
    notify_task_assigned, notify_status_changed,
)
from attachments import save_comment_attachment, AttachmentError


# ---------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------

@main_bp.route("/")
@login_required
def dashboard():
    if current_user.is_admin:
        projects = Project.query.all()
    else:
        projects = current_user.projects

    my_tasks = (
        Task.query.filter_by(assignee_id=current_user.id)
        .order_by(Task.due_date.is_(None), Task.due_date.asc())
        .all()
    )

    stats = {
        "total": len(my_tasks),
        "complete": sum(1 for t in my_tasks if t.status == STATUS_COMPLETE),
        "overdue": sum(1 for t in my_tasks if t.is_overdue()),
    }

    return render_template(
        "dashboard.html", projects=projects, my_tasks=my_tasks, stats=stats
    )


# ---------------------------------------------------------------
# Projects
# ---------------------------------------------------------------

@main_bp.route("/projects")
@login_required
def project_list():
    if current_user.is_admin:
        projects = Project.query.all()
    else:
        projects = current_user.projects
    return render_template("projects/list.html", projects=projects)


@main_bp.route("/projects/new", methods=["GET", "POST"])
@login_required
@role_required(ROLE_ADMIN)
def project_new():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        description = request.form.get("description", "").strip()
        member_ids = request.form.getlist("member_ids")

        if not name:
            flash("Project name is required.", "error")
            return render_template("projects/new.html", users=User.query.all())

        project = Project(name=name, description=description, owner_id=current_user.id)
        db.session.add(project)
        project.members.append(current_user)
        for uid in member_ids:
            user = User.query.get(int(uid))
            if user and user not in project.members:
                project.members.append(user)

        db.session.commit()
        flash(f'Project "{project.name}" created.', "success")
        return redirect(url_for("main.project_board", project_id=project.id))

    return render_template("projects/new.html", users=User.query.all())


def _get_project_or_404(project_id):
    project = Project.query.get_or_404(project_id)
    if not current_user.is_admin and current_user not in project.members:
        abort(403)
    return project


@main_bp.route("/projects/<int:project_id>")
@login_required
def project_board(project_id):
    project = _get_project_or_404(project_id)

    columns = {
        STATUS_NOT_STARTED: [],
        STATUS_ONGOING: [],
        STATUS_HOLD: [],
        STATUS_COMPLETE: [],
    }
    for task in project.tasks:
        columns.setdefault(task.status, []).append(task)

    return render_template("projects/board.html", project=project, columns=columns)


@main_bp.route("/projects/<int:project_id>/team")
@login_required
def project_team(project_id):
    """Members tab: everyone on the project with their per-project
    role, plus (admins only) the list of outstanding invites and a
    form to send new ones. This is the page invites.py redirects
    back to after every invite create/resend/cancel action.
    """
    project = _get_project_or_404(project_id)

    # Per-project role (ProjectMembership.role) for each member, keyed
    # by user id, so the template can show "Admin"/"Analyst" without
    # an extra query per row.
    memberships = ProjectMembership.query.filter_by(project_id=project.id).all()
    roles_by_user_id = {m.user_id: m.role for m in memberships}

    invites = []
    if current_user.is_admin:
        invites = (
            ProjectInvite.query.filter_by(project_id=project.id)
            .order_by(ProjectInvite.created_at.desc())
            .all()
        )
        # Lazily flip anything that's expired-but-still-marked-pending
        # so the status shown is always accurate, even if no one has
        # tried to use the link since it expired.
        changed = False
        for invite in invites:
            if invite.status == INVITE_PENDING and invite.is_expired():
                invite.status = INVITE_EXPIRED
                changed = True
        if changed:
            db.session.commit()

    return render_template(
        "projects/team.html",
        project=project,
        roles_by_user_id=roles_by_user_id,
        invites=invites,
        valid_roles=VALID_ROLES,
    )


@main_bp.route("/projects/<int:project_id>/delete", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def project_delete(project_id):
    project = Project.query.get_or_404(project_id)
    db.session.delete(project)
    db.session.commit()
    flash(f'Project "{project.name}" deleted.', "info")
    return redirect(url_for("main.project_list"))


# ---------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------

def _parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _validate_task_dates(start_date, due_date):
    """Shared start/due date rule for both create and edit: if both
    are set, start must be on or before due. Returns an error message
    (falsy if valid) so callers can flash it and re-render their form.
    """
    if start_date and due_date and start_date > due_date:
        return "Start date must be on or before the due date."
    return None


@main_bp.route("/projects/<int:project_id>/tasks/new", methods=["GET", "POST"])
@login_required
@role_required(ROLE_ADMIN)
def task_new(project_id):
    project = Project.query.get_or_404(project_id)

    if request.method == "POST":
        title = request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()
        start_date = _parse_date(request.form.get("start_date"))
        due_date = _parse_date(request.form.get("due_date"))
        priority = request.form.get("priority", "medium")
        assignee_id = request.form.get("assignee_id") or None

        if not title:
            flash("Task title is required.", "error")
            return render_template("tasks/new.html", project=project, form=request.form)
        date_error = _validate_task_dates(start_date, due_date)
        if date_error:
            flash(date_error, "error")
            return render_template("tasks/new.html", project=project, form=request.form)
        if priority not in VALID_PRIORITIES:
            priority = "medium"

        task = Task(
            project_id=project.id,
            title=title,
            description=description,
            start_date=start_date,
            due_date=due_date,
            priority=priority,
            assignee_id=int(assignee_id) if assignee_id else None,
            creator_id=current_user.id,
        )
        db.session.add(task)
        db.session.commit()

        if task.assignee_id:
            notify_task_assigned(task)

        flash(f'Task "{task.title}" created.', "success")
        return redirect(url_for("main.project_board", project_id=project.id))

    return render_template("tasks/new.html", project=project, form=None)


def _get_task_or_404(task_id):
    task = Task.query.get_or_404(task_id)
    if not current_user.is_admin and current_user not in task.project.members:
        abort(403)
    return task


@main_bp.route("/tasks/<int:task_id>")
@login_required
def task_detail(task_id):
    task = _get_task_or_404(task_id)
    return render_template("tasks/detail.html", task=task)


@main_bp.route("/tasks/<int:task_id>/edit", methods=["GET", "POST"])
@login_required
@role_required(ROLE_ADMIN)
def task_edit(task_id):
    task = Task.query.get_or_404(task_id)

    if request.method == "POST":
        old_status = task.status
        old_assignee_id = task.assignee_id

        title = request.form.get("title", task.title).strip()
        start_date = _parse_date(request.form.get("start_date"))
        due_date = _parse_date(request.form.get("due_date"))

        date_error = _validate_task_dates(start_date, due_date)
        if date_error:
            flash(date_error, "error")
            # Re-render with what the user just typed rather than
            # silently reverting to the last-saved values, so a date
            # typo doesn't cost them the rest of the edit too.
            return render_template("tasks/edit.html", task=task, form=request.form)

        task.title = title
        task.description = request.form.get("description", "").strip()
        task.start_date = start_date
        task.due_date = due_date
        priority = request.form.get("priority", task.priority)
        status = request.form.get("status", task.status)
        assignee_id = request.form.get("assignee_id") or None

        if priority in VALID_PRIORITIES:
            task.priority = priority
        if status in VALID_STATUSES:
            task.status = status
        task.assignee_id = int(assignee_id) if assignee_id else None

        # Reset the "due soon" flag if the due date changed, so a new
        # reminder can fire for the new date.
        task.due_soon_notified = False

        db.session.commit()

        if task.assignee_id and task.assignee_id != old_assignee_id:
            notify_task_assigned(task)
        if task.status != old_status:
            notify_status_changed(task, current_user, old_status, task.status)

        flash("Task updated.", "success")
        return redirect(url_for("main.task_detail", task_id=task.id))

    return render_template("tasks/edit.html", task=task, form=None)


@main_bp.route("/tasks/<int:task_id>/delete", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def task_delete(task_id):
    task = Task.query.get_or_404(task_id)
    project_id = task.project_id
    db.session.delete(task)
    db.session.commit()
    flash("Task deleted.", "info")
    return redirect(url_for("main.project_board", project_id=project_id))


@main_bp.route("/tasks/<int:task_id>/status", methods=["POST"])
@login_required
def task_update_status(task_id):
    """Lets the person doing the work own the status field, Asana-
    style: analysts may set the status of tasks assigned to them to
    any of the 4 valid statuses (not started / ongoing / hold /
    complete) from the task detail page. Admins can do this for any
    task too (the edit page also covers full status control)."""
    task = Task.query.get_or_404(task_id)

    if current_user.role == ROLE_ANALYST:
        if task.assignee_id != current_user.id:
            abort(403)
    elif current_user.role != ROLE_ADMIN:
        abort(403)

    new_status = request.form.get("status")
    if new_status not in VALID_STATUSES:
        flash("Invalid status.", "error")
        return redirect(request.referrer or url_for("main.task_detail", task_id=task.id))

    old_status = task.status
    if new_status != old_status:
        task.status = new_status
        db.session.commit()
        notify_status_changed(task, current_user, old_status, task.status)
        flash(f'Task marked as "{STATUS_LABELS[task.status]}".', "success")

    return redirect(request.referrer or url_for("main.task_detail", task_id=task.id))


# ---------------------------------------------------------------
# Subtasks
# ---------------------------------------------------------------

@main_bp.route("/tasks/<int:task_id>/subtasks", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def subtask_add(task_id):
    task = Task.query.get_or_404(task_id)
    title = request.form.get("title", "").strip()
    if title:
        db.session.add(Subtask(task_id=task.id, title=title))
        db.session.commit()
    return redirect(url_for("main.task_detail", task_id=task.id))


@main_bp.route("/subtasks/<int:subtask_id>/toggle", methods=["POST"])
@login_required
def subtask_toggle(subtask_id):
    subtask = Subtask.query.get_or_404(subtask_id)
    task = subtask.task

    if current_user.role == ROLE_ANALYST and task.assignee_id != current_user.id:
        abort(403)
    elif current_user.role not in (ROLE_ADMIN, ROLE_ANALYST):
        abort(403)

    subtask.is_complete = not subtask.is_complete
    db.session.commit()
    return redirect(url_for("main.task_detail", task_id=task.id))


# ---------------------------------------------------------------
# Comments
# ---------------------------------------------------------------

@main_bp.route("/tasks/<int:task_id>/comments", methods=["POST"])
@login_required
def comment_add(task_id):
    task = _get_task_or_404(task_id)
    body = request.form.get("body", "").strip()
    upload = request.files.get("attachment")
    has_upload = bool(upload and upload.filename)

    if not body and not has_upload:
        flash("Write something or attach a file before commenting.", "error")
        return redirect(url_for("main.task_detail", task_id=task.id))

    comment = Comment(task_id=task.id, user_id=current_user.id, body=body or "")
    db.session.add(comment)

    if has_upload:
        try:
            save_comment_attachment(upload, comment)
        except AttachmentError as exc:
            db.session.rollback()
            flash(str(exc), "error")
            return redirect(url_for("main.task_detail", task_id=task.id))

    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        current_app.logger.error(f"Failed to save comment on task {task.id}: {exc}")
        flash("Something went wrong posting your comment. Please try again.", "error")

    return redirect(url_for("main.task_detail", task_id=task.id))


# ---------------------------------------------------------------
# Admin: user / role management
# ---------------------------------------------------------------

@main_bp.route("/admin/users")
@login_required
@role_required(ROLE_ADMIN)
def manage_users():
    users = User.query.order_by(User.created_at).all()
    return render_template("admin/users.html", users=users, valid_roles=VALID_ROLES)


@main_bp.route("/admin/users/<int:user_id>/role", methods=["POST"])
@login_required
@role_required(ROLE_ADMIN)
def change_user_role(user_id):
    user = User.query.get_or_404(user_id)
    new_role = request.form.get("role")

    if new_role not in VALID_ROLES:
        flash("Invalid role.", "error")
        return redirect(url_for("main.manage_users"))

    if user.id == current_user.id and new_role != ROLE_ADMIN:
        # Prevent an admin from locking themselves out entirely if
        # they are the only admin left.
        remaining_admins = User.query.filter(
            User.role == ROLE_ADMIN, User.id != user.id
        ).count()
        if remaining_admins == 0:
            flash("You can't remove the last remaining admin.", "error")
            return redirect(url_for("main.manage_users"))

    user.role = new_role
    db.session.commit()
    flash(f"{user.name}'s role updated to {new_role}.", "success")
    return redirect(url_for("main.manage_users"))
