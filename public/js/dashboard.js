import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  formatDateTime,
  formatTimeLimit,
  renderHeader,
  requireSession,
  showError,
} from './api.js';

/**
 * The dashboard.
 *
 * One page that shows a teaching half to anyone who teaches and a studying
 * half to anyone who studies. Somebody who does both -- a graduate student
 * running one seminar and sitting another -- sees both, which is the whole
 * reason role lives on the enrolment rather than on the account.
 *
 * Everything is a link to the place the work is actually done. A dashboard
 * that tells you about a problem without taking you to it is a to-do list you
 * have to retype.
 */

const nodes = {
  root: document.querySelector('#dashboard'),
  greeting: document.querySelector('#greeting'),
  subtitle: document.querySelector('#subtitle'),
  pageError: document.querySelector('#page-error'),
};

const section = (title, body, action = null) =>
  el('section', { class: 'stack' }, [
    el('div', { class: 'row row--tight' }, [
      el('h2', { class: 'card__title', text: title }),
      el('span', { class: 'spacer' }),
      action,
    ]),
    body,
  ]);

const courseDot = (classroomId) =>
  applyCourseTheme(el('span', { class: 'menu__dot', 'aria-hidden': 'true' }), classroomId);

/** How near a deadline is, in words. Dates alone make you do the arithmetic. */
function relativeDay(iso) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86400000);

  if (days < 0) return 'Overdue';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  return formatDateTime(iso).split(',')[0];
}

/* ---- Teaching ------------------------------------------------------------ */

/** A count that is a link to the screen where you deal with it. */
function todoChip(classroomId, tab, count, singular, plural) {
  if (count === 0) return null;
  return el('a', {
    class: 'todo-chip',
    href: `/classrooms/${classroomId}#${tab}`,
    text: `${count} ${count === 1 ? singular : plural}`,
  });
}

function teachingCard(course) {
  const todos = [
    todoChip(course.id, 'gradebook', course.ungradedCells, 'mark to enter', 'marks to enter'),
    todoChip(
      course.id,
      'discussions',
      course.unansweredThreads,
      'question unanswered',
      'questions unanswered',
    ),
    todoChip(course.id, 'quiz', course.draftQuizzes, 'draft quiz', 'draft quizzes'),
    todoChip(
      course.id,
      'announcements',
      course.draftAnnouncements,
      'draft notice',
      'draft notices',
    ),
  ].filter(Boolean);

  return applyCourseTheme(
    el('div', { class: 'dash-card' }, [
      el('a', { class: 'dash-card__head', href: `/classrooms/${course.id}` }, [
        courseDot(course.id),
        el('span', { class: 'dash-card__name', text: course.name }),
      ]),
      el('p', {
        class: 'meta',
        text: [
          `${course.studentCount} student${course.studentCount === 1 ? '' : 's'}`,
          course.term,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      todos.length > 0
        ? el('div', { class: 'row row--tight' }, todos)
        : el('p', { class: 'meta dash-card__clear', text: 'Nothing waiting on you.' }),
    ]),
    course.id,
  );
}

/* ---- Studying ------------------------------------------------------------ */

function studyingCard(course) {
  return applyCourseTheme(
    el('div', { class: 'dash-card' }, [
      el('a', { class: 'dash-card__head', href: `/classrooms/${course.id}` }, [
        courseDot(course.id),
        el('span', { class: 'dash-card__name', text: course.name }),
      ]),
      el('p', {
        class: 'meta',
        text: [
          course.quizzesTaken === 0
            ? 'No quizzes taken yet'
            : `${course.quizzesTaken} quiz${course.quizzesTaken === 1 ? '' : 'zes'} taken`,
          course.term,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      el('div', { class: 'row row--tight' }, [
        course.quizScore === null
          ? null
          : el('span', { class: 'badge badge--accent', text: `${course.quizScore}% on quizzes` }),
        el('a', {
          class: 'todo-chip',
          href: `/classrooms/${course.id}#gradebook`,
          text: 'Your grades',
        }),
      ]),
    ]),
    course.id,
  );
}

/* ---- Shared lists -------------------------------------------------------- */

function entryRow(item, { href, title, meta, badge, badgeClass = 'badge' }) {
  return el('a', { class: 'list-row cal-entry', href }, [
    courseDot(item.classroomId),
    el('div', { class: 'stack stack--tight list-row__main' }, [
      el('strong', { text: title }),
      el('span', { class: 'meta', text: meta }),
    ]),
    el('span', { class: 'spacer' }),
    badge ? el('span', { class: badgeClass, text: badge }) : null,
  ]);
}

/* ---- The page ------------------------------------------------------------ */

function render(data) {
  const sections = [];

  if (data.teaches) {
    const waiting = data.teaching.reduce((sum, course) => sum + course.outstanding, 0);

    sections.push(
      section(
        'Teaching',
        el('div', { class: 'dash-grid' }, data.teaching.map(teachingCard)),
        el('span', {
          class: waiting > 0 ? 'badge badge--draft' : 'badge badge--live',
          text: waiting > 0 ? `${waiting} waiting on you` : 'All clear',
        }),
      ),
    );

    if (data.submissions.length > 0) {
      sections.push(
        section(
          'Recent submissions',
          el(
            'section',
            { class: 'card card--flush' },
            data.submissions.map((submission) =>
              entryRow(submission, {
                href: `/classrooms/${submission.classroomId}/quizzes/${submission.quizId}/results`,
                title: `${submission.studentName} — ${submission.quizTitle}`,
                meta: `${submission.classroomName} · ${formatDateTime(submission.submittedAt)}`,
                badge: `${submission.score}/${submission.maxScore}`,
                badgeClass: 'badge badge--accent',
              }),
            ),
          ),
        ),
      );
    }
  }

  if (data.studies) {
    sections.push(
      section('Studying', el('div', { class: 'dash-grid' }, data.studying.map(studyingCard))),
    );

    sections.push(
      section(
        'To do',
        data.openQuizzes.length === 0
          ? emptyState('quiz', 'Nothing to sit', 'Every quiz set for you is done.')
          : el(
              'section',
              { class: 'card card--flush' },
              data.openQuizzes.map((quiz) =>
                entryRow(quiz, {
                  href: `/classrooms/${quiz.classroomId}/quizzes/${quiz.id}/take`,
                  title: quiz.title,
                  meta: [
                    quiz.classroomName,
                    `${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'}`,
                    formatTimeLimit(quiz.timeLimitSeconds),
                  ].join(' · '),
                  badge: quiz.dueAt ? relativeDay(quiz.dueAt) : 'Open',
                  badgeClass: quiz.dueAt ? 'badge badge--draft' : 'badge',
                }),
              ),
            ),
      ),
    );
  }

  sections.push(
    section(
      'Due soon',
      data.upcoming.length === 0
        ? emptyState('calendar', 'Nothing in the next three weeks', 'Deadlines will appear here.')
        : el(
            'section',
            { class: 'card card--flush' },
            data.upcoming.map((entry) =>
              entryRow(entry, {
                href: `/classrooms/${entry.classroomId}#calendar`,
                title: entry.title,
                meta: `${entry.classroomName} · ${formatDateTime(entry.startsAt)}`,
                badge: relativeDay(entry.startsAt),
                badgeClass: entry.kind === 'due' ? 'badge badge--draft' : 'badge',
              }),
            ),
          ),
      el('a', { class: 'todo-chip', href: '/calendar', text: 'Full calendar' }),
    ),
  );

  if (data.announcements.length > 0) {
    sections.push(
      section(
        'Latest announcements',
        el(
          'section',
          { class: 'card card--flush' },
          data.announcements.map((note) =>
            entryRow(note, {
              href: `/classrooms/${note.classroomId}#announcements`,
              title: note.title,
              meta: `${note.classroomName} · ${note.author} · ${formatDateTime(note.publishedAt)}`,
              badge: note.pinned ? 'Pinned' : null,
              badgeClass: 'badge badge--accent',
            }),
          ),
        ),
      ),
    );
  }

  // Somebody in no courses at all gets one instruction, not five empty lists.
  if (!data.teaches && !data.studies) {
    nodes.root.replaceChildren(
      emptyState(
        'people',
        'You are not in any courses yet',
        'Join one with the code your teacher shared, and this fills in.',
        el('a', { class: 'button', href: '/classrooms', text: 'Join a classroom' }),
      ),
    );
    return;
  }

  nodes.root.replaceChildren(el('div', { class: 'stack dash-sections' }, sections));
}

async function boot() {
  const user = await requireSession();
  if (!user) return;

  renderHeader({ user });

  try {
    const data = await api.dashboard();

    const hour = new Date().getHours();
    const partOfDay = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    nodes.greeting.textContent = `${partOfDay}, ${data.name.split(' ')[0]}`;

    nodes.subtitle.textContent = [
      data.teaches ? `Teaching ${data.teaching.length}` : null,
      data.studies ? `Studying ${data.studying.length}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    render(data);
  } catch (error) {
    showError(nodes.pageError, error.message);
  }
}

boot();
