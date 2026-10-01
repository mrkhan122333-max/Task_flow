// Projects — project cards with progress, plus admin CRUD modals.

import { api } from '../api.js';
import { store, emit } from '../store.js';
import {
  icon, spinner, emptyState, toast, openModal, confirmModal,
} from '../components.js';
import { esc, uid } from '../util.js';

const COLORS = ['#2563eb', '#7c3aed', '#10b981', '#d97706', '#dc2626', '#0891b2', '#ec4899', '#64748b'];

export async function renderProjects(main) {
  const isAdmin = store.user.role === 'admin';
  main.innerHTML = spinner();

  const [projectsData, taskData] = await Promise.all([
    api.get('/api/projects'),
    api.get('/api/tasks'),
  ]);
  const projects = projectsData.projects;
  const tasks = taskData.tasks;

  const countFor = (projectId) => {
    const ts = tasks.filter((t) => t.projectId === projectId);
    const done = ts.filter((t) => t.status === 'completed').length;
    return { total: ts.length, done };
  };

  main.innerHTML =
    '<div class="content-narrow">' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Projects</h1>' +
          '<div class="page-sub">' + esc(isAdmin
            ? 'Group work and control which employees can see it'
            : 'The projects you are a member of, plus your own assigned work') + '</div>' +
        '</div>' +
        (isAdmin
          ? '<div class="page-actions">' +
              '<button type="button" class="btn btn-primary btn-sm" id="new-project">' + icon('plus', 15) + ' New Project</button>' +
            '</div>'
          : '') +
      '</div>' +

      '<div class="section">' +
        (projects.length
          ? '<div class="grid-2">' + projects.map((p) => projectCardHTML(p, countFor(p.id))).join('') + '</div>'
          : emptyState('briefcase', 'No projects yet',
              isAdmin ? 'Create a project to start assigning work.' : 'Your admin can create projects for the team.')) +
      '</div>' +
    '</div>';

  // --- project card interactions ---
  main.querySelectorAll('[data-open-project]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-open-project');
      window.location.hash = '#/tasks?project=' + encodeURIComponent(id);
    });
  });

  function bindProjectCard(card, project) {
    card.querySelector('[data-edit-project]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      projectFormModal(project);
    });
    card.querySelector('[data-del-project]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmModal('Delete project "' + project.name + '"? Its tasks will still exist but become unassigned to any project.');
      if (!ok) return;
      try {
        await api.del('/api/projects/' + project.id);
        emitDataChanged();
        toast('Project deleted.');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  main.querySelectorAll('[data-project-id]').forEach((card) => {
    const p = projects.find((x) => x.id === card.getAttribute('data-project-id'));
    if (p) bindProjectCard(card, p);
  });

  const newProjectBtn = document.getElementById('new-project');
  if (newProjectBtn) newProjectBtn.addEventListener('click', () => projectFormModal(null));

  // ---------- helpers ----------
  function projectCardHTML(p, counts) {
    const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    const actions = isAdmin
      ? '<div class="attach-actions">' +
          '<button type="button" class="icon-btn" data-edit-project>' + icon('pen', 15) + '</button>' +
          '<button type="button" class="icon-btn" data-del-project style="color:var(--c-red)">' + icon('trash', 15) + '</button>' +
        '</div>'
      : '';
    return '<div class="card card-hover proj-card" data-project-id="' + esc(p.id) + '" data-open-project="' + esc(p.id) + '">' +
      '<span class="proj-stripe" style="background:' + esc(p.color) + '"></span>' +
      '<div class="flex-between" style="align-items:flex-start">' +
        '<h3>' + esc(p.name) + '</h3>' + actions +
      '</div>' +
      (p.description ? '<p class="proj-desc">' + esc(p.description) + '</p>' : '<p class="proj-desc muted">No description</p>') +
      (counts.total
        ? '<div class="inline-flex" style="width:100%;gap:10px;margin-bottom:12px">' +
            '<div class="sub-progress"><span style="width:' + pct + '%"></span></div>' +
            '<span class="muted" style="font-size:12px;white-space:nowrap">' + counts.done + '/' + counts.total + '</span>' +
          '</div>'
        : '') +
      '<div class="proj-foot">' +
        '<span class="badge badge-muted">' + counts.total + ' task' + (counts.total === 1 ? '' : 's') + '</span>' +
      '</div>' +
    '</div>';
  }

  // ---------- project form ----------
  function projectFormModal(project) {
    const formId = uid();
    const swatches = COLORS.map((c) =>
      '<button type="button" data-color="' + c + '" class="swatch' + ((project && project.color === c) ? ' active' : '') + '"' +
      ' style="background:' + c + '"></button>').join('');
    const employees = store.users.filter((u) => u.role === 'employee' && u.active !== false);
    const memberField = employees.length
      ? '<select class="input" name="memberIds" multiple size="' + Math.min(employees.length, 6) + '">' +
          employees.map((u) => '<option value="' + esc(u.id) + '"' +
            ((project && project.memberIds && project.memberIds.includes(u.id)) ? ' selected' : '') + '>' +
            esc(u.displayName || u.username) +
            (u.department ? ' — ' + esc(u.department) : '') + '</option>').join('') +
        '</select>'
      : '<p class="muted">No employees yet — add them via Manage Users.</p>';
    const body = document.createElement('div');
    body.innerHTML =
      '<form id="' + formId + '" novalidate>' +
        '<div class="field"><label>Project name *</label><input class="input" name="name" maxlength="100" value="' + esc(project ? project.name : '') + '"></div>' +
        '<div class="field"><label>Description</label><textarea class="input" name="description" maxlength="1000" rows="2">' + esc(project ? project.description : '') + '</textarea></div>' +
        '<div class="field"><label>Color</label><div class="chip-list" data-swatches>' + swatches + '</div></div>' +
        '<div class="field"><label>Employees</label>' + memberField +
          '<div class="hint">Members can open every task in this project. Employees who are not listed can still ' +
          'see tasks assigned directly to them. Admins always have access.</div></div>' +
      '</form>';
    body.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      sw.closest('[data-swatches]').querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
    });
    return openModal({
      title: project ? 'Edit project' : 'New project',
      body,
      okText: project ? 'Save changes' : 'Create project',
      onOk: async () => {
        const form = document.getElementById(formId);
        const data = new FormData(form);
        const name = String(data.get('name') || '').trim();
        if (!name) throw new Error('Project name is required.');
        const activeSwatch = form.querySelector('.swatch.active');
        const payload = {
          name,
          description: String(data.get('description') || '').trim(),
          color: (activeSwatch && activeSwatch.getAttribute('data-color')) || '#2563eb',
          memberIds: data.getAll('memberIds'),
        };
        if (project) await api.put('/api/projects/' + project.id, payload);
        else await api.post('/api/projects', payload);
        emitDataChanged();
        toast(project ? 'Project updated.' : 'Project created.');
      },
    });
  }
}

function emitDataChanged() {
  emit('data-changed', {});
}