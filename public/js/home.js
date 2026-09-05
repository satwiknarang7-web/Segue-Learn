import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  hideNotice,
  renderHeader,
  requireSession,
  showError,
  toast,
} from './api.js';

const nodes = {
  classrooms: document.querySelector('#classrooms'),
  publicSection: document.querySelector('#public-section'),
  publicList: document.querySelector('#public-classrooms'),
  pageError: document.querySelector('#page-error'),
  joinPanel: document.querySelector('#join-panel'),
  createPanel: document.querySelector('#create-panel'),
  createOpen: document.querySelector('#create-open'),
};

let user = null;

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

const ROLE_LABEL = { teacher: 'Teacher', ta: 'TA', student: 'Student' };

function classroomCard(classroom) {
  const staff = classroom.role === 'teacher' || classroom.role === 'ta';

  const card = el(
    'a',
    {
      class: 'classroom-card',
      href: `/classrooms/${classroom.id}`,
      dataset: { archived: String(classroom.archived) },
    },
    [
      el('div', { class: 'classroom-card__body' }, [
        el('div', { class: 'classroom-card__top' }, [
          el('h3', { class: 'classroom-card__name', text: classroom.name }),
          classroom.role
            ? el('span', {
                class: staff ? 'badge badge--accent' : 'badge',
                text: ROLE_LABEL[classroom.role] ?? classroom.role,
              })
            : null,
        ]),
        classroom.description
          ? el('p', { class: 'classroom-card__description', text: classroom.description })
          : null,
        el('div', { class: 'classroom-card__foot' }, [
          classroom.term ? el('span', { text: classroom.term }) : null,
          classroom.archived ? el('span', { class: 'badge', text: 'Archived' }) : null,
          // Only staff are given the code, so only staff can show it.
          staff && classroom.joinCode
            ? el('span', { class: 'code-chip', text: classroom.joinCode })
            : null,
        ]),
      ]),
    ],
  );

  // The card's band takes the course's own colour, which is what makes a wall
  // of them scannable before any title has been read.
  return applyCourseTheme(card, classroom.id);
}

function renderList(target, classrooms, empty) {
  if (classrooms.length === 0) {
    target.replaceChildren(empty);
    return;
  }
  target.replaceChildren(
    el('div', { class: 'classroom-grid' }, classrooms.map(classroomCard)),
  );
}

async function refresh() {
  try {
    const mine = await api.listClassrooms();
    renderList(
      nodes.classrooms,
      mine,
      user.role === 'student'
        ? emptyState(
            'people',
            'No classrooms yet',
            'Your teacher will give you a join code. Enter it above and the course appears here.',
          )
        : emptyState(
            'content',
            'No classrooms yet',
            'Create your first classroom, and share its code with your students.',
          ),
    );

    // Public classrooms are only worth showing when there are some the person
    // is not already in.
    const joined = new Set(mine.map((room) => room.id));
    const open = (await api.listPublicClassrooms()).filter((room) => !joined.has(room.id));

    nodes.publicSection.hidden = open.length === 0;
    if (open.length > 0) renderList(nodes.publicList, open, null);
  } catch (error) {
    showError(nodes.pageError, error.message);
  }
}

/* ---- Join ---------------------------------------------------------------- */

const joinError = document.querySelector('#join-error');

document.querySelector('#join-open').addEventListener('click', () => {
  nodes.joinPanel.hidden = false;
  nodes.createPanel.hidden = true;
  document.querySelector('#join-code').focus();
});

document.querySelector('#join-cancel').addEventListener('click', () => {
  nodes.joinPanel.hidden = true;
  hideNotice(joinError);
});

document.querySelector('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice(joinError);

  const button = document.querySelector('#join-submit');
  const input = document.querySelector('#join-code');
  button.disabled = true;

  try {
    const result = await api.joinClassroom(input.value.trim());
    toast(result.alreadyMember ? `Already in ${result.name}` : `Joined ${result.name}`);
    input.value = '';
    nodes.joinPanel.hidden = true;
    await refresh();
  } catch (error) {
    showError(joinError, error.message);
    input.select();
  } finally {
    button.disabled = false;
  }
});

/* ---- Create (staff only) ------------------------------------------------- */

const createError = document.querySelector('#create-error');

nodes.createOpen.addEventListener('click', () => {
  nodes.createPanel.hidden = false;
  nodes.joinPanel.hidden = true;
  document.querySelector('#create-name').focus();
});

document.querySelector('#create-cancel').addEventListener('click', () => {
  nodes.createPanel.hidden = true;
  hideNotice(createError);
});

document.querySelector('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice(createError);

  const button = document.querySelector('#create-submit');
  button.disabled = true;

  try {
    const created = await api.createClassroom({
      name: document.querySelector('#create-name').value,
      description: document.querySelector('#create-description').value,
      term: document.querySelector('#create-term').value || undefined,
      visibility: document.querySelector('#create-visibility').value,
    });
    window.location.href = `/classrooms/${created.id}`;
  } catch (error) {
    showError(createError, error.message);
    button.disabled = false;
  }
});

/* ---- Boot ---------------------------------------------------------------- */

async function boot() {
  user = await requireSession();
  if (!user) return;

  renderHeader({ user });

  // Only staff can create a classroom, so only they are offered the button.
  nodes.createOpen.hidden = user.role !== 'faculty' && user.role !== 'admin';

  // Someone who signed in with a recovery code should know how many are left.
  const remaining = window.sessionStorage.getItem('eduplatform:recovery-notice');
  if (remaining !== null) {
    window.sessionStorage.removeItem('eduplatform:recovery-notice');
    toast(`Recovery code used — ${remaining} left`);
  }

  await refresh();
}

boot();
