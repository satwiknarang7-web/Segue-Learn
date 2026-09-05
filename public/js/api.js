/** Thin wrapper around fetch that turns API errors into thrown Errors. */
async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  me: () => request('GET', '/api/auth/me'),
  signOut: () => request('POST', '/api/auth/signout', {}),

  listClassrooms: () => request('GET', '/api/classrooms'),
  listPublicClassrooms: () => request('GET', '/api/classrooms/public'),
  createClassroom: (payload) => request('POST', '/api/classrooms', payload),
  joinClassroom: (code) => request('POST', '/api/classrooms/join', { code }),

  getClassroom: (id) => request('GET', `/api/classrooms/${id}`),
  updateClassroom: (id, payload) => request('PATCH', `/api/classrooms/${id}`, payload),
  listMembers: (id) => request('GET', `/api/classrooms/${id}/members`),
  removeMember: (id, memberId) => request('DELETE', `/api/classrooms/${id}/members/${memberId}`),
  rotateJoinCode: (id) => request('POST', `/api/classrooms/${id}/join-code`, {}),
  setArchived: (id, archived) => request('POST', `/api/classrooms/${id}/archive`, { archived }),

  /* ---- Quizzes ---- */

  listQuizzes: (classroomId) => request('GET', `/api/classrooms/${classroomId}/quizzes`),
  createQuiz: (classroomId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/quizzes`, payload),
  getQuiz: (classroomId, quizId) =>
    request('GET', `/api/classrooms/${classroomId}/quizzes/${quizId}`),
  updateQuiz: (classroomId, quizId, payload) =>
    request('PATCH', `/api/classrooms/${classroomId}/quizzes/${quizId}`, payload),
  deleteQuiz: (classroomId, quizId) =>
    request('DELETE', `/api/classrooms/${classroomId}/quizzes/${quizId}`),

  addQuestion: (classroomId, quizId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/quizzes/${quizId}/questions`, payload),
  updateQuestion: (classroomId, quizId, questionId, payload) =>
    request(
      'PUT',
      `/api/classrooms/${classroomId}/quizzes/${quizId}/questions/${questionId}`,
      payload,
    ),
  deleteQuestion: (classroomId, quizId, questionId) =>
    request(
      'DELETE',
      `/api/classrooms/${classroomId}/quizzes/${quizId}/questions/${questionId}`,
    ),
  moveQuestion: (classroomId, quizId, questionId, direction) =>
    request(
      'POST',
      `/api/classrooms/${classroomId}/quizzes/${quizId}/questions/${questionId}/move`,
      { direction },
    ),
  importQuestions: (classroomId, quizId, text, dryRun = false) =>
    request('POST', `/api/classrooms/${classroomId}/quizzes/${quizId}/questions/bulk`, {
      text,
      dryRun,
    }),

  startAttempt: (classroomId, quizId) =>
    request('POST', `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`, {}),
  myAttempts: (classroomId, quizId) =>
    request('GET', `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts/mine`),

  saveAnswer: (attemptId, questionId, answer) =>
    request('POST', `/api/attempts/${attemptId}/answers`, { questionId, answer }),
  submitAttempt: (attemptId, answers) =>
    request('POST', `/api/attempts/${attemptId}/submit`, { answers }),
  abandonAttempt: (attemptId) => request('POST', `/api/attempts/${attemptId}/abandon`, {}),

  quizResults: (classroomId, quizId) =>
    request('GET', `/api/classrooms/${classroomId}/quizzes/${quizId}/results`),
  clearQuizResults: (classroomId, quizId) =>
    request('DELETE', `/api/classrooms/${classroomId}/quizzes/${quizId}/results`),
  reviewAttempt: (classroomId, quizId, attemptId) =>
    request('GET', `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts/${attemptId}`),
  deleteAttempt: (classroomId, quizId, attemptId) =>
    request('DELETE', `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts/${attemptId}`),

  /* ---- Announcements ---- */

  listAnnouncements: (classroomId) =>
    request('GET', `/api/classrooms/${classroomId}/announcements`),
  createAnnouncement: (classroomId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/announcements`, payload),
  updateAnnouncement: (classroomId, id, payload) =>
    request('PATCH', `/api/classrooms/${classroomId}/announcements/${id}`, payload),
  deleteAnnouncement: (classroomId, id) =>
    request('DELETE', `/api/classrooms/${classroomId}/announcements/${id}`),

  /* ---- Calendar ---- */

  /** Everything across every classroom this person is in. Read-only. */
  myCalendar: (from, to) =>
    request(
      'GET',
      `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  calendar: (classroomId, from, to) =>
    request(
      'GET',
      `/api/classrooms/${classroomId}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  createCalendarEvent: (classroomId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/calendar/events`, payload),
  updateCalendarEvent: (classroomId, eventId, payload) =>
    request('PATCH', `/api/classrooms/${classroomId}/calendar/events/${eventId}`, payload),
  removeCalendarEvent: (classroomId, eventId) =>
    request('DELETE', `/api/classrooms/${classroomId}/calendar/events/${eventId}`),

  /* ---- Discussions ---- */

  listDiscussions: (classroomId) =>
    request('GET', `/api/classrooms/${classroomId}/discussions`),
  readDiscussion: (classroomId, threadId) =>
    request('GET', `/api/classrooms/${classroomId}/discussions/${threadId}`),
  createDiscussion: (classroomId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/discussions`, payload),
  updateDiscussion: (classroomId, threadId, payload) =>
    request('PATCH', `/api/classrooms/${classroomId}/discussions/${threadId}`, payload),
  removeDiscussion: (classroomId, threadId) =>
    request('DELETE', `/api/classrooms/${classroomId}/discussions/${threadId}`),
  replyToDiscussion: (classroomId, threadId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/discussions/${threadId}/posts`, payload),
  editDiscussionPost: (classroomId, threadId, postId, payload) =>
    request(
      'PATCH',
      `/api/classrooms/${classroomId}/discussions/${threadId}/posts/${postId}`,
      payload,
    ),
  removeDiscussionPost: (classroomId, threadId, postId) =>
    request('DELETE', `/api/classrooms/${classroomId}/discussions/${threadId}/posts/${postId}`),

  /* ---- Gradebook ---- */

  gradebook: (classroomId) => request('GET', `/api/classrooms/${classroomId}/gradebook`),
  availableQuizzes: (classroomId) =>
    request('GET', `/api/classrooms/${classroomId}/gradebook/available-quizzes`),
  addGradeColumn: (classroomId, payload) =>
    request('POST', `/api/classrooms/${classroomId}/gradebook/columns`, payload),
  updateGradeColumn: (classroomId, itemId, payload) =>
    request('PATCH', `/api/classrooms/${classroomId}/gradebook/columns/${itemId}`, payload),
  removeGradeColumn: (classroomId, itemId) =>
    request('DELETE', `/api/classrooms/${classroomId}/gradebook/columns/${itemId}`),
  setGrade: (classroomId, itemId, studentId, payload) =>
    request(
      'PUT',
      `/api/classrooms/${classroomId}/gradebook/columns/${itemId}/grades/${studentId}`,
      payload,
    ),
  clearGrade: (classroomId, itemId, studentId) =>
    request(
      'DELETE',
      `/api/classrooms/${classroomId}/gradebook/columns/${itemId}/grades/${studentId}`,
    ),
};

export function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return '--';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export function formatTimeLimit(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes && remainder) return `${minutes} min ${remainder} sec`;
  if (minutes) return `${minutes} min`;
  return `${remainder} sec`;
}

/* ---- Shared UI helpers ---- */

export function formatDateTime(isoString) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDate(isoString) {
  if (!isoString) return '--';
  return new Date(isoString).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Build an element tree without innerHTML, so user text can never inject markup. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Refusing to set raw HTML.');
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/* ---- Course identity ------------------------------------------------------
 *
 * Every classroom gets a colour of its own, derived from its id so it is the
 * same on every device and every visit without anything being stored.
 *
 * The hues are a curated list rather than `hash % 360`, because a third of the
 * colour wheel is mud at the lightness this palette uses, and a course that
 * came out olive would look like a bug rather than a choice.
 */

const COURSE_HUES = [217, 262, 291, 330, 356, 18, 40, 160, 187, 200];

export function courseHue(id) {
  let hash = 0;
  for (const character of String(id)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return COURSE_HUES[hash % COURSE_HUES.length];
}

/** Paints a subtree in a classroom's colour by setting the hue it derives from. */
export function applyCourseTheme(node, classroomId) {
  node.style.setProperty('--course-h', String(courseHue(classroomId)));
  return node;
}

/**
 * A simple inline glyph for an empty state.
 *
 * Drawn rather than imported: a handful of one-path shapes is not worth a font
 * or an icon dependency, and inline SVG inherits currentColor for free.
 */
const GLYPHS = {
  content: 'M4 5h7l2 2h7v12H4z',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  announcement: 'M4 10v4h4l6 4V6l-6 4z',
  discussion: 'M4 5h16v10H9l-5 4z',
  quiz: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  grades: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  message: 'M4 5h16v11H12l-4 4v-4H4z',
  people: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M17 20a6 6 0 0 0-2-4.3',
};

export function glyph(name, size = 28) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', GLYPHS[name] ?? GLYPHS.content);
  svg.append(path);
  return svg;
}

/** An empty state with a glyph, a line, and optionally something to do. */
export function emptyState(name, title, detail = '', action = null) {
  return el('div', { class: 'empty-state' }, [
    el('span', { class: 'empty-state__glyph' }, [glyph(name, 30)]),
    el('p', { class: 'empty-state__title', text: title }),
    detail ? el('p', { class: 'empty-state__detail', text: detail }) : null,
    action,
  ]);
}

/**
 * Plain text as paragraph elements: blank lines separate paragraphs, single
 * newlines stay as line breaks.
 *
 * Everything goes through el(), which sets textContent, so a post containing
 * markup is displayed as markup rather than becoming it. That is structural
 * rather than a matter of escaping correctly.
 */
export function renderParagraphs(text, className = '') {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => {
      const children = [];
      paragraph.split('\n').forEach((line, index) => {
        if (index > 0) children.push(el('br'));
        children.push(line);
      });
      return el('p', className ? { class: className } : {}, children);
    });
}

let toastTimer;
export function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('toast--visible'), 2600);
}

export function showError(node, message) {
  node.textContent = message;
  node.className = 'notice notice--error';
  node.hidden = false;
}

export function hideNotice(node) {
  node.hidden = true;
}

/** The shared header, so every signed-in page carries the same one. */
export function renderHeader({ user, current = null }) {
  const header = document.querySelector('#site-header');
  if (!header) return;

  header.replaceChildren(
    el('div', { class: 'site-header__inner' }, [
      el('a', { class: 'brand', href: '/home', 'aria-label': 'EduPlatform home' }, [
        el('img', {
          class: 'brand__logo brand__logo--light',
          src: '/img/segueit-logo.png',
          alt: 'SegueIT',
        }),
        el('img', {
          class: 'brand__logo brand__logo--dark',
          src: '/img/segueit-logo-dark.png',
          alt: '',
          'aria-hidden': 'true',
        }),
        el('span', { class: 'brand__divider', 'aria-hidden': 'true' }),
        el('span', { class: 'brand__product', text: 'Learn' }),
      ]),

      user ? navLinks(current) : null,
      el('span', { class: 'spacer' }),
      user ? accountMenu(user) : null,
    ]),
  );
}

/* ---- The top navigation --------------------------------------------------
 *
 * One bar on every signed-in page. It carries the two things that are true
 * wherever you are: a way back to your classrooms, and a way to jump straight
 * into another one without going home first.
 */

/** Tracks the open menu, so opening one closes the other. */
let openMenu = null;

function closeOpenMenu() {
  if (!openMenu) return;
  openMenu.panel.hidden = true;
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('click', (event) => {
  if (openMenu && !openMenu.root.contains(event.target)) closeOpenMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !openMenu) return;
  const { button } = openMenu;
  closeOpenMenu();
  // Focus goes back to what opened it, so keyboard users are not stranded.
  button.focus();
});

/**
 * A button and the panel it opens. `fill` is called the first time it is
 * opened, so a menu nobody touches costs no request.
 */
function menu(button, { fill } = {}) {
  const panel = el('div', { class: 'menu__panel', hidden: true });
  const root = el('div', { class: 'menu' }, [button, panel]);

  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');

  let filled = false;

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const isOpen = openMenu?.root === root;
    closeOpenMenu();
    if (isOpen) return;

    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openMenu = { root, panel, button };

    if (!filled && fill) {
      filled = true;
      panel.replaceChildren(el('p', { class: 'menu__note', text: 'Loading…' }));
      try {
        panel.replaceChildren(...(await fill()));
      } catch {
        filled = false;
        panel.replaceChildren(el('p', { class: 'menu__note', text: 'Could not load that.' }));
      }
    }
  });

  return root;
}

const ROLE_WORD = { teacher: 'Teacher', ta: 'TA', student: 'Student' };

function navLinks(current) {
  const path = window.location.pathname;

  const switcherButton = el('button', {
    class: 'nav__link nav__link--menu',
    type: 'button',
    // The current classroom is the most useful label the button can carry:
    // it says where you are as well as offering somewhere else to go.
    text: current ?? 'Switch course',
  });
  // On a phone the label is hidden -- the banner underneath already names the
  // course in large type -- so the button carries it for screen readers.
  switcherButton.setAttribute(
    'aria-label',
    current ? `Current course: ${current}. Switch course` : 'Switch course',
  );

  const switcher = menu(
    switcherButton,
    {
      async fill() {
        const classrooms = await api.listClassrooms();
        if (classrooms.length === 0) {
          return [el('p', { class: 'menu__note', text: 'You are not in any classrooms yet.' })];
        }

        return classrooms.map((classroom) =>
          applyCourseTheme(
            el(
              'a',
              {
                class: 'menu__item',
                href: `/classrooms/${classroom.id}`,
                'aria-current': classroom.name === current ? 'page' : null,
              },
              [
                el('span', { class: 'menu__dot', 'aria-hidden': 'true' }),
                el('span', { class: 'menu__item-text' }, [
                  el('span', { class: 'menu__item-name', text: classroom.name }),
                  classroom.role
                    ? el('span', {
                        class: 'menu__item-meta',
                        text: ROLE_WORD[classroom.role] ?? classroom.role,
                      })
                    : null,
                ]),
              ],
            ),
            classroom.id,
          ),
        );
      },
    },
  );

  return el('nav', { class: 'nav', 'aria-label': 'Main' }, [
    el('a', {
      // The one link the brand already duplicates, so it is the first to go
      // when the bar runs out of room.
      class: 'nav__link nav__link--home',
      href: '/home',
      text: 'My classrooms',
      'aria-current': path === '/home' ? 'page' : null,
    }),
    el('a', {
      class: 'nav__link',
      href: '/calendar',
      text: 'Calendar',
      'aria-current': path === '/calendar' ? 'page' : null,
    }),
    switcher,
  ]);
}

const initialsOf = (name) =>
  String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

function accountMenu(user) {
  const button = el('button', { class: 'account-button', type: 'button' }, [
    el('span', { class: 'avatar avatar--plain', text: initialsOf(user.name), 'aria-hidden': 'true' }),
    el('span', { class: 'account-name', text: user.name }),
  ]);
  button.setAttribute('aria-label', `Account: ${user.name}`);

  return menu(button, {
    fill: () => [
      el('div', { class: 'menu__header' }, [
        el('span', { class: 'menu__item-name', text: user.name }),
        user.university
          ? el('span', { class: 'menu__item-meta', text: user.university.name })
          : null,
        user.role
          ? el('span', {
              class: 'badge badge--accent menu__role',
              text: user.role === 'faculty' ? 'Teaching staff' : user.role,
            })
          : null,
      ]),
      el('button', {
        class: 'menu__item menu__item--button',
        type: 'button',
        text: 'Sign out',
        onClick: async () => {
          await api.signOut();
          window.location.href = '/';
        },
      }),
    ],
  });
}

/** Sends anyone without an active session to sign in, and returns the user. */
export async function requireSession() {
  const state = await api.me();
  if (!state.authenticated) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = state.stage === 'pending' ? '/signup?resume=1' : `/signin?next=${next}`;
    return null;
  }
  return state.user;
}
