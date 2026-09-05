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
      current ? el('span', { class: 'site-header__crumb', text: current }) : null,
      el('span', { class: 'spacer' }),
      user
        ? el('div', { class: 'site-header__account' }, [
            user.university
              ? el('span', { class: 'badge', text: user.university.name })
              : null,
            user.role && user.role !== 'student'
              ? el('span', { class: 'badge badge--accent', text: user.role })
              : null,
            el('span', { class: 'account-name', text: user.name }),
            el('button', {
              class: 'button button--ghost button--small',
              type: 'button',
              text: 'Sign out',
              onClick: async () => {
                await api.signOut();
                window.location.href = '/';
              },
            }),
          ])
        : null,
    ]),
  );
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
