import { api, el, emptyState, formatDateTime, formatTimeLimit, showError, toast } from '../api.js';

/**
 * The Quiz tab.
 *
 * Staff and students see genuinely different things here, so this renders two
 * lists rather than one list with bits hidden. A student is never sent a draft
 * quiz or anyone else's score, so there is nothing to hide in the first place.
 */

const STATE_LABEL = {
  draft: 'Draft',
  scheduled: 'Opens later',
  open: 'Open',
  closed: 'Closed',
};

function stateBadge(quiz) {
  const className =
    quiz.state === 'open'
      ? 'badge badge--live'
      : quiz.state === 'draft'
        ? 'badge badge--draft'
        : 'badge';
  return el('span', { class: className, text: STATE_LABEL[quiz.state] ?? quiz.state });
}

/** The line under a quiz title: length, marks, and the window it runs in. */
function quizMeta(quiz) {
  return [
    `${quiz.questionCount} question${quiz.questionCount === 1 ? '' : 's'}`,
    `${quiz.totalPoints} mark${quiz.totalPoints === 1 ? '' : 's'}`,
    formatTimeLimit(quiz.timeLimitSeconds),
    quiz.dueAt ? `Due ${formatDateTime(quiz.dueAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ---- Staff ---------------------------------------------------------------- */

function staffRow(classroomId, quiz, refresh) {
  return el('div', { class: 'list-row' }, [
    el('div', { class: 'stack stack--tight list-row__main' }, [
      el('div', { class: 'row row--tight' }, [
        el('strong', { text: quiz.title }),
        stateBadge(quiz),
      ]),
      el('span', { class: 'meta', text: quizMeta(quiz) }),
    ]),
    el('span', { class: 'spacer' }),
    el('span', {
      class: 'meta',
      text: `${quiz.attemptCount} submitted`,
    }),
    el('a', {
      class: 'button button--ghost button--small',
      href: `/classrooms/${classroomId}/quizzes/${quiz.id}/results`,
      text: 'Results',
    }),
    el('a', {
      class: 'button button--ghost button--small',
      href: `/classrooms/${classroomId}/quizzes/${quiz.id}/edit`,
      text: 'Edit',
    }),
    el('button', {
      class: 'button button--ghost button--small',
      type: 'button',
      text: 'Delete',
      onClick: async () => {
        if (
          !window.confirm(
            `Delete "${quiz.title}"? Every attempt at it is deleted too. This cannot be undone.`,
          )
        ) {
          return;
        }
        await api.deleteQuiz(classroomId, quiz.id);
        toast('Quiz deleted');
        await refresh();
      },
    }),
  ]);
}

/* ---- Students ------------------------------------------------------------- */

function studentRow(classroomId, quiz) {
  const taken = quiz.attemptsTaken > 0;

  const action = quiz.canStart
    ? el('a', {
        class: 'button button--small',
        href: `/classrooms/${classroomId}/quizzes/${quiz.id}/take`,
        text: quiz.inProgressAttemptId ? 'Resume' : taken ? 'Take again' : 'Start',
      })
    : el('span', {
        class: 'meta',
        text:
          quiz.state === 'scheduled'
            ? 'Not open yet'
            : quiz.state === 'closed'
              ? 'Closed'
              : taken
                ? 'Already taken'
                : 'Unavailable',
      });

  return el('div', { class: 'list-row' }, [
    el('div', { class: 'stack stack--tight list-row__main' }, [
      el('div', { class: 'row row--tight' }, [
        el('strong', { text: quiz.title }),
        quiz.state !== 'open' ? stateBadge(quiz) : null,
      ]),
      el('span', { class: 'meta', text: quizMeta(quiz) }),
    ]),
    el('span', { class: 'spacer' }),
    taken
      ? el('span', {
          class: 'badge badge--accent',
          text: `Best ${quiz.bestScore}/${quiz.totalPoints}`,
        })
      : null,
    action,
  ]);
}

/* ---- The tab -------------------------------------------------------------- */

export async function renderQuizTab({ classroomId, isStaff }) {
  const container = el('div', { class: 'stack' });
  const error = el('p', { class: 'notice notice--error', hidden: true });
  const list = el('div', { class: 'stack stack--tight' });

  const refresh = async () => {
    try {
      const quizzes = await api.listQuizzes(classroomId);

      if (quizzes.length === 0) {
        list.replaceChildren(
          isStaff
            ? emptyState(
                'quiz',
                'No quizzes yet',
                'Create one, add questions, and publish it when it is ready.',
              )
            : emptyState('quiz', 'No quizzes yet', 'Quizzes your teacher sets appear here.'),
        );
        return;
      }

      list.replaceChildren(
        el(
          'section',
          { class: 'card card--flush' },
          quizzes.map((quiz) =>
            isStaff ? staffRow(classroomId, quiz, refresh) : studentRow(classroomId, quiz),
          ),
        ),
      );
    } catch (failure) {
      showError(error, failure.message);
    }
  };

  container.append(error);

  if (isStaff) {
    const form = el('form', { class: 'card stack', hidden: true }, [
      el('h3', { class: 'card__title', text: 'New quiz' }),
      el('div', { class: 'field' }, [
        el('label', { for: 'quiz-title', text: 'Title' }),
        el('input', { id: 'quiz-title', type: 'text', maxlength: '120', required: true }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'quiz-minutes', text: 'Time limit (minutes)' }),
        el('input', {
          id: 'quiz-minutes',
          type: 'number',
          min: '1',
          max: '240',
          value: '10',
          required: true,
        }),
        el('span', {
          class: 'field__hint',
          text: 'The clock starts when a student opens the quiz.',
        }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'button', type: 'submit', text: 'Create and add questions' }),
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Cancel',
          onClick: () => {
            form.hidden = true;
          },
        }),
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const created = await api.createQuiz(classroomId, {
          title: form.querySelector('#quiz-title').value,
          timeLimitSeconds: Number(form.querySelector('#quiz-minutes').value) * 60,
        });
        // Straight into the editor: a quiz with no questions is not useful yet.
        window.location.href = `/classrooms/${classroomId}/quizzes/${created.id}/edit`;
      } catch (failure) {
        showError(error, failure.message);
      }
    });

    container.append(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'button',
          type: 'button',
          text: 'New quiz',
          onClick: () => {
            form.hidden = false;
            form.querySelector('#quiz-title').focus();
          },
        }),
      ]),
      form,
    );
  }

  container.append(list);
  await refresh();
  return container;
}
