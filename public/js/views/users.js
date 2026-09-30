// Manage Users (admin) — create, edit, delete accounts + passwords.
// There is no public sign-up; users are provisioned here or via scripts/seed.js.

import { api } from '../api.js';
import { store, emit } from '../store.js';
import { icon, spinner, avatar, toast, openModal, confirmModal, emptyState } from '../components.js';
import { esc, uid, fmtDateTime } from '../util.js';

export async function renderUsers(main) {
  if (store.user.role !== 'admin') {
    main.innerHTML = emptyState('lock', 'Admins only', 'You need administrator access for this page.');
    return;
  }

  main.innerHTML = spinner();
  const data = await api.get('/api/users');
  const users = data.users;

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Manage Users</h1>' +
          '<div class="page-sub">' + users.length + ' account' + (users.length === 1 ? '' : 's') + ' · no public sign-up</div>' +
        '</div>' +
        '<div class="page-actions">' +
          '<button type="button" class="btn btn-primary btn-sm" id="add-user">' + icon('user', 15) + ' Add User</button>' +
        '</div>' +
      '</div>' +
      (users.length
        ? '<div class="card" style="padding:0;overflow:hidden"><table class="user-table">' +
            '<thead><tr><th>User</th><th>Role</th><th>Created</th><th></th></tr></thead>' +
            '<tbody>' + users.map((u) =>
              '<tr data-user-id="' + esc(u.id) + '">' +
                '<td><div class="user-main">' + avatar(u, 34) +
                  '<div><div style="font-weight:600">' + esc(u.displayName || u.username) + '</div>' +
                  '<div class="muted" style="font-size:12px">@' + esc(u.username) + '</div></div></div></td>' +
                '<td><span class="badge ' + (u.role === 'admin' ? 'badge-role-admin' : 'badge-role-analyst') + '" style="text-transform:capitalize">' + esc(u.role) + '</span></td>' +
                '<td class="muted">' + fmtDateTime(u.createdAt) + '</td>' +
                '<td style="text-align:right">' +
                  '<div class="attach-actions" style="justify-content:flex-end">' +
                    '<button type="button" class="icon-btn" data-edit-user>' + icon('pen', 15) + '</button>' +
                    (u.id === store.user.id ? '' :
                      '<button type="button" class="icon-btn" data-del-user style="color:var(--c-red)">' + icon('trash', 15) + '</button>') +
                  '</div></td>' +
              '</tr>').join('') +
            '</tbody></table></div>'
        : emptyState('users', 'No users yet', 'Run `npm run seed` to create the first admin, or add one below.')) +
    '</div>';

  // ---------- create / edit ----------
  function userModal(user) {
    const isEdit = !!user;
    const formId = uid();
    const body = document.createElement('div');
    body.innerHTML =
      '<form id="' + formId + '" novalidate>' +
        '<div class="input-row"><div class="field"><label>Username *</label>' +
          '<input class="input" name="username" maxlength="32" value="' + esc(user ? user.username : '') + '"' + (isEdit ? '' : ' autofocus') + '>' +
          '<div class="hint">3–32 chars: letters, numbers, . _ -</div></div>' +
          '<div class="field"><label>Display name</label>' +
          '<input class="input" name="displayName" maxlength="60" value="' + esc(user ? user.displayName : '') + '"></div></div>' +
        '<div class="field"><label>Role</label>' +
          '<div class="select-wrap"><select class="input" name="role">' +
            '<option value="analyst"' + (user && user.role === 'analyst' ? ' selected' : '') + '>Analyst</option>' +
            '<option value="admin"' + (user && user.role === 'admin' ? ' selected' : '') + '>Admin</option>' +
          '</select>' + icon('chevD', 14) + '</div></div>' +
        '<div class="field"><label>' + (isEdit ? 'New password' : 'Password *') + '</label>' +
          '<input class="input" type="password" name="password" autocomplete="new-password" placeholder="Min 8 characters">' +
          (isEdit ? '<div class="hint">Leave blank to keep the current password.</div>' : '') + '</div>' +
      '</form>';

    return openModal({
      title: isEdit ? 'Edit user' : 'Add user',
      body,
      okText: isEdit ? 'Save changes' : 'Create account',
      onOk: async () => {
        const form = document.getElementById(formId);
        const data = new FormData(form);
        const username = String(data.get('username') || '').trim();
        const displayName = String(data.get('displayName') || '').trim();
        const role = data.get('role');
        const password = String(data.get('password') || '');

        if (!isEdit && !password) throw new Error('Password is required (min 8 characters).');
        if (isEdit && password && password.length < 8) throw new Error('Password must be at least 8 characters.');

        const payload = { username, displayName, role };
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

  main.querySelectorAll('[data-del-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-user-id]').getAttribute('data-user-id');
      const user = users.find((u) => u.id === id);
      if (!user) return;
      const ok = await confirmModal('Delete user "' + (user.displayName || user.username) + '"? Their tasks become unassigned and they will no longer be able to sign in. Messages and comments are kept.');
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