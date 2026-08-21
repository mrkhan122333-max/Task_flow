"""
extensions.py
-------------
Instantiate Flask extensions here (not in app.py) so that models.py,
routes, and app.py can all import the same instances without causing
circular-import errors.
"""

from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_mail import Mail
from flask_migrate import Migrate

db = SQLAlchemy()
login_manager = LoginManager()
mail = Mail()
migrate = Migrate()

login_manager.login_view = "auth.login"
login_manager.login_message_category = "info"
