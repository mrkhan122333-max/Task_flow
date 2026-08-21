"""
analytics.py
-------------
Admin-only reporting dashboard (`/admin/dashboard`): task-status and
completion-over-time charts (Chart.js, fed by a JSON endpoint), plus
server-rendered per-project and per-user summary tables. Every number
comes from a real SQLAlchemy query against the live DB - nothing here
is hardcoded or mocked.

RBAC: reuses the exact same @role_required(ROLE_ADMIN) pattern
already used throughout main/routes.py (see decorators.py) rather
than inventing a new permission check.

ASSUMPTION (flagged): Task has no dedicated `completed_at` column, so
"completed over time" uses `Task.updated_at` as a proxy for "the day
this task most recently became complete" (updated_at is refreshed by
SQLAlchemy's onupdate=datetime.utcnow whenever a task's `status`
column changes, which is exactly what happens on both the toggle
route and the edit form). This is accurate for the common case (a
task is completed once and stays that way) but can be imprecise if a
task is repeatedly toggled complete/incomplete on the same day, since
we only see its current status and last-updated timestamp, not a full
status history. Adding a real completed_at column was considered out
of scope since the spec's migration list only calls for
`start_date` + `CommentAttachment` - this can be tightened later by
adding one, following the same migration pattern used here.
"""

from datetime import date, timedelta

from flask import Blueprint, render_template, jsonify
from flask_login import login_required

from decorators import role_required
from extensions import db
from models import (
    User, Project, Task,
    ROLE_ADMIN, ROLE_ANALYST,
    STATUS_NOT_STARTED, STATUS_ONGOING, STATUS_HOLD, STATUS_COMPLETE,
)

analytics_bp = Blueprint("analytics", __name__, template_folder="../templates")

# How many trailing days the "completed over time" line chart covers.
TIMELINE_DAYS = 14


def _status_counts():
    """{'not_started': n, 'ongoing': n, 'hold': n, 'complete': n}
    across all tasks."""
    rows = (
        db.session.query(Task.status, db.func.count(Task.id))
        .group_by(Task.status)
        .all()
    )
    counts = {
        STATUS_NOT_STARTED: 0, STATUS_ONGOING: 0, STATUS_HOLD: 0, STATUS_COMPLETE: 0,
    }
    for status, count in rows:
        counts[status] = count
    return counts


def _timeline(days=TIMELINE_DAYS):
    """Day-by-day series for the last `days` days: how many tasks
    were created that day, and how many are currently complete with
    their last update on that day (see module docstring for the
    completed_at-proxy caveat)."""
    start = date.today() - timedelta(days=days - 1)

    created_rows = (
        db.session.query(db.func.date(Task.created_at), db.func.count(Task.id))
        .filter(db.func.date(Task.created_at) >= start.isoformat())
        .group_by(db.func.date(Task.created_at))
        .all()
    )
    created_by_day = {str(d): c for d, c in created_rows}

    completed_rows = (
        db.session.query(db.func.date(Task.updated_at), db.func.count(Task.id))
        .filter(Task.status == STATUS_COMPLETE)
        .filter(db.func.date(Task.updated_at) >= start.isoformat())
        .group_by(db.func.date(Task.updated_at))
        .all()
    )
    completed_by_day = {str(d): c for d, c in completed_rows}

    labels, created, completed = [], [], []
    for offset in range(days):
        day = start + timedelta(days=offset)
        key = day.isoformat()
        labels.append(day.strftime("%d %b"))
        created.append(created_by_day.get(key, 0))
        completed.append(completed_by_day.get(key, 0))

    return {"labels": labels, "created": created, "completed": completed}


def _per_project_stats():
    """One row per project: total tasks, % complete (reusing the
    existing Project.progress_percent()), and overdue count."""
    rows = []
    for project in Project.query.order_by(Project.name).all():
        total = len(project.tasks)
        overdue = sum(1 for t in project.tasks if t.is_overdue())
        rows.append({
            "project": project,
            "total": total,
            "percent_complete": project.progress_percent(),
            "overdue": overdue,
        })
    return rows


def _per_user_stats():
    """One row per analyst: tasks assigned, tasks completed,
    completion rate. Single aggregated query rather than N+1 - grouped
    by assignee_id, then matched up against the analyst list so
    analysts with zero tasks still show a 0-row instead of being
    omitted."""
    assigned_rows = dict(
        db.session.query(Task.assignee_id, db.func.count(Task.id))
        .filter(Task.assignee_id.isnot(None))
        .group_by(Task.assignee_id)
        .all()
    )
    completed_rows = dict(
        db.session.query(Task.assignee_id, db.func.count(Task.id))
        .filter(Task.assignee_id.isnot(None), Task.status == STATUS_COMPLETE)
        .group_by(Task.assignee_id)
        .all()
    )

    rows = []
    for user in User.query.filter_by(role=ROLE_ANALYST).order_by(User.name).all():
        assigned = assigned_rows.get(user.id, 0)
        completed = completed_rows.get(user.id, 0)
        rate = round((completed / assigned) * 100) if assigned else 0
        rows.append({
            "user": user, "assigned": assigned, "completed": completed, "rate": rate,
        })
    return rows


@analytics_bp.route("/admin/dashboard")
@login_required
@role_required(ROLE_ADMIN)
def admin_dashboard():
    return render_template(
        "admin/dashboard.html",
        status_counts=_status_counts(),
        project_stats=_per_project_stats(),
        user_stats=_per_user_stats(),
        timeline_days=TIMELINE_DAYS,
    )


@analytics_bp.route("/admin/dashboard/data")
@login_required
@role_required(ROLE_ADMIN)
def admin_dashboard_data():
    """JSON feed consumed by Chart.js on the dashboard page. Split
    out from the page route (rather than inlining the data as a
    <script> block) so the numbers are always a fresh query result
    even if the page itself is cached, and so the shape is easy to
    smoke-test independently of HTML rendering."""
    return jsonify({
        "status_counts": _status_counts(),
        "timeline": _timeline(),
    })
