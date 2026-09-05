import {
  api,
  applyCourseTheme,
  el,
  formatDuration,
  formatTimeLimit,
  requireSession,
  showError,
  toast,
} from './api.js';

/**
 * Taking a quiz.
 *
 * Answers autosave as they are given, so a closed tab loses at most the last
 * one. The clock is drawn from the deadline the server issued rather than
 * counted locally, so a paused tab or a slow machine cannot buy time.
 */

const [, , classroomId, , quizId] = window.location.pathname.split('/');
const backHref = `/classrooms/${classroomId}#quiz`;

const nodes = {
  intro: document.querySelector('#intro'),
  taking: document.querySelector('#taking'),
  finished: document.querySelector('#finished'),
  questions: document.querySelector('#questions'),
  timer: document.querySelector('#timer'),
  progress: document.querySelector('#progress'),
  pageError: document.querySelector('#page-error'),
  review: document.querySelector('#review'),
};

let attempt = null;
let quiz = null;
let answers = {};
let ticker = null;
let submitting = false;

const stat = (label, value) =>
  el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: String(value) }),
  ]);

/* ---- The clock ----------------------------------------------------------- */

function updateProgress() {
  const answered = Object.keys(answers).length;
  nodes.progress.textContent = `${answered} of ${quiz.questions.length} answered`;
}

function startTicker() {
  const deadline = Date.parse(attempt.deadlineAt);

  const tick = () => {
    const remaining = deadline - Date.now();
    nodes.timer.textContent = formatDuration(Math.max(0, remaining));
    nodes.timer.dataset.urgent = String(remaining <= 60_000);

    if (remaining <= 0) {
      clearInterval(ticker);
      ticker = null;
      // The server decides the final state; this just stops the waiting.
      submit({ automatic: true });
    }
  };

  tick();
  ticker = setInterval(tick, 500);
}

/* ---- Autosave ------------------------------------------------------------ */

/**
 * One in-flight save per question, so holding a key down cannot queue up a
 * hundred requests that arrive out of order.
 */
const pending = new Map();

async function saveAnswer(questionId, answer) {
  if (answer === null || answer === undefined || answer === '') {
    delete answers[questionId];
  } else {
    answers[questionId] = answer;
  }
  updateProgress();

  if (pending.has(questionId)) return;
  pending.set(questionId, true);

  try {
    await api.saveAnswer(attempt.attemptId, questionId, answers[questionId] ?? null);
  } catch (error) {
    if (error.status === 410) {
      // Time ran out while typing; the server has already closed the attempt.
      await submit({ automatic: true });
      return;
    }
    toast('Could not save that answer — check your connection');
  } finally {
    pending.delete(questionId);
  }
}

/** Wait for autosaves to land, so a submit cannot race the last answer. */
const settled = async () => {
  for (let i = 0; i < 20 && pending.size > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/* ---- Questions ----------------------------------------------------------- */

function questionCard(question, index) {
  const card = el('div', { class: 'question-card' }, [
    el('span', {
      class: 'question-card__number',
      text: `Question ${index + 1} · ${question.points} mark${question.points === 1 ? '' : 's'}`,
    }),
    el('p', { class: 'question-card__text', text: question.text }),
  ]);

  if (question.type === 'short') {
    const input = el('input', {
      type: 'text',
      maxlength: '200',
      'aria-label': `Answer to question ${index + 1}`,
      value: answers[question.id] ?? '',
    });
    // Save on the way out rather than per keystroke; a half-typed word is not
    // worth a request, and leaving the field is a natural commit point.
    input.addEventListener('change', () => saveAnswer(question.id, input.value.trim()));
    input.addEventListener('blur', () => saveAnswer(question.id, input.value.trim()));
    card.append(el('div', { class: 'field' }, [input]));
    return card;
  }

  card.append(
    ...question.options.map((option, optionIndex) => {
      const radio = el('input', {
        type: 'radio',
        name: question.id,
        checked: answers[question.id] === optionIndex,
      });
      radio.addEventListener('change', () => saveAnswer(question.id, optionIndex));
      return el('label', { class: 'choice' }, [radio, el('span', { text: option })]);
    }),
  );

  return card;
}

/* ---- Submitting ---------------------------------------------------------- */

async function submit({ automatic = false } = {}) {
  if (submitting) return;
  if (
    !automatic &&
    Object.keys(answers).length < quiz.questions.length &&
    !window.confirm('Some questions are unanswered. Submit anyway?')
  ) {
    return;
  }

  submitting = true;
  document.querySelector('#submit').disabled = true;
  document.querySelector('#submit-bottom').disabled = true;

  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }

  await settled();

  try {
    // Answers are already saved; sending them again makes the submission
    // correct even if a save was lost.
    showResult(await api.submitAttempt(attempt.attemptId, answers));
  } catch (error) {
    showError(nodes.pageError, error.message);
    submitting = false;
  }
}

document.querySelector('#submit').addEventListener('click', () => submit());
document.querySelector('#submit-bottom').addEventListener('click', () => submit());

/* ---- The result ---------------------------------------------------------- */

const REASON = {
  timed_out: 'Time ran out, so this was submitted automatically.',
  left_quiz: 'You left the page, and this quiz ends when that happens.',
  submitted: '',
};

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
      text: row.givenAnswer === null ? 'You did not answer this.' : `You answered: ${row.givenAnswer}`,
    }),
    row.isCorrect
      ? null
      : el('p', { class: 'answer-line answer-line--key', text: `Answer: ${row.correctAnswer}` }),
  ]);
}

function showResult(result) {
  nodes.taking.hidden = true;
  nodes.intro.hidden = true;
  nodes.finished.hidden = false;

  document.querySelector('#result-title').textContent =
    `${result.score} out of ${result.maxScore}`;
  document.querySelector('#result-reason').textContent = REASON[result.endedReason] ?? '';
  document.querySelector('#result-back').href = backHref;

  document.querySelector('#result-stats').replaceChildren(
    stat('Score', `${result.score}/${result.maxScore}`),
    stat('Correct', `${result.correctCount}/${result.questionCount}`),
    stat('Answered', `${result.answeredCount}/${result.questionCount}`),
    stat('Time taken', formatDuration(result.durationMs)),
  );

  if (Array.isArray(result.review)) {
    document.querySelector('#review-card').hidden = false;
    nodes.review.replaceChildren(...result.review.map(reviewRow));
  }
}

/* ---- Leaving the page ---------------------------------------------------- */

/**
 * When a quiz ends on leaving, switching tab or app closes the attempt. The
 * beacon is what survives the page being torn down; the server treats a second
 * one as a no-op.
 */
function watchForLeaving() {
  if (!quiz.endOnLeave) return;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || submitting) return;
    navigator.sendBeacon?.(`/api/attempts/${attempt.attemptId}/abandon`, new Blob([], {
      type: 'application/json',
    }));
    submitting = true;
  });
}

/* ---- Starting ------------------------------------------------------------ */

async function begin() {
  document.querySelector('#start').disabled = true;

  try {
    const started = await api.startAttempt(classroomId, quizId);
    attempt = started.attempt;
    quiz = started.quiz;
    answers = { ...started.attempt.answers };

    nodes.intro.hidden = true;
    nodes.taking.hidden = false;

    nodes.questions.replaceChildren(...quiz.questions.map(questionCard));
    updateProgress();
    startTicker();
    watchForLeaving();

    if (started.resumed) toast('Picking up where you left off');
  } catch (error) {
    showError(nodes.pageError, error.message);
    document.querySelector('#start').disabled = false;
  }
}

document.querySelector('#start').addEventListener('click', begin);

/* ---- Boot ---------------------------------------------------------------- */

async function boot() {
  const user = await requireSession();
  if (!user) return;

  // The quiz pages belong to a classroom, so they wear its colour too.
  applyCourseTheme(document.documentElement, classroomId);

  document.querySelector('#intro-back').href = backHref;

  let summary;
  try {
    const quizzes = await api.listQuizzes(classroomId);
    summary = quizzes.find((candidate) => candidate.id === quizId);
  } catch (error) {
    showError(nodes.pageError, error.message);
    return;
  }

  if (!summary) {
    showError(nodes.pageError, 'That quiz does not exist, or it is not open to you.');
    return;
  }

  document.querySelector('#intro-title').textContent = summary.title;
  document.querySelector('#intro-description').textContent = summary.description ?? '';
  document.querySelector('#intro-stats').replaceChildren(
    stat('Questions', summary.questionCount),
    stat('Marks', summary.totalPoints),
    stat('Time limit', formatTimeLimit(summary.timeLimitSeconds)),
    stat('Attempts', summary.allowRetakes ? 'Unlimited' : 'One'),
  );

  const warning = document.querySelector('#intro-warning');
  if (!summary.canStart) {
    warning.hidden = false;
    warning.textContent =
      summary.state === 'scheduled'
        ? 'This quiz has not opened yet.'
        : summary.state === 'closed'
          ? 'This quiz has closed.'
          : 'You have already taken this quiz.';
    document.querySelector('#start').disabled = true;
  } else if (summary.inProgressAttemptId) {
    warning.hidden = false;
    warning.textContent = 'You have an attempt in progress. The clock has been running.';
    document.querySelector('#start').textContent = 'Resume the quiz';
  }

  nodes.intro.hidden = false;
}

boot();
