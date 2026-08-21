from flask import Blueprint

auth_bp = Blueprint("auth", __name__, template_folder="../templates")

from auth import routes  # noqa: E402,F401  (import at bottom avoids circular import)
