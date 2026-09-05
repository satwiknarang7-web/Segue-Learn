import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  formatTimeLimit,
  hideNotice,
  renderHeader,
  requireSession,
  showError,
  toast,
} from './api.js';

/** Teaching staff only; the API refuses a student, and this page follows suit. */

const [, , classroomId, , quizId] = window.location.pathname.split('/');

const nodes = {
  heading: document.querySelector('#heading'),
  title: document.querySelector('#quiz-title-heading'),
  meta: document.querySelector('#quiz-meta'),
  publishArea: document.querySelector('#publish-area'),
  editor: document.querySelector('#editor'),
  questions: document.querySelector('#questions'),
  pageError: document.querySelector('#page-error'),
  questionError: document.querySelector('#question-error'),
  settingsError: document.querySelector('#settings-error'),
  options: document.querySelector('#options'),
};

let quiz = null;
/** The question being edited, or null when the form is adding a new one. */
let editingId = null;

/* ---- Options ------------------------------------------------------------- */

function optionRow(value = '', checked = false) {
  const radio = el('input', { type: 'radio', name: 'correct', checked });
  const input = el('input', {
    type: 'text',
    maxlength: '200',
    value,
    placeholder: 'Answer option',
  });

  return el('div', { class: 'row row--tight option' }, [
    radio,
    input,
    el('button', {
      class: 'button button--ghost button--small',
      type: 'button',
      text: 'Remove',
      onClick: (event) => {
        const rows = nodes.options.querySelectorAll('.option');
        if (rows.length <= 2) {
          toast('A question needs at least two options');
          return;
        }
        event.target.closest('.option').remove();
      },
    }),
  ]);
}

function readOptions() {
  const rows = [...nodes.options.querySelectorAll('.option')];
  return {
    options: rows.map((row) => row.querySelector('input[type=text]').value),
    correctIndex: rows.findIndex((row) => row.querySelector('input[type=radio]').checked),
  };
}

function setOptions(options = ['', ''], correctIndex = 0) {
  nodes.options.replaceChildren(
    ...options.map((option, index) => optionRow(option, index === correctIndex)),
  );
}

/* ---- The question form --------------------------------------------------- */

const typeSelect = document.querySelector('#q-type');

function applyType() {
  const isChoice = typeSelect.value === 'choice';
  document.querySelector('#choice-fields').hidden = !isChoice;
  document.querySelector('#short-fields').hidden = isChoice;
}

typeSelect.addEventListener('change', applyType);

document.querySelector('#add-option').addEventListener('click', () => {
  if (nodes.options.querySelectorAll('.option').length >= 6) {
    toast('Six options is the maximum');
    return;
  }
  nodes.options.append(optionRow());
});

function resetQuestionForm() {
  editingId = null;
  document.querySelector('#question-form-title').textContent = 'Add a question';
  document.querySelector('#question-submit').textContent = 'Add question';
  document.querySelector('#question-cancel').hidden = true;
  document.querySelector('#question-form').reset();
  typeSelect.value = 'choice';
  document.querySelector('#q-points').value = '1';
  setOptions();
  applyType();
  hideNotice(nodes.questionError);
}

function loadIntoForm(question) {
  editingId = question.id;
  document.querySelector('#question-form-title').textContent = 'Edit question';
  document.querySelector('#question-submit').textContent = 'Save question';
  document.querySelector('#question-cancel').hidden = false;

  typeSelect.value = question.type ?? 'choice';
  document.querySelector('#q-text').value = question.text;
  document.querySelector('#q-points').value = String(question.points);

  if ((question.type ?? 'choice') === 'choice') {
    setOptions(question.options, question.correctIndex);
  } else {
    document.querySelector('#q-answers').value = (question.acceptedAnswers ?? []).join('\n');
  }

  applyType();
  document.querySelector('#q-text').focus();
}

document.querySelector('#question-cancel').addEventListener('click', resetQuestionForm);

document.querySelector('#question-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice(nodes.questionError);

  const type = typeSelect.value;
  const payload = {
    type,
    text: document.querySelector('#q-text').value,
    points: Number(document.querySelector('#q-points').value),
  };

  if (type === 'choice') {
    Object.assign(payload, readOptions());
  } else {
    payload.acceptedAnswers = document
      .querySelector('#q-answers')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  try {
    quiz = editingId
      ? await api.updateQuestion(classroomId, quizId, editingId, payload)
      : await api.addQuestion(classroomId, quizId, payload);
    resetQuestionForm();
    render();
    toast('Saved');
  } catch (error) {
    showError(nodes.questionError, error.message);
  }
});

/* ---- Rendering ----------------------------------------------------------- */

function questionCard(question, index) {
  const type = question.type ?? 'choice';

  const body =
    type === 'choice'
      ? el(
          'ul',
          { class: 'stack stack--tight' },
          question.options.map((option, optionIndex) =>
            el('li', {
              class: optionIndex === question.correctIndex ? 'answer-line--key' : 'answer-line',
              text: `${optionIndex === question.correctIndex ? '✓ ' : '· '}${option}`,
            }),
          ),
        )
      : el('p', {
          class: 'answer-line answer-line--key',
          text: `Accepts: ${(question.acceptedAnswers ?? []).join(', ')}`,
        });

  return el('div', { class: 'question-card' }, [
    el('div', { class: 'row row--tight' }, [
      el('span', { class: 'question-card__number', text: `Question ${index + 1}` }),
      el('span', { class: 'badge', text: type === 'choice' ? 'Multiple choice' : 'Short answer' }),
      el('span', { class: 'badge', text: `${question.points} mark${question.points === 1 ? '' : 's'}` }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: '↑',
        'aria-label': 'Move up',
        onClick: async () => {
          quiz = await api.moveQuestion(classroomId, quizId, question.id, 'up');
          render();
        },
      }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: '↓',
        'aria-label': 'Move down',
        onClick: async () => {
          quiz = await api.moveQuestion(classroomId, quizId, question.id, 'down');
          render();
        },
      }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: 'Edit',
        onClick: () => loadIntoForm(question),
      }),
      el('button', {
        class: 'button button--ghost button--small',
        type: 'button',
        text: 'Delete',
        onClick: async () => {
          if (!window.confirm('Delete this question?')) return;
          quiz = await api.deleteQuestion(classroomId, quizId, question.id);
          if (editingId === question.id) resetQuestionForm();
          render();
          toast('Question deleted');
        },
      }),
    ]),
    el('p', { class: 'question-card__text', text: question.text }),
    body,
  ]);
}

function render() {
  const totalPoints = quiz.questions.reduce((sum, question) => sum + question.points, 0);

  nodes.title.textContent = quiz.title;
  nodes.meta.textContent = [
    `${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}`,
    `${totalPoints} mark${totalPoints === 1 ? '' : 's'}`,
    formatTimeLimit(quiz.timeLimitSeconds),
    quiz.isPublished ? 'Published' : 'Draft',
  ].join(' · ');

  nodes.publishArea.replaceChildren(
    el('div', { class: 'row row--tight' }, [
      el('a', {
        class: 'button button--ghost',
        href: `/classrooms/${classroomId}#quiz`,
        text: 'Back to classroom',
      }),
      el('button', {
        class: quiz.isPublished ? 'button button--ghost' : 'button',
        type: 'button',
        text: quiz.isPublished ? 'Unpublish' : 'Publish',
        onClick: async () => {
          try {
            quiz = await api.updateQuiz(classroomId, quizId, { isPublished: !quiz.isPublished });
            render();
            toast(quiz.isPublished ? 'Published — students can see it now' : 'Unpublished');
          } catch (error) {
            showError(nodes.pageError, error.message);
          }
        },
      }),
    ]),
  );

  if (quiz.questions.length === 0) {
    nodes.questions.replaceChildren(
      emptyState(
        'quiz',
        'No questions yet',
        'Add the first one below. A quiz cannot be published until it has at least one.',
      ),
    );
  } else {
    nodes.questions.replaceChildren(...quiz.questions.map(questionCard));
  }
}

/* ---- Settings ------------------------------------------------------------ */

/** datetime-local wants local wall-clock time with no zone; the API wants ISO. */
const toLocalInput = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

function fillSettings() {
  document.querySelector('#s-title').value = quiz.title;
  document.querySelector('#s-description').value = quiz.description ?? '';
  document.querySelector('#s-minutes').value = String(Math.round(quiz.timeLimitSeconds / 60));
  document.querySelector('#s-available').value = toLocalInput(quiz.availableFrom);
  document.querySelector('#s-due').value = toLocalInput(quiz.dueAt);
  document.querySelector('#s-retakes').checked = quiz.allowRetakes;
  document.querySelector('#s-reveal').checked = quiz.revealAnswers;
  document.querySelector('#s-shuffle-questions').checked = quiz.shuffleQuestions;
  document.querySelector('#s-shuffle-options').checked = quiz.shuffleOptions;
  document.querySelector('#s-end-on-leave').checked = quiz.endOnLeave;
}

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice(nodes.settingsError);

  const value = (id) => document.querySelector(id).value;
  const checked = (id) => document.querySelector(id).checked;

  try {
    quiz = await api.updateQuiz(classroomId, quizId, {
      title: value('#s-title'),
      description: value('#s-description'),
      timeLimitSeconds: Number(value('#s-minutes')) * 60,
      // An empty box means "no window", which the API reads as null.
      availableFrom: value('#s-available') ? new Date(value('#s-available')).toISOString() : null,
      dueAt: value('#s-due') ? new Date(value('#s-due')).toISOString() : null,
      allowRetakes: checked('#s-retakes'),
      revealAnswers: checked('#s-reveal'),
      shuffleQuestions: checked('#s-shuffle-questions'),
      shuffleOptions: checked('#s-shuffle-options'),
      endOnLeave: checked('#s-end-on-leave'),
    });
    render();
    fillSettings();
    toast('Settings saved');
  } catch (error) {
    showError(nodes.settingsError, error.message);
  }
});

/* ---- Boot ---------------------------------------------------------------- */

async function boot() {
  const user = await requireSession();
  if (!user) return;

  // The quiz pages belong to a classroom, so they wear its colour too.
  applyCourseTheme(document.documentElement, classroomId);

  renderHeader({ user });

  try {
    quiz = await api.getQuiz(classroomId, quizId);
  } catch (error) {
    showError(
      nodes.pageError,
      error.status === 403
        ? 'Only teaching staff can edit a quiz.'
        : error.status === 404
          ? 'That quiz does not exist.'
          : error.message,
    );
    return;
  }

  renderHeader({ user, current: quiz.title });
  nodes.heading.hidden = false;
  nodes.editor.hidden = false;

  setOptions();
  applyType();
  fillSettings();
  render();
}

boot();
