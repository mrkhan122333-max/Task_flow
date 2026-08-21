"""
models.py
---------
SQLAlchemy models for the application.

Roles (RBAC):
    - "admin"   : full control over tasks/projects/users
    - "analyst" : read-only on task details; may set a task's status
                  (not started / ongoing / hold / complete) for tasks
                  assigned to them.

The role is stored as a plain string column on User and is enforced
in routes.py via the @role_required decorator (see decorators.py) -
enforcement happens on the server, not just by hiding UI buttons.

Status model: as of migration 0003, tasks use a 4-value status field
that the assignee owns and updates directly (Asana-style), rather
than the old todo/in_progress/complete set:
    - "not_started" : work hasn't begun yet (default for new tasks)
    - "ongoing"      : actively being worked on
    - "hold"         : paused/blocked
    - "complete"     : done (kept as its own status, not merged into
                        "ongoing", so completion-rate analytics,
                        overdue logic, and due-date reminder emails -
                        all of which key off STATUS_COMPLETE - keep
                        working unchanged; see migration 0003's
                        docstring for the full list of call sites this
                        was checked against)
"""

import secrets
from datetime import datetime, date
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

from extensions import db

ROLE_ADMIN = "admin"
ROLE_ANALYST = "analyst"
VALID_ROLES = (ROLE_ADMIN, ROLE_ANALYST)

STATUS_NOT_STARTED = "not_started"
STATUS_ONGOING = "ongoing"
STATUS_HOLD = "hold"
STATUS_COMPLETE = "complete"
VALID_STATUSES = (STATUS_NOT_STARTED, STATUS_ONGOING, STATUS_HOLD, STATUS_COMPLETE)

# Human-readable labels and badge/color keys, kept together so every
# template pulls from one source instead of re-deriving labels from
# the raw status string (which used to be done with
# `status.replace('_', ' ')` - fragile the moment a status has more
# than one underscore-separated word, e.g. "not_started").
STATUS_LABELS = {
    STATUS_NOT_STARTED: "Not started",
    STATUS_ONGOING: "Ongoing",
    STATUS_HOLD: "Hold",
    STATUS_COMPLETE: "Complete",
}

# Due-date urgency tiers, used to color-code due dates on the
# dashboard the same way Asana does. Kept as named constants (not
# just strings inline) so the CSS class names (`due-<tier>`) and the
# logic in Task.due_urgency() below can't drift apart.
DUE_OVERDUE = "overdue"   # red    - past due, or due today
DUE_SOON = "soon"         # blue   - due in 1-3 days
DUE_UPCOMING = "upcoming"  # green  - due in 4-7 days

PRIORITY_LOW = "low"
PRIORITY_MEDIUM = "medium"
PRIORITY_HIGH = "high"
VALID_PRIORITIES = (PRIORITY_LOW, PRIORITY_MEDIUM, PRIORITY_HIGH)

INVITE_PENDING = "pending"
INVITE_ACCEPTED = "accepted"
INVITE_EXPIRED = "expired"
VALID_INVITE_STATUSES = (INVITE_PENDING, INVITE_ACCEPTED, INVITE_EXPIRED)


class ProjectMembership(db.Model):
    """Association object for the Project<->User many-to-many.

    Mapped directly onto the same table used as Project.members'
    `secondary=` (see below) - this is SQLAlchemy's "association
    object that is also a secondary table" pattern. It lets us:
      - keep the existing simple `project.members.append(user)` /
        `user in project.members` calls used throughout main/routes.py
        and invites.py unchanged, AND
      - separately query/update the per-project `role` for a given
        (project, user) pair, which a plain secondary Table can't do
        because it has no queryable ORM identity of its own.

    `role` here is intentionally independent from User.role (the
    account-wide role). An admin can invite someone onto a specific
    project as an "analyst" contributor even if that person's account
    role is "admin" elsewhere, and vice versa. NOTE: actual RBAC
    enforcement across the app (main/routes.py's @role_required,
    messaging.py's admin<->analyst restriction) deliberately keeps
    using the account-wide User.role, exactly as the pre-existing
    codebase already did - this column is additive (used for the
    Team tab's displayed role and as the role a re-invited user is
    reset to), not a second permission system layered on top.
    """
    __tablename__ = "project_members"

    project_id = db.Column(db.Integer, db.ForeignKey("project.id"), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), primary_key=True)
    role = db.Column(db.String(20), nullable=False, default=ROLE_ANALYST)
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship("User", overlaps="projects,members")
    project = db.relationship("Project", overlaps="projects,members")


# Kept as the literal secondary= table for Project.members / User.projects.
# It IS ProjectMembership's table (same name) - the two below always agree.
project_members = ProjectMembership.__table__


class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default=ROLE_ANALYST)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    projects_owned = db.relationship("Project", backref="owner", lazy=True,
                                      foreign_keys="Project.owner_id")
    tasks_assigned = db.relationship("Task", backref="assignee", lazy=True,
                                      foreign_keys="Task.assignee_id")
    comments = db.relationship("Comment", backref="author", lazy=True)

    # --- Invitations & messaging (new) -----------------------------
    invites_sent = db.relationship("ProjectInvite", backref="invited_by", lazy=True,
                                    foreign_keys="ProjectInvite.invited_by_id")
    messages_sent = db.relationship("Message", backref="sender", lazy=True,
                                     foreign_keys="Message.sender_id")
    messages_received = db.relationship("Message", backref="receiver", lazy=True,
                                         foreign_keys="Message.receiver_id")

    def set_password(self, raw_password):
        self.password_hash = generate_password_hash(raw_password)

    def check_password(self, raw_password):
        return check_password_hash(self.password_hash, raw_password)

    @property
    def is_admin(self):
        return self.role == ROLE_ADMIN

    def __repr__(self):
        return f"<User {self.email} ({self.role})>"


class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    description = db.Column(db.Text, default="")
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    members = db.relationship("User", secondary=project_members, lazy="subquery",
                               backref=db.backref("projects", lazy=True),
                               overlaps="project,user")
    tasks = db.relationship("Task", backref="project", lazy=True,
                             cascade="all, delete-orphan")
    invites = db.relationship("ProjectInvite", backref="project", lazy=True,
                               cascade="all, delete-orphan")
    messages = db.relationship("Message", backref="project", lazy=True,
                                cascade="all, delete-orphan")

    def progress_percent(self):
        total = len(self.tasks)
        if total == 0:
            return 0
        done = sum(1 for t in self.tasks if t.status == STATUS_COMPLETE)
        return round((done / total) * 100)


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey("project.id"), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, default="")
    # Nullable so existing rows (created before this column existed)
    # migrate cleanly to start_date=NULL rather than failing/guessing
    # a value - see migrations/versions/0002_*.py.
    start_date = db.Column(db.Date, nullable=True)
    due_date = db.Column(db.Date, nullable=True)
    priority = db.Column(db.String(20), default=PRIORITY_MEDIUM)
    status = db.Column(db.String(20), default=STATUS_NOT_STARTED)
    assignee_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    creator_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # "due date approaching" email is only sent once per task so we
    # don't spam the assignee on every scheduler run.
    due_soon_notified = db.Column(db.Boolean, default=False)

    subtasks = db.relationship("Subtask", backref="task", lazy=True,
                                cascade="all, delete-orphan")
    comments = db.relationship("Comment", backref="task", lazy=True,
                                cascade="all, delete-orphan",
                                order_by="Comment.created_at")

    creator = db.relationship("User", foreign_keys=[creator_id])

    def is_overdue(self):
        return (
            self.due_date is not None
            and self.due_date < date.today()
            and self.status != STATUS_COMPLETE
        )

    def subtask_progress(self):
        total = len(self.subtasks)
        if total == 0:
            return None
        done = sum(1 for s in self.subtasks if s.is_complete)
        return done, total

    def due_urgency(self):
        """Which color tier this task's due date falls into, for the
        dashboard's color-coded due dates:
            - DUE_OVERDUE  (red)   : due date has passed, or is today
            - DUE_SOON     (blue)  : due in 1-3 days
            - DUE_UPCOMING (green) : due in 4-7 days
            - None (default/gray) : more than 7 days away, no due
              date set, or the task is already complete (a completed
              task's due date isn't "urgent" anymore).

        Computed against date.today() on the server so this can't
        drift out of sync with is_overdue() or disagree with the
        browser's local clock/timezone.
        """
        if self.due_date is None or self.status == STATUS_COMPLETE:
            return None
        days_left = (self.due_date - date.today()).days
        if days_left <= 0:
            return DUE_OVERDUE
        if days_left <= 3:
            return DUE_SOON
        if days_left <= 7:
            return DUE_UPCOMING
        return None


class Subtask(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    is_complete = db.Column(db.Boolean, default=False)


class Comment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    attachments = db.relationship("CommentAttachment", backref="comment", lazy=True,
                                   cascade="all, delete-orphan")


class CommentAttachment(db.Model):
    """A file (image / document / spreadsheet) attached to a comment,
    uploaded in the same form submission as the comment itself - so
    "who uploaded it" for permission checks is simply the comment's
    author (`comment.user_id`); there's no separate uploader concept
    since Asana's comment-attachment UX attaches files to a specific
    comment as it's written, not independently.

    `stored_path` is a randomized filename (see attachments.py's
    `_random_filename`) saved under Config.COMMENT_UPLOAD_FOLDER,
    deliberately unrelated to `filename` (the original, user-supplied
    name) so an attacker can't control the on-disk path/name and so
    two uploads of "invoice.pdf" never collide/overwrite each other.
    """
    __tablename__ = "comment_attachment"

    id = db.Column(db.Integer, primary_key=True)
    comment_id = db.Column(db.Integer, db.ForeignKey("comment.id"), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    stored_path = db.Column(db.String(255), nullable=False)
    file_type = db.Column(db.String(20), nullable=False)
    uploaded_at = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f"<CommentAttachment {self.filename} ({self.file_type})>"


class ProjectInvite(db.Model):
    """An admin-created, email-delivered invitation for someone
    (existing account or not) to join a project with a given role.

    `token` is the credential for the public /invites/<token> accept
    flow (see invites.py) - a 32-byte urlsafe random string, so it is
    not guessable/brute-forceable. A unique index on
    (project_id, email, status) approximates "at most one *pending*
    invite per email per project" at the DB layer as a backstop for
    the application-layer check in invites.py, which is the primary
    duplicate-invite guard (SQLite can't do a partial/filtered unique
    index the way Postgres can, so this composite index is a coarser
    safety net, not a strict guarantee against the same email having
    a new invite created after a prior one was accepted/expired -
    which is fine, since accepted/expired invites are allowed to
    coexist with a fresh pending one for the same address).
    """
    __tablename__ = "project_invite"
    __table_args__ = (
        db.Index("ix_invite_project_email_status", "project_id", "email", "status"),
    )

    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey("project.id"), nullable=False)
    email = db.Column(db.String(120), nullable=False, index=True)
    role = db.Column(db.String(20), nullable=False, default=ROLE_ANALYST)
    token = db.Column(db.String(64), nullable=False, unique=True, index=True)
    status = db.Column(db.String(20), nullable=False, default=INVITE_PENDING)
    invited_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    accepted_at = db.Column(db.DateTime, nullable=True)

    @staticmethod
    def generate_token():
        """32 bytes of CSPRNG randomness, urlsafe-encoded - used as
        the sole credential for accepting an invite without login."""
        return secrets.token_urlsafe(32)

    def is_expired(self):
        return datetime.utcnow() > self.expires_at

    def __repr__(self):
        return f"<ProjectInvite {self.email} -> project {self.project_id} ({self.status})>"


class Message(db.Model):
    """A single direct message between an Admin and an Analyst who
    share a project. Deliberately one row per message (no separate
    "conversation" table) - a conversation is just
    (project_id, min(sender_id, receiver_id), max(sender_id, receiver_id))
    which messaging.py queries directly; keeping it this simple avoids
    a second table to keep in sync for what is, per the spec, always
    exactly a 1-on-1 thread.

    `read_at` powers unread-message badges/counts in the Team/Messages
    UI without needing a separate read-receipts table.
    """
    __tablename__ = "message"

    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey("project.id"), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    read_at = db.Column(db.DateTime, nullable=True)

    def __repr__(self):
        return f"<Message {self.sender_id}->{self.receiver_id} on project {self.project_id}>"
