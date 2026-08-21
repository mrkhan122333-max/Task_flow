"""
scheduler.py
------------
Runs a periodic background job (APScheduler) that checks for tasks
whose due date is within DUE_DATE_WARNING_WINDOW_HOURS and emails the
assignee a reminder - satisfying the "due date approaching"
notification requirement without needing an external cron service.

Each task is only notified once (due_soon_notified flag on the Task
model) so re-running the check doesn't spam the same reminder.
"""

from datetime import date, timedelta
from apscheduler.schedulers.background import BackgroundScheduler

from extensions import db
from models import Task, STATUS_COMPLETE
from email_utils import notify_due_date_approaching


def check_due_dates(app):
    """Find tasks due soon (and not yet complete/notified) and email
    their assignees. Wrapped with app.app_context() because
    APScheduler jobs run outside the normal Flask request cycle."""
    with app.app_context():
        window_hours = app.config["DUE_DATE_WARNING_WINDOW_HOURS"]
        cutoff = date.today() + timedelta(hours=window_hours)

        soon_due_tasks = Task.query.filter(
            Task.due_date.isnot(None),
            Task.due_date <= cutoff,
            Task.due_date >= date.today(),
            Task.status != STATUS_COMPLETE,
            Task.due_soon_notified.is_(False),
            Task.assignee_id.isnot(None),
        ).all()

        for task in soon_due_tasks:
            notify_due_date_approaching(task)
            task.due_soon_notified = True

        if soon_due_tasks:
            db.session.commit()


def start_scheduler(app):
    scheduler = BackgroundScheduler(daemon=True)
    interval_hours = app.config["DUE_DATE_CHECK_INTERVAL_HOURS"]
    scheduler.add_job(
        func=lambda: check_due_dates(app),
        trigger="interval",
        hours=interval_hours,
        next_run_time=None,  # don't fire immediately on startup
        id="due_date_check",
        replace_existing=True,
    )
    scheduler.start()
    return scheduler
