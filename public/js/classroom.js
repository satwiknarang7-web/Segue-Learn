import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  formatDate,
  renderHeader,
  requireSession,
  showError,
  toast,
} from './api.js';
import { renderAnnouncementsTab } from './tabs/announcements.js';
import { renderCalendarTab } from './tabs/calendar.js';
import { renderDiscussionsTab } from './tabs/discussions.js';
import { renderGradebookTab } from './tabs/gradebook.js';
import { renderQuizTab } from './tabs/quiz.js';

/**
 * The classroom shell.
 *
 * One page serves every tab; switching tabs swaps the panel and updates the
 * hash, so moving between Content and Gradebook never reloads the shell. Each
 * tab is a render function, which is where the feature modules will be plugged
 * in as they are built.
 */

const classroomId = window.location.pathname.split('/').filter(Boolean).pop();

const nodes = {
  heading: document.querySelector('#classroom-heading'),
  name: document.querySelector('#classroom-name'),
  meta: document.querySelector('#classroom-meta'),
  headingExtra: document.querySelector('#heading-extra'),
  tabs: document.querySelector('#tabs'),
  panel: document.querySelector('#panel'),
  pageError: document.querySelector('#page-error'),
};

let user = null;
let classroom = null;
let isStaff = false;

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

/** A placeholder that says what will live here, rather than pretending to work. */
const comingSoon = (icon, title, description) => () =>
  emptyState(icon, title, description);

/* ---- People -------------------------------------------------------------- */

async function renderPeople() {
  const members = await api.listMembers(classroomId);

  const rows = members.map((member) =>
    el('div', { class: 'roster__row' }, [
      el('span', { class: 'avatar', text: initials(member.name), 'aria-hidden': 'true' }),
      el('div', { class: 'stack stack--tight' }, [
        el('span', { class: 'roster__name', text: member.name }),
        // Students are not given each other's addresses.
        member.email ? el('span', { class: 'roster__email', text: member.email }) : null,
      ]),
      el('span', { class: 'spacer' }),
      el('span', {
        class: member.role === 'student' ? 'badge' : 'badge badge--accent',
        text: member.role,
      }),
      isStaff && member.role !== 'teacher'
        ? el('button', {
            class: 'button button--ghost button--small',
            type: 'button',
            text: 'Remove',
            onClick: async () => {
              if (!window.confirm(`Remove ${member.name} from this classroom?`)) return;
              try {
                await api.removeMember(classroomId, member.id);
                toast(`${member.name} removed`);
                await show(currentTab);
              } catch (error) {
                showError(nodes.pageError, error.message);
              }
            },
          })
        : null,
    ]),
  );

  return el('section', { class: 'card stack' }, [
    el('h2', { class: 'card__title', text: `${members.length} in this classroom` }),
    el('div', { class: 'roster' }, rows),
  ]);
}

/* ---- Settings (staff only) ----------------------------------------------- */

async function renderSettings() {
  const error = el('p', { class: 'notice notice--error', hidden: true });

  const codeText = el('span', { class: 'join-code', text: classroom.joinCode ?? '——' });

  return el('div', { class: 'stack' }, [
    error,

    el('section', { class: 'card stack' }, [
      el('h2', { class: 'card__title', text: 'Join code' }),
      el('p', { class: 'meta', text: 'Share this with students so they can enrol.' }),
      el('div', { class: 'row' }, [
        codeText,
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Copy',
          onClick: async () => {
            await navigator.clipboard.writeText(classroom.joinCode).catch(() => {});
            toast('Join code copied');
          },
        }),
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Generate a new code',
          onClick: async () => {
            if (
              !window.confirm(
                'Generate a new code? The old one stops working, but nobody already enrolled is removed.',
              )
            ) {
              return;
            }
            try {
              const { joinCode } = await api.rotateJoinCode(classroomId);
              classroom.joinCode = joinCode;
              codeText.textContent = joinCode;
              toast('New join code generated');
            } catch (failure) {
              showError(error, failure.message);
            }
          },
        }),
      ]),
    ]),

    el('section', { class: 'card stack' }, [
      el('h2', { class: 'card__title', text: 'Visibility' }),
      el('p', {
        class: 'meta',
        text:
          classroom.visibility === 'public'
            ? 'Anyone at your university can find and join this classroom.'
            : 'Only people with the join code can enrol.',
      }),
      el('button', {
        class: 'button button--ghost',
        type: 'button',
        text:
          classroom.visibility === 'public' ? 'Make it private' : 'Make it public',
        onClick: async () => {
          const next = classroom.visibility === 'public' ? 'private' : 'public';
          try {
            await api.updateClassroom(classroomId, { visibility: next });
            classroom.visibility = next;
            toast(`Classroom is now ${next}`);
            await show('settings');
          } catch (failure) {
            showError(error, failure.message);
          }
        },
      }),
    ]),

    el('section', { class: 'card stack' }, [
      el('h2', { class: 'card__title', text: classroom.archived ? 'Archived' : 'Archive' }),
      el('p', {
        class: 'meta',
        text: classroom.archived
          ? 'This classroom is read-only. Members can still see it.'
          : 'Members keep read-only access; nothing more can be changed or submitted.',
      }),
      el('button', {
        class: 'button button--ghost',
        type: 'button',
        text: classroom.archived ? 'Un-archive' : 'Archive this classroom',
        onClick: async () => {
          try {
            await api.setArchived(classroomId, !classroom.archived);
            classroom.archived = !classroom.archived;
            toast(classroom.archived ? 'Classroom archived' : 'Classroom un-archived');
            await boot();
          } catch (failure) {
            showError(error, failure.message);
          }
        },
      }),
    ]),
  ]);
}

/* ---- Tabs ---------------------------------------------------------------- */

const TABS = [
  {
    id: 'content',
    label: 'Content',
    render: comingSoon(
      'content',
      'Course content',
      'Lecture slides, readings and links, arranged in folders. This is the one tab that stores files rather than rows, so it is waiting on file storage.',
    ),
  },
  {
    id: 'calendar',
    label: 'Calendar',
    render: () => renderCalendarTab({ classroomId }),
  },
  {
    id: 'announcements',
    label: 'Announcements',
    render: () => renderAnnouncementsTab({ classroomId }),
  },
  {
    id: 'discussions',
    label: 'Discussions',
    render: () => renderDiscussionsTab({ classroomId }),
  },
  {
    id: 'quiz',
    label: 'Quiz',
    render: () => renderQuizTab({ classroomId, isStaff }),
  },
  {
    id: 'gradebook',
    label: 'Gradebook',
    render: () => renderGradebookTab({ classroomId, isStaff }),
  },
  {
    id: 'messages',
    label: 'Messages',
    render: comingSoon(
      'message',
      'Messages',
      'Direct conversations with people at your university, carrying on after the term ends.',
    ),
  },
  { id: 'people', label: 'People', render: renderPeople },
  { id: 'settings', label: 'Settings', render: renderSettings, staffOnly: true },
];

const visibleTabs = () => TABS.filter((tab) => !tab.staffOnly || isStaff);

let currentTab = 'content';

async function show(tabId) {
  const tab = visibleTabs().find((candidate) => candidate.id === tabId) ?? visibleTabs()[0];
  currentTab = tab.id;

  for (const button of nodes.tabs.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab.id));
  }

  if (window.location.hash !== `#${tab.id}`) {
    window.history.replaceState(null, '', `#${tab.id}`);
  }

  try {
    nodes.panel.replaceChildren(await tab.render());
  } catch (error) {
    nodes.panel.replaceChildren();
    showError(nodes.pageError, error.message);
  }
}

function renderTabs() {
  nodes.tabs.replaceChildren(
    ...visibleTabs().map((tab) =>
      el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        text: tab.label,
        dataset: { tab: tab.id },
        'aria-selected': 'false',
        onClick: () => show(tab.id),
      }),
    ),
  );
  nodes.tabs.hidden = false;
}

/* ---- Boot ---------------------------------------------------------------- */

async function boot() {
  user = await requireSession();
  if (!user) return;

  try {
    classroom = await api.getClassroom(classroomId);
  } catch (error) {
    renderHeader({ user });
    showError(
      nodes.pageError,
      error.status === 404
        ? 'That classroom does not exist, or you are not in it.'
        : error.message,
    );
    return;
  }

  isStaff = classroom.role === 'teacher' || classroom.role === 'ta' || user.role === 'admin';

  // Set on the root, so the banner, the tab underline, the calendar chips and
  // every empty state on the page are all in this course's colour.
  applyCourseTheme(document.documentElement, classroomId);

  renderHeader({ user, current: classroom.name });

  nodes.name.textContent = classroom.name;
  nodes.meta.textContent = [
    classroom.term,
    `${classroom.studentCount} student${classroom.studentCount === 1 ? '' : 's'}`,
    classroom.visibility === 'public' ? 'Public' : 'Private',
    classroom.archived ? 'Archived' : null,
    `Created ${formatDate(classroom.createdAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Staff get the code in the heading, because reading it out is the single
  // most common thing a teacher does on this screen.
  nodes.headingExtra.replaceChildren(
    isStaff && classroom.joinCode
      ? el('span', { class: 'join-code', text: classroom.joinCode })
      : el('span', { class: 'badge', text: classroom.role ?? 'Viewer' }),
  );

  nodes.heading.hidden = false;
  renderTabs();

  await show(window.location.hash.slice(1) || 'content');
}

window.addEventListener('hashchange', () => {
  const wanted = window.location.hash.slice(1);
  if (wanted && wanted !== currentTab) show(wanted);
});

boot();
