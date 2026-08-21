"""replace task status set with not_started/ongoing/hold/complete

Data-only migration (no column type/shape change - `status` was
already a plain String(20)). Maps every existing task's status value
from the old 3-state set to the new 4-state set:

    todo        -> not_started
    in_progress -> ongoing
    complete    -> complete   (unchanged - kept as its own status
                                rather than folded into "ongoing", so
                                every existing call site that checks
                                STATUS_COMPLETE keeps working exactly
                                as before with zero code changes:
                                  - Task.is_overdue()
                                  - Project.progress_percent()
                                  - the due-date reminder scheduler
                                    (scheduler.py skips completed
                                    tasks)
                                  - analytics.py's completion-rate /
                                    per-user / timeline charts
                                  - main/routes.py's dashboard
                                    "completed" stat)

"hold" has no equivalent in the old set, so no existing row maps to
it - it's a genuinely new state going forward.

Reversible: downgrade() maps back (not_started -> todo, ongoing ->
in_progress, hold -> todo since "hold" didn't exist before, complete
-> complete), so a rollback doesn't leave any row with a value the
old code doesn't recognize.

Revision ID: f07cbea5228e
Revises: a3b78a406719
Create Date: 2026-08-19 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f07cbea5228e'
down_revision = 'a3b78a406719'
branch_labels = None
depends_on = None


# Bind to a lightweight ad-hoc table view of just the columns this
# migration touches, rather than importing the real Task model -
# migrations should stay decoupled from the current state of
# models.py so old migrations keep working even after the model
# changes again in the future.
task_table = sa.table('task', sa.column('status', sa.String))


def upgrade():
    op.execute(task_table.update().where(task_table.c.status == 'todo')
               .values(status='not_started'))
    op.execute(task_table.update().where(task_table.c.status == 'in_progress')
               .values(status='ongoing'))
    # 'complete' rows are left as-is on purpose (see module docstring).


def downgrade():
    op.execute(task_table.update().where(task_table.c.status == 'not_started')
               .values(status='todo'))
    op.execute(task_table.update().where(task_table.c.status == 'ongoing')
               .values(status='in_progress'))
    op.execute(task_table.update().where(task_table.c.status == 'hold')
               .values(status='todo'))
    # 'complete' rows are left as-is on purpose (see module docstring).
