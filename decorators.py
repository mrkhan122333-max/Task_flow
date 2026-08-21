"""
decorators.py
-------------
Server-side RBAC enforcement. This is the core of the permission
system - every route that mutates data must be wrapped with
@role_required(...) so that permissions cannot be bypassed by, e.g.,
calling the endpoint directly with curl/Postman instead of clicking a
(hidden) button in the UI.
"""

from functools import wraps
from flask import abort
from flask_login import current_user


def role_required(*allowed_roles):
    """Restrict a view to users whose .role is in allowed_roles.

    Usage:
        @role_required("admin")
        def delete_task(...): ...
    """
    def decorator(view_func):
        @wraps(view_func)
        def wrapped(*args, **kwargs):
            if not current_user.is_authenticated:
                abort(401)
            if current_user.role not in allowed_roles:
                abort(403)
            return view_func(*args, **kwargs)
        return wrapped
    return decorator


def login_required_json(view_func):
    """Same as flask_login.login_required but for API-style endpoints
    where we want a 401 rather than a redirect to the login page."""
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not current_user.is_authenticated:
            abort(401)
        return view_func(*args, **kwargs)
    return wrapped
