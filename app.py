"""
app.py
------
Application entry point. Run with:

    python app.py

Schema management: this app uses Flask-Migrate (Alembic) - see
migrations/. Unlike earlier versions, this does NOT require you to
manually run `flask db upgrade` before starting the app: create_app()
below automatically brings the database up to the latest schema on
startup (see _auto_migrate()), so `python app.py` alone is enough on
a totally fresh checkout, on an existing pre-migrations database, and
on every future schema change. `flask db upgrade` is still there and
still works identically if you'd rather run migrations as an explicit
step (e.g. as part of a deploy pipeline) - set AUTO_MIGRATE=false in
.env to disable the automatic run and manage it yourself.
"""

import os
from flask import Flask, render_template

from config import Config
from extensions import db, login_manager, mail, migrate
from models import User
from text_utils import linkify


def _auto_migrate(app):
    """Bring the DB schema up to date on startup, with zero manual
    steps required, in three situations:

    1. Brand new / empty DB (nothing exists yet): Alembic's `upgrade`
       runs every migration from scratch, creating the full schema.
    2. An existing DB from before this app used Alembic at all (its
       tables exist - e.g. `user` - but there's no `alembic_version`
       table yet, because it was created the old way via
       `db.create_all()`): we can't just call `upgrade()` here, since
       Alembic would try to CREATE tables that already exist and
       fail. So we detect this case and `stamp` the DB at the
       pre-Alembic baseline revision first - that's the exact manual
       fix documented in earlier versions of this README, now applied
       automatically instead of requiring the person running the app
       to know Alembic exists.
    3. An already-migrated DB, just not yet on the newest revision:
       `upgrade()` applies whatever's missing and is a safe no-op if
       it's already current.

    Errors are logged, not silently swallowed, and re-raised so a
    genuinely broken DB doesn't start serving requests against a
    schema it doesn't actually have (rather than failing later, more
    confusingly, on the first query - like the "no such table: user"
    error this replaces).
    """
    import sqlalchemy as sa
    from flask_migrate import upgrade as migrate_upgrade, stamp as migrate_stamp

    # The revision ID of migrations/versions/0001_baseline_schema.py -
    # see that file's docstring for what it represents.
    BASELINE_REVISION = "0b003ebbc203"

    with app.app_context():
        try:
            inspector = sa.inspect(db.engine)
            existing_tables = set(inspector.get_table_names())

            if existing_tables and "alembic_version" not in existing_tables:
                app.logger.info(
                    "Detected an existing database created before Flask-Migrate "
                    f"was added (tables present: {sorted(existing_tables)}, no "
                    "alembic_version table). Stamping it at the pre-migrations "
                    "baseline before upgrading, so existing data is preserved."
                )
                migrate_stamp(revision=BASELINE_REVISION)

            migrate_upgrade()
        except Exception:
            app.logger.exception(
                "Automatic database migration failed. The app cannot start "
                "safely against an out-of-date schema. If this keeps "
                "happening, run `flask db upgrade` manually (see README's "
                "'Set up the database' section) to see the full Alembic "
                "error, or set AUTO_MIGRATE=false in .env to manage "
                "migrations yourself."
            )
            raise


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    login_manager.init_app(app)
    mail.init_app(app)
    migrate.init_app(app, db)

    app.jinja_env.filters["linkify"] = linkify

    from auth import auth_bp
    from main import main_bp
    from invites import invites_bp
    from messaging import messaging_bp
    from attachments import attachments_bp
    from analytics import analytics_bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)
    app.register_blueprint(invites_bp)
    app.register_blueprint(messaging_bp)
    app.register_blueprint(attachments_bp)
    app.register_blueprint(analytics_bp)

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    @app.errorhandler(403)
    def forbidden(e):
        return render_template("errors/403.html"), 403

    @app.errorhandler(404)
    def not_found(e):
        return render_template("errors/404.html"), 404

    @app.errorhandler(413)
    def too_large(e):
        # Fired by Flask itself when a request body exceeds
        # MAX_CONTENT_LENGTH (config.py) - the file-size-specific
        # message from attachments.save_comment_attachment covers the
        # more common case of a single oversized file that still fits
        # under this hard ceiling; this is the backstop for anything
        # that doesn't.
        from flask import request, redirect, url_for, flash
        flash("That upload was too large. Max file size is 10MB.", "error")
        if request.referrer:
            return redirect(request.referrer)
        return render_template("errors/404.html"), 413

    @app.context_processor
    def inject_globals():
        # Makes these available in every template without passing
        # them explicitly from every view.
        from models import (
            STATUS_NOT_STARTED, STATUS_ONGOING, STATUS_HOLD, STATUS_COMPLETE,
            VALID_STATUSES, STATUS_LABELS, VALID_PRIORITIES,
        )
        return dict(
            STATUS_NOT_STARTED=STATUS_NOT_STARTED,
            STATUS_ONGOING=STATUS_ONGOING,
            STATUS_HOLD=STATUS_HOLD,
            STATUS_COMPLETE=STATUS_COMPLETE,
            VALID_STATUSES=VALID_STATUSES,
            STATUS_LABELS=STATUS_LABELS,
            VALID_PRIORITIES=VALID_PRIORITIES,
        )

    if app.config.get("TESTING"):
        # Test runs (smoke_test.py) manage their own throwaway
        # in-memory schema directly via db.create_all() - migrations
        # are for real, persistent databases.
        with app.app_context():
            db.create_all()
    elif app.config.get("AUTO_MIGRATE", True):
        # Only run this once per process - with the Flask reloader,
        # the parent "watcher" process would otherwise also try to
        # migrate (harmless since it's idempotent, but noisy and
        # redundant).
        is_reloader_parent = (
            app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true"
        )
        if not is_reloader_parent:
            _auto_migrate(app)

    # Only start the background scheduler in the actual worker process.
    # With the Flask reloader, the parent "watcher" process re-imports
    # this module too (WERKZEUG_RUN_MAIN unset there); we don't want a
    # duplicate scheduler running in that process. When the reloader
    # is off entirely (e.g. WERKZEUG_RUN_MAIN never gets set, as in
    # production), we still want the scheduler to start.
    is_reloader_parent = (
        app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true"
    )
    if not is_reloader_parent and not app.config.get("TESTING"):
        from scheduler import start_scheduler
        start_scheduler(app)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
