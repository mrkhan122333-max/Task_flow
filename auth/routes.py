"""
auth/routes.py
---------------
Signup / login / logout. New users default to the "analyst" role;
promoting someone to "admin" is done from the Admin > Manage Users
screen by an existing admin (see main/routes.py: manage_users).

ASSUMPTION: the very first user ever created is auto-promoted to
admin so there's always at least one admin able to manage the app
(otherwise a fresh install would have no way to create an admin).
"""

from flask import render_template, redirect, url_for, flash, request
from flask_login import login_user, logout_user, login_required, current_user

from auth import auth_bp
from extensions import db
from models import User, ROLE_ADMIN, ROLE_ANALYST


@auth_bp.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        if not name or not email or not password:
            flash("All fields are required.", "error")
            return render_template("auth/signup.html")

        if password != confirm:
            flash("Passwords do not match.", "error")
            return render_template("auth/signup.html")

        if len(password) < 6:
            flash("Password must be at least 6 characters.", "error")
            return render_template("auth/signup.html")

        if User.query.filter_by(email=email).first():
            flash("An account with that email already exists.", "error")
            return render_template("auth/signup.html")

        is_first_user = User.query.count() == 0
        user = User(
            name=name,
            email=email,
            role=ROLE_ADMIN if is_first_user else ROLE_ANALYST,
        )
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        login_user(user)
        flash(
            "Welcome! You're the first user, so you've been made an admin."
            if is_first_user else "Account created successfully.",
            "success",
        )
        return redirect(url_for("main.dashboard"))

    return render_template("auth/signup.html")


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = User.query.filter_by(email=email).first()

        if user is None or not user.check_password(password):
            flash("Invalid email or password.", "error")
            return render_template("auth/login.html")

        login_user(user)
        next_page = request.args.get("next")
        return redirect(next_page or url_for("main.dashboard"))

    return render_template("auth/login.html")


@auth_bp.route("/logout")
@login_required
def logout():
    logout_user()
    flash("You have been logged out.", "info")
    return redirect(url_for("auth.login"))
