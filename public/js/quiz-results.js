import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  formatDateTime,
  formatDuration,
  renderHeader,
  requireSession,
  showError,
  toast,
} from './api.js';

/** Teaching staff only; the API refuses a student and this page says so. */

const [, , classroomId, , quizId] = window.location.pathname.split('/');

const nodes = {
  heading: document.querySelector('#heading'),
  summary: document.querySelector('#summary'),
  resultsCard: document.querySelector('#results-card'),
  body: document.querySelector('#results-body'),
  empty: document.querySelector('#empty'),
  pageError: document.querySelector('#page-error'),
  reviewCard: document.querySelector('#review-card'),
  review: document.querySelector('#review'),
};

let data = null;

const stat = (label, value) =>
  el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: String(value) }),
  ]);

const RANK_CLASS = { 1: 'rank-medal rank-medal--1', 2: 'rank-medal rank-medal--2', 3: 'rank-medal rank-medal--3' };

const ENDED = {
  timed_out: 'Timed out',
  left_quiz: 'Left the page',
  submitted: 'Submitted',
};

/* ---- One student's paper -------------------------------------------------- */

function reviewRow(row) {
  return el('div', { class: 'review-row', dataset: { correct: String(row.isCorrect) } }, [
    el('div', { class: 'row row--tight' }, [
      el('span', { class: 'question-card__number', text: `Question ${row.number}` }),
      el('span', {
        class: row.isCorrect ? 'badge badge--live' : 'badge',
        text: `${row.pointsAwarded}/${row.points}`,
      }),
    ]),
    el('p', { class: 'question-card__text', text: row.text }),
    el('p', {
      class: 'answer-line answer-line--given',
      text: row.givenAnswer === null ? 'Not answered' : `Answered: ${row.givenAnswer}`,
    }),
    row.isCorrect
      ? null
      : el('p', { class: 'answer-line answer-line--key', text: `Answer: ${row.correctAnswer}` }),
  ]);
}

async function openReview(attempt) {
  try {
    const paper = await api.reviewAttempt(classroomId, quizId, attempt.attemptId);
    document.querySelector('#review-title').textContent =
      `${attempt.studentName} — ${paper.score}/${paper.maxScore}`;
    nodes.review.replaceChildren(...paper.review.map(reviewRow));
    nodes.reviewCard.hidden = false;
    nodes.reviewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showError(nodes.pageError, error.message);
  }
}

document.querySelector('#review-close').addEventListener('click', () => {
  nodes.reviewCard.hidden = true;
});

/* ---- The table ------------------------------------------------------------ */

function resultRow(attempt) {
  return el('tr', {}, [
    el('td', {}, [
      RANK_CLASS[attempt.rank]
        ? el('span', { class: RANK_CLASS[attempt.rank], text: String(attempt.rank) })
        : el('span', { text: String(attempt.rank) }),
    ]),
    el('td', {}, [
      el('div', { class: 'stack stack--tight' }, [
        el('span', { text: attempt.studentName }),
        el('span', { class: 'roster__email', text: attempt.studentEmail }),
        attempt.attemptNumber > 1
          ? el('span', { class: 'meta', text: `Attempt ${attempt.attemptNumber}` })
          : null,
      ]),
    ]),
    el('td', { class: 'numeric', text: `${attempt.score}/${attempt.maxScore}` }),
    el('td', { class: 'numeric', text: String(attempt.correctCount) }),
    el('td', { class: 'numeric', text: formatDuration(attempt.durationMs) }),
    el('td', {}, [
      el('div', { class: 'stack stack--tight' }, [
        el('span', { text: ENDED[attempt.endedReason] ?? '—' }),
        el('span', { class: 'meta', text: formatDateTime(attempt.submittedAt) }),
      ]),
    ]),
    el('td', {}, [
      el('div', { class: 'row row--tight' }, [
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'View paper',
          onClick: () => openReview(attempt),
        }),
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Delete',
          onClick: async () => {
            if (
              !window.confirm(
                `Delete ${attempt.studentName}'s attempt? They will be able to take the quiz again.`,
              )
            ) {
              return;
            }
            await api.deleteAttempt(classroomId, quizId, attempt.attemptId);
            toast('Attempt deleted');
            await refresh();
          },
        }),
      ]),
    ]),
  ]);
}

async function refresh() {
  try {
    data = await api.quizResults(classroomId, quizId);
  } catch (error) {
    showError(
      nodes.pageError,
      error.status === 403 ? 'Only teaching staff can see results.' : error.message,
    );
    return;
  }

  document.querySelector('#quiz-title').textContent = data.quiz.title;
  document.querySelector('#quiz-meta').textContent =
    `${data.quiz.questionCount} questions · ${data.quiz.totalPoints} marks`;
  nodes.heading.hidden = false;

  const { attempts } = data;
  nodes.reviewCard.hidden = true;

  if (attempts.length === 0) {
    nodes.summary.hidden = true;
    nodes.resultsCard.hidden = true;
    nodes.empty.replaceChildren(
      emptyState(
        'quiz',
        'No attempts yet',
        'Once students have taken this quiz, their scores and papers appear here.',
      ),
    );
    return;
  }

  const scores = attempts.map((attempt) => attempt.score);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;

  nodes.empty.replaceChildren();
  nodes.summary.hidden = false;
  nodes.summary.replaceChildren(
    stat('Submitted', attempts.length),
    stat('Average', `${mean.toFixed(1)}/${data.quiz.totalPoints}`),
    stat('Highest', `${Math.max(...scores)}/${data.quiz.totalPoints}`),
    stat('Lowest', `${Math.min(...scores)}/${data.quiz.totalPoints}`),
  );

  nodes.resultsCard.hidden = false;
  nodes.body.replaceChildren(...attempts.map(resultRow));
}

document.querySelector('#clear').addEventListener('click', async () => {
  if (
    !window.confirm(
      'Delete every attempt at this quiz? This clears the results and lets everyone take it again.',
    )
  ) {
    return;
  }
  await api.clearQuizResults(classroomId, quizId);
  toast('Results cleared');
  await refresh();
});

/* ---- Boot ---------------------------------------------------------------- */

async function boot() {
  const user = await requireSession();
  if (!user) return;

  // The quiz pages belong to a classroom, so they wear its colour too.
  applyCourseTheme(document.documentElement, classroomId);

  renderHeader({ user });
  document.querySelector('#back').href = `/classrooms/${classroomId}#quiz`;

  await refresh();
  if (data) renderHeader({ user, current: data.quiz.title });
}

boot();
