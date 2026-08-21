"""
attachments.py
---------------
File attachments on task comments (images, documents, spreadsheets) -
similar to Asana's comment attachments.

New DB object used: models.CommentAttachment.

Where uploads live:
    Files are saved under Config.COMMENT_UPLOAD_FOLDER, which
    defaults to <project_root>/uploads/comments - a sibling of
    static/, NOT inside it. This is deliberate: anything under
    static/ is served directly by Flask with no permission check at
    all, which would let anyone with a guessed/leaked URL download a
    private project's attachments. Instead, every download goes
    through serve_attachment() below, which re-checks the requesting
    user is actually a member of the attachment's project before
    returning any bytes.

Upload validation (all server-side, never trusts the client):
    - Extension whitelist (not blacklist) - ALLOWED_EXTENSIONS below.
      A blacklist ("reject .exe/.sh/...") is always incomplete; a
      whitelist ("only allow these known-safe types") fails closed.
    - Size cap (MAX_FILE_SIZE, 10MB) enforced by actually measuring
      the uploaded bytes, in addition to Flask's global
      MAX_CONTENT_LENGTH (config.py) which rejects oversized request
      bodies before they're even fully read into memory.
    - The filename actually written to disk is a random token
      (`_random_filename`), never derived from the user-supplied
      filename - this is what makes path traversal (`../../etc/passwd`)
      and overwrite attacks (two uploads both named "invoice.pdf")
      structurally impossible rather than something we're hoping a
      sanitizer regex catches. The original filename is kept only as
      display text (`CommentAttachment.filename`), and even that is
      escaped like any other user-supplied string when rendered.
"""

import os
import secrets

from flask import Blueprint, current_app, send_from_directory, abort, redirect, url_for, flash
from flask_login import login_required, current_user

from extensions import db
from models import Comment, CommentAttachment, Task

attachments_bp = Blueprint("attachments", __name__, template_folder="../templates")

IMAGE_EXTENSIONS = {"jpg", "jpeg", "png"}
DOCUMENT_EXTENSIONS = {"pdf", "docx"}
SPREADSHEET_EXTENSIONS = {"xlsx", "csv"}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | SPREADSHEET_EXTENSIONS

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB, matches the spec exactly

_MIME_BY_EXTENSION = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
}


class AttachmentError(ValueError):
    """Raised for any rejected upload; the message is safe to flash
    directly to the user (never includes raw file content)."""


def _extension_of(filename):
    if "." not in filename:
        return ""
    return filename.rsplit(".", 1)[1].lower()


def _category_for_extension(ext):
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in DOCUMENT_EXTENSIONS:
        return "document"
    if ext in SPREADSHEET_EXTENSIONS:
        return "spreadsheet"
    return "other"


def _random_filename(ext):
    # 32 hex chars of CSPRNG randomness - the on-disk name a comment's
    # attachment gets has nothing to do with what the uploader typed.
    return f"{secrets.token_hex(16)}.{ext}"


def upload_dir():
    path = current_app.config["COMMENT_UPLOAD_FOLDER"]
    os.makedirs(path, exist_ok=True)
    return path


def save_comment_attachment(file_storage, comment):
    """Validate and persist one uploaded file for `comment`.

    Raises AttachmentError (safe to flash verbatim) on any validation
    failure - extension not whitelisted, empty filename, or over the
    size cap. Returns the created (but not yet committed - caller
    commits alongside the Comment insert) CommentAttachment on
    success.
    """
    if not file_storage or not file_storage.filename:
        raise AttachmentError("No file selected.")

    original_name = file_storage.filename
    ext = _extension_of(original_name)
    if not ext or ext not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise AttachmentError(
            f"'.{ext or '?'}' files aren't allowed. Allowed types: {allowed}."
        )

    # Measure the real size by reading the stream, rather than trusting
    # a Content-Length header - this also naturally enforces the cap
    # even when Flask's MAX_CONTENT_LENGTH is left unset in some
    # deployment.
    file_storage.stream.seek(0, os.SEEK_END)
    size = file_storage.stream.tell()
    file_storage.stream.seek(0)
    if size == 0:
        raise AttachmentError("The selected file is empty.")
    if size > MAX_FILE_SIZE:
        raise AttachmentError(
            f"'{original_name}' is too large ({size // (1024*1024)}MB). "
            f"Max size is {MAX_FILE_SIZE // (1024*1024)}MB."
        )

    stored_name = _random_filename(ext)
    dest_path = os.path.join(upload_dir(), stored_name)
    file_storage.save(dest_path)

    attachment = CommentAttachment(
        comment=comment,
        filename=original_name[:255],
        stored_path=stored_name,
        file_type=_category_for_extension(ext),
    )
    db.session.add(attachment)
    return attachment


@db.event.listens_for(CommentAttachment, "after_delete")
def _delete_file_from_disk(mapper, connection, attachment):
    """Keep disk storage in sync with the DB automatically - this
    fires for explicit attachment deletes AND for cascade deletes
    (deleting a comment/task/project deletes its attachments too, per
    the cascade="all, delete-orphan" relationships in models.py), so
    we never accumulate orphaned files no matter which path removed
    the row.
    """
    try:
        path = os.path.join(current_app.config["COMMENT_UPLOAD_FOLDER"], attachment.stored_path)
        if os.path.exists(path):
            os.remove(path)
    except Exception as exc:
        # Never let disk cleanup failure roll back or crash the DB
        # transaction that already committed - just log it loudly so
        # an admin can clean up manually.
        current_app.logger.error(
            f"Failed to remove attachment file {attachment.stored_path}: {exc}"
        )


def _assert_can_view(attachment):
    project = attachment.comment.task.project
    if not current_user.is_admin and current_user not in project.members:
        abort(403)


def _assert_can_delete(attachment):
    if current_user.is_admin:
        return
    if attachment.comment.user_id != current_user.id:
        abort(403)


@attachments_bp.route("/attachments/<int:attachment_id>")
@login_required
def serve_attachment(attachment_id):
    """Download (or, for images, inline-preview) an attachment.
    Gated on project membership, not just "you're logged in" - this
    is what makes storing files outside static/ actually matter.
    """
    attachment = CommentAttachment.query.get_or_404(attachment_id)
    _assert_can_view(attachment)

    ext = _extension_of(attachment.stored_path)
    mimetype = _MIME_BY_EXTENSION.get(ext, "application/octet-stream")
    as_attachment = attachment.file_type != "image"

    return send_from_directory(
        upload_dir(),
        attachment.stored_path,
        mimetype=mimetype,
        as_attachment=as_attachment,
        download_name=attachment.filename,
    )


@attachments_bp.route("/attachments/<int:attachment_id>/delete", methods=["POST"])
@login_required
def delete_attachment(attachment_id):
    attachment = CommentAttachment.query.get_or_404(attachment_id)
    _assert_can_delete(attachment)

    task_id = attachment.comment.task_id
    try:
        db.session.delete(attachment)
        db.session.commit()
        flash("Attachment deleted.", "info")
    except Exception as exc:
        db.session.rollback()
        current_app.logger.error(f"Failed to delete attachment {attachment_id}: {exc}")
        flash("Couldn't delete that attachment. Please try again.", "error")

    return redirect(url_for("main.task_detail", task_id=task_id))
