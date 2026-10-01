// Manage Users (Admin only) — create and maintain Employee accounts.
//
// Every employee record carries a Name, Email address, Department, Designation
// and Role. Accounts can be deactivated (kept for history, immediately signed
// out and hidden from the employee pickers) and reactivated, and an Admin can
// reset anyone's password. There is no public sign-up: accounts are provisioned
// here or by scripts/seed.js.

import { api } from '../api.js';
import { store, emit } from '../store.js';
import { icon, spinner, avatar, toast, openModal, confirmModal, emptyState } from '../components.js';
import { esc, uid, fmtDateTime, roleLabel, ROLE_META } from '../util.js';

export async function renderUsers(main) {
  if (store.user.role !== 'admin') {
    main.innerHTML = emptyState('lock', 'Admins only', 'You need administrator access for this page.');
    return;
  }

  main.innerHTML = spinner();
  const [data, deptData] = await Promise.all([
    api.get('/api/users'),
    api.get('/api/users/departments').catch(() => ({ departments: [] })),
  ]);
  const users = data.users;
  const departments = deptData.departments || [];
  // Inactive accounts stay in the table (their history matters) but are sorted
  // to the bottom and shown greyed out.
  const ordered = users.slice().sort((a, b) => {
    const ai = a.active === false ? 1 : 0;
    const bi = b.active === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return String(a.displayName || a.username).localeCompare(String(b.displayName || b.username));
  });
  const active = users.filter((u) => u.active !== false).length;

  const roleBadge = (u) =>
    '<span class="badge" style="background:' + ROLE_META[u.role].bg + ';color:' + ROLE_META[u.role].color + '">' +
      esc(roleLabel(u.role)) + '</span>';

  const statusBadge = (u) => (u.active === false
    ? '<span class="badge badge-muted">Deactivated</span>'
    : '<span class="badge badge-green">Active</span>');

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Manage Users</h1>' +
          '<div class="page-sub">' + active + ' active · ' + (users.length - active) + ' deactivated · ' +
            users.filter((u) => u.role === 'admin').length + ' admins · ' +
            users.filter((u) => u.role === 'employee').length + ' employees · no public sign-up</div>' +
        '</div>' +
        '<div class="page-actions">' +
          '<button type="button" class="btn btn-primary btn-sm" id="add-user">' + icon('user', 15) + ' Add User</button>' +
        '</div>' +
      '</div>' +
      (users.length
        ? '<div class="card" style="padding:0;overflow:hidden"><table class="user-table">' +
            '<thead><tr>' +
              '<th>Name</th><th>Username</th><th>Email</th><th>Department</th><th>Designation</th>' +
              '<th>Role</th><th>Status</th><th>Created</th><th></th>' +
            '</tr></thead>' +
            '<tbody>' + ordered.map((u) =>
              '<tr data-user-id="' + esc(u.id) + '"' + (u.active === false ? ' class="row-inactive"' : '') + '>' +
                '<td><div class="user-main">' + avatar(u, 34) +
                  '<div><div style="font-weight:600">' + esc(u.displayName || u.username) + '</div>' +
                  (u.lastLoginAt
                    ? '<div class="muted" style="font-size:12px">Last seen ' + esc(fmtDateTime(u.lastLoginAt)) + '</div>'
                    : '<div class="muted" style="font-size:12px">Never signed in</div>') +
                  '</div></div></td>' +
                '<td class="muted">@' + esc(u.username) + '</td>' +
                '<td>' + (u.email
                  ? '<a href="mailto:' + esc(u.email) + '" style="color:var(--c-primary)">' + esc(u.email) + '</a>'
                  : '<span class="muted">—</span>') + '</td>' +
                '<td>' + (u.department ? esc(u.department) : '<span class="muted">—</span>') + '</td>' +
                '<td>' + (u.designation ? esc(u.designation) : '<span class="muted">—</span>') + '</td>' +
                '<td>' + roleBadge(u) + '</td>' +
                '<td>' + statusBadge(u) + '</td>' +
                '<td class="muted">' + esc(fmtDateTime(u.createdAt)) + '</td>' +
                '<td style="text-align:right;white-space:nowrap">' +
                  '<div class="attach-actions" style="justify-content:flex-end">' +
                    '<button type="button" class="icon-btn" data-edit-user title="Edit">' + icon('pen', 15) + '</button>' +
                    '<button type="button" class="icon-btn" data-reset-user title="Reset password">' + icon('lock', 15) + '</button>' +
                    (u.id === store.user.id ? '' :
                      '<button type="button" class="icon-btn" data-toggle-active title="' +
                        (u.active === false ? 'Reactivate' : 'Deactivate') + '">' +
                        icon(u.active === false ? 'check' : 'x', 15) + '</button>') +
                    (u.id === store.user.id ? '' :
                      '<button type="button" class="icon-btn" data-del-user style="color:var(--c-red)" title="Delete">' + icon('trash', 15) + '</button>') +
                  '</div></td>' +
              '</tr>').join('') +
            '</tbody></table></div>' +
          '<p class="hint" style="margin-top:10px">' +
            'Deactivating an account signs the employee out immediately and removes them from assignee lists, ' +
            'while keeping every task, comment and attachment they created. Their history is preserved and ' +
            'the account can be reactivated at any time.' +
          '</p>'
        : emptyState('users', 'No users yet', 'Run `npm run seed` to create the first admin, or add one below.')) +
    '</div>';

  // ---------- create / edit ----------
  function datalist() {
    return departments.length
      ? '<datalist id="dept-options">' + departments.map((d) => '<option value="' + esc(d) + '"></option>').join('') + '</datalist>'
      : '';
  }

  function userModal(user) {
    const isEdit = !!user;
    const formId = uid();
    const body = document.createElement('div');
    body.innerHTML =
      '<form id="' + formId + '" novalidate>' +
        '<div class="input-row">' +
          '<div class="field"><label>Name *</label>' +
            '<input class="input" name="displayName" maxlength="80" placeholder="Full name" value="' +
              esc(user ? (user.displayName || '') : '') + '"' + (isEdit ? '' : ' autofocus') + '></div>' +
          '<div class="field"><label>Username *</label>' +
            '<input class="input" name="username" maxlength="32" value="' + esc(user ? user.username : '') + '"' +
              (isEdit ? ' readonly' : '') + '>' +
            (isEdit ? '<div class="hint">The username cannot be changed.</div>'
                    : '<div class="hint">3–32 chars: letters, numbers, . _ -</div>') + '</div>' +
        '</div>' +
        '<div class="field"><label>Email address</label>' +
          '<input class="input" type="email" name="email" maxlength="120" placeholder="name@cosmicinfosolutions.com" value="' +
            esc(user ? (user.email || '') : '') + '">' +
          '<div class="hint">Used for password-reset notifications.</div></div>' +
        '<div class="input-row">' +
          '<div class="field"><label>Department</label>' +
            '<input class="input" name="department" maxlength="60" list="dept-options" value="' +
              esc(user ? (user.department || '') : '') + '">' + datalist() + '</div>' +
          '<div class="field"><label>Designation</label>' +
            '<input class="input" name="designation" maxlength="60" placeholder="e.g. Software Engineer" value="' +
              esc(user ? (user.designation || '') : '') + '"></div>' +
        '</div>' +
        '<div class="input-row">' +
          '<div class="field"><label>Role *</label>' +
            '<div class="select-wrap"><select class="input" name="role">' +
              '<option value="employee"' + (!user || user.role === 'employee' ? ' selected' : '') + '>Employee</option>' +
              '<option value="admin"' + (user && user.role === 'admin' ? ' selected' : '') + '>Admin</option>' +
            '</select>' + icon('chevD', 14) + '</div>' +
            '<div class="hint">Admins manage every task, user and project.</div></div>' +
          '<div class="field"><label>' + (isEdit ? 'New password' : 'Password *') + '</label>' +
            '<input class="input" type="password" name="password" autocomplete="new-password" placeholder="Min 8 characters">' +
            (isEdit ? '<div class="hint">Leave blank to keep the current password.</div>' : '') + '</div>' +
        '</div>' +
      '</form>';

    return openModal({
      title: isEdit ? 'Edit ' + (user.displayName || user.username) : 'Add user',
      body,
      wide: true,
      okText: isEdit ? 'Save changes' : 'Create account',
      onOk: async () => {
        const form = document.getElementById(formId);
        const form2 = new FormData(form);
        const displayName = String(form2.get('displayName') || '').trim();
        const username = String(form2.get('username') || '').trim();
        const email = String(form2.get('email') || '').trim();
        const department = String(form2.get('department') || '').trim();
        const designation = String(form2.get('designation') || '').trim();
        const role = form2.get('role');
        const password = String(form2.get('password') || '');

        if (!displayName) throw new Error('Name is required.');
        if (!isEdit && !password) throw new Error('Password is required (min 8 characters).');
        if (password && password.length < 8) throw new Error('Password must be at least 8 characters.');

        const payload = { displayName, username, email, department, designation, role };
        if (password) payload.password = password;

        if (isEdit) await api.put('/api/users/' + user.id, payload);
        else await api.post('/api/users', payload);
        emit('data-changed', {});
        toast(isEdit ? 'User updated.' : 'Account created.');
      },
    });
  }

  document.getElementById('add-user').addEventListener('click', () => userModal(null));

  main.querySelectorAll('[data-edit-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('[data-user-id]').getAttribute('data-user-id');
      userModal(users.find((u) => u.id === id));
    });
  });

  // ---------- deactivate / reactivate ----------
  main.querySelectorAll('[data-toggle-active]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-user-id]').getAttribute('data-user-id');
      const user = users.find((u) => u.id === id);
      if (!user) return;
      const deactivating = user.active !== false;
      const name = user.displayName || user.username;
      const ok = await confirmModal(
        deactivating
          ? 'Deactivate ' + name + '? They will be signed out immediately, will not be able to sign in again, and will be hidden from assignee lists. Their tasks, comments and files are kept.'
          : 'Reactivate ' + name + '? They will be able to sign in again and can be assigned new work.',
        deactivating ? 'Deactivate' : 'Reactivate',
      );
      if (!ok) return;
      try {
        const res = await api.post('/api/users/' + id + '/active', { active: !deactivating });
        emit('data-changed', {});
        toast(res.message || (deactivating ? 'Account deactivated.' : 'Account reactivated.'));
      } catch (err) {
        toast(err.message || 'Could not change the account status.', 'error');
      }
    });
  });

  // ---------- password reset ----------
  main.querySelectorAll('[data-reset-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-user-id]').getAttribute('data-user-id');
      const user = users.find((u) => u.id === id);
      if (!user) return;
      const name = user.displayName || user.username;
      const isSelf = user.id === store.user.id;
      const ok = await confirmModal(
        isSelf
          ? 'Reset your own password? Your new password takes effect immediately and every other signed-in session is signed out.'
          : 'Generate a new password for ' + name + '? Every active session for that account will be signed out immediately.',
        'Reset password',
      );
      if (!ok) return;
      try {
        const res = await api.post('/api/users/' + id + '/reset-password', {});
        showTempPassword(res, name, isSelf);
        emit('data-changed', {});
      } catch (err) {
        toast(err.message || 'Could not reset the password.', 'error');
      }
    });
  });

  // ---------- delete ----------
  main.querySelectorAll('[data-del-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-user-id]').getAttribute('data-user-id');
      const user = users.find((u) => u.id === id);
      if (!user) return;
      const ok = await confirmModal(
        'Permanently delete ' + (user.displayName || user.username) +
        '? Their tasks become unassigned, their comments and attachments are removed and their message ' +
        'history is kept. Deactivating the account instead keeps the full audit trail.',
        'Delete permanently',
      );
      if (!ok) return;
      try {
        await api.del('/api/users/' + id);
        emit('data-changed', {});
        toast('User deleted.');
      } catch (err) {
        toast(err.message || 'Could not delete user.', 'error');
      }
    });
  });
}

// Shows the generated password exactly once — the server never stores or can
// re-display it (only a salted hash is kept).
function showTempPassword(res, name, isSelf) {
  const password = res.temporaryPassword || '';
  // The server keeps the caller's own session alive across a self-reset, so
  // there is nothing to sign out of here.
  const staySignedIn = isSelf && res.self === true;
  openModal({
    title: 'Password reset',
    hideOk: false,
    okText: isSelf ? 'Close' : 'Done',
    body:
      '<p class="muted" style="margin:0 0 12px">' +
        (isSelf
          ? 'Your password has been changed. Any other signed-in session has been signed out.'
          : 'Share this with ' + esc(name) + ' securely. It will not be shown again.') +
      '</p>' +
      (password
        ? '<div class="field"><label>Temporary password</label>' +
            '<input class="input" id="temp-pw" readonly value="' + esc(password) + '" ' +
            'style="font-family:var(--mono);font-size:16px;letter-spacing:1px"></div>'
        : '<p class="hint">The password was delivered by e-mail and is not displayed here.</p>') +
      '<p class="hint">' + icon(res.emailed ? 'check' : 'alert', 13) + ' ' + esc(res.emailNotice || '') + '</p>' +
      (password && !res.emailed
        ? '<p class="hint">Copy it now — it cannot be retrieved later.</p>'
        : ''),
    onOk: async () => {
      if (isSelf && !staySignedIn) {
        try { await api.post('/api/auth/logout'); } catch (err) { /* already gone */ }
        emit('logged-out');
      }
      return true;
    },
  });
}
