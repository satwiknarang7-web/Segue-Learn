import { api, el, emptyState, formatDate, showError, toast } from '../api.js';

/**
 * The Gradebook tab.
 *
 * Staff get a grid: a row per student, a column per assessment. A student gets
 * their own marks and nothing else -- the API sends them one row, so there is
 * no other row on the page to hide.
 *
 * A quiz column's numbers are read from the attempts rather than stored, and
 * typing over one records an override that can be reverted.
 */

const fmt = (value) => (value === null || value === undefined ? '—' : String(value));

const percentText = (total) =>
  total.percent === null ? 'Not graded yet' : `${total.percent}%`;

/* ---- Staff grid ----------------------------------------------------------- */

function cellInput(classroomId, cell, studentId, refresh, error) {
  const input = el('input', {
    type: 'number',
    min: '0',
    max: String(cell.max),
    step: '0.5',
    class: `grade-cell__input${cell.source === 'quiz' ? ' grade-cell__input--derived' : ''}`,
    value: cell.points === null ? '' : String(cell.points),
    'aria-label': `Mark out of ${cell.max}`,
  });

  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    try {
      if (raw === '') {
        await api.clearGrade(classroomId, cell.itemId, studentId);
        toast(cell.source === 'manual' ? 'Mark cleared' : 'Back to the quiz score');
      } else {
        await api.setGrade(classroomId, cell.itemId, studentId, { points: Number(raw) });
      }
      await refresh();
    } catch (failure) {
      showError(error, failure.message);
      // Put the old value back, so the screen never shows a mark that was refused.
      input.value = cell.points === null ? '' : String(cell.points);
    }
  });

  return input;
}

function gradeCell(classroomId, cell, studentId, refresh, error) {
  const children = [cellInput(classroomId, cell, studentId, refresh, error)];

  if (cell.source === 'override') {
    children.push(
      el('button', {
        class: 'grade-cell__revert',
        type: 'button',
        title: 'Revert to the quiz score',
        'aria-label': 'Revert to the quiz score',
        text: '↺',
        onClick: async () => {
          await api.clearGrade(classroomId, cell.itemId, studentId);
          toast('Back to the quiz score');
          await refresh();
        },
      }),
    );
  }

  return el('td', { class: 'grade-cell', dataset: { source: cell.source } }, [
    el('div', { class: 'grade-cell__inner' }, children),
  ]);
}

function columnHeader(item, classroomId, refresh) {
  return el('th', { class: 'grade-head' }, [
    el('div', { class: 'stack stack--tight' }, [
      el('span', { class: 'grade-head__title', text: item.title }),
      el('span', {
        class: 'grade-head__meta',
        text: `out of ${item.pointsPossible}${item.dueAt ? ` · due ${formatDate(item.dueAt)}` : ''}`,
      }),
      el('div', { class: 'row row--tight' }, [
        item.sourceType === 'quiz'
          ? el('span', { class: 'badge badge--accent', text: 'Quiz' })
          : el('span', { class: 'badge', text: 'Manual' }),
        item.orphaned ? el('span', { class: 'badge badge--draft', text: 'Quiz deleted' }) : null,
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Remove',
          onClick: async () => {
            const extra =
              item.sourceType === 'quiz'
                ? ' The quiz and its attempts are kept; it just stops counting towards a grade.'
                : ' Every mark in it is deleted.';
            if (!window.confirm(`Remove the column "${item.title}"?${extra}`)) return;
            await api.removeGradeColumn(classroomId, item.id);
            toast('Column removed');
            await refresh();
          },
        }),
      ]),
    ]),
  ]);
}

function staffGrid(classroomId, data, refresh, error) {
  if (data.items.length === 0) {
    return emptyState(
      'grades',
      'No columns yet',
      'Add an assessment, or pull in a quiz so its scores count towards a grade.',
    );
  }

  if (data.rows.length === 0) {
    return emptyState(
      'people',
      'No students yet',
      'Share the classroom code and the gradebook fills in as people join.',
    );
  }

  const head = el('tr', {}, [
    el('th', { class: 'grade-head grade-head--student', text: 'Student' }),
    ...data.items.map((item) => columnHeader(item, classroomId, refresh)),
    el('th', { class: 'grade-head numeric', text: 'Total' }),
  ]);

  const body = data.rows.map((row) =>
    el('tr', {}, [
      el('td', { class: 'grade-student' }, [
        el('div', { class: 'stack stack--tight' }, [
          el('span', { class: 'roster__name', text: row.name }),
          el('span', { class: 'roster__email', text: row.email ?? '' }),
        ]),
      ]),
      ...row.cells.map((cell) => gradeCell(classroomId, cell, row.studentId, refresh, error)),
      el('td', { class: 'numeric grade-total' }, [
        el('div', { class: 'stack stack--tight' }, [
          el('strong', { text: percentText(row.total) }),
          el('span', {
            class: 'meta',
            text: `${row.total.earned}/${row.total.possible}`,
          }),
        ]),
      ]),
    ]),
  );

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'grade-table' }, [
      el('thead', {}, [head]),
      el('tbody', {}, body),
    ]),
  ]);
}

/* ---- Student view --------------------------------------------------------- */

function studentView(data) {
  if (data.items.length === 0) {
    return emptyState(
      'grades',
      'Nothing graded yet',
      'Your marks appear here as your teacher records them.',
    );
  }

  const row = data.rows[0];
  if (!row) {
    return emptyState('grades', 'No marks yet', 'Nothing has been graded for you here.');
  }

  const lines = data.items.map((item, index) => {
    const cell = row.cells[index];
    return el('div', { class: 'list-row' }, [
      el('div', { class: 'stack stack--tight list-row__main' }, [
        el('strong', { text: item.title }),
        el('span', {
          class: 'meta',
          text: [
            item.sourceType === 'quiz' ? 'Quiz' : 'Assessment',
            `out of ${item.pointsPossible}`,
            item.dueAt ? `due ${formatDate(item.dueAt)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
        cell.feedback ? el('span', { class: 'meta', text: `“${cell.feedback}”` }) : null,
      ]),
      el('span', { class: 'spacer' }),
      cell.graded
        ? el('span', { class: 'badge badge--accent', text: `${fmt(cell.points)} / ${cell.max}` })
        : el('span', { class: 'meta', text: 'Not graded yet' }),
    ]);
  });

  return el('div', { class: 'stack' }, [
    el('section', { class: 'card stack' }, [
      el('span', { class: 'stat__label', text: 'Your grade so far' }),
      el('span', { class: 'grade-headline', text: percentText(row.total) }),
      el('span', {
        class: 'meta',
        text:
          row.total.gradedCount === 0
            ? 'Nothing you have been graded on yet counts towards this.'
            : `${row.total.earned} of ${row.total.possible} marks across ${row.total.gradedCount} graded item${row.total.gradedCount === 1 ? '' : 's'}.`,
      }),
    ]),
    el('section', { class: 'card card--flush' }, lines),
  ]);
}

/* ---- The tab -------------------------------------------------------------- */

export async function renderGradebookTab({ classroomId, isStaff }) {
  const container = el('div', { class: 'stack' });
  const error = el('p', { class: 'notice notice--error', hidden: true });
  const body = el('div', {});

  const refresh = async () => {
    try {
      const data = await api.gradebook(classroomId);
      body.replaceChildren(
        isStaff ? staffGrid(classroomId, data, refresh, error) : studentView(data),
      );
    } catch (failure) {
      showError(error, failure.message);
    }
  };

  container.append(error);

  if (isStaff) {
    const manualForm = el('form', { class: 'card stack', hidden: true }, [
      el('h3', { class: 'card__title', text: 'New column' }),
      el('div', { class: 'field' }, [
        el('label', { for: 'gb-title', text: 'Name' }),
        el('input', { id: 'gb-title', type: 'text', maxlength: '120', required: true }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'gb-points', text: 'Out of' }),
        el('input', { id: 'gb-points', type: 'number', min: '1', value: '100', required: true }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'button', type: 'submit', text: 'Add column' }),
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Cancel',
          onClick: () => {
            manualForm.hidden = true;
          },
        }),
      ]),
    ]);

    manualForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api.addGradeColumn(classroomId, {
          title: manualForm.querySelector('#gb-title').value,
          pointsPossible: Number(manualForm.querySelector('#gb-points').value),
        });
        manualForm.reset();
        manualForm.hidden = true;
        toast('Column added');
        await refresh();
      } catch (failure) {
        showError(error, failure.message);
      }
    });

    const quizPicker = el('div', { class: 'card stack', hidden: true });

    const openQuizPicker = async () => {
      try {
        const quizzes = await api.availableQuizzes(classroomId);
        quizPicker.replaceChildren(
          el('h3', { class: 'card__title', text: 'Add a quiz to the gradebook' }),
          quizzes.length === 0
            ? el('p', {
                class: 'meta',
                text: 'Every published quiz is already in the gradebook.',
              })
            : el(
                'div',
                { class: 'stack stack--tight' },
                quizzes.map((quiz) =>
                  el('div', { class: 'list-row' }, [
                    el('div', { class: 'stack stack--tight list-row__main' }, [
                      el('strong', { text: quiz.title }),
                      el('span', { class: 'meta', text: `${quiz.totalPoints} marks` }),
                    ]),
                    el('span', { class: 'spacer' }),
                    el('button', {
                      class: 'button button--small',
                      type: 'button',
                      text: 'Add',
                      onClick: async () => {
                        await api.addGradeColumn(classroomId, { quizId: quiz.id });
                        toast(`"${quiz.title}" added`);
                        quizPicker.hidden = true;
                        await refresh();
                      },
                    }),
                  ]),
                ),
              ),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'button button--ghost',
              type: 'button',
              text: 'Close',
              onClick: () => {
                quizPicker.hidden = true;
              },
            }),
          ]),
        );
        quizPicker.hidden = false;
      } catch (failure) {
        showError(error, failure.message);
      }
    };

    container.append(
      el('div', { class: 'row' }, [
        el('button', {
          class: 'button',
          type: 'button',
          text: 'New column',
          onClick: () => {
            manualForm.hidden = false;
            quizPicker.hidden = true;
            manualForm.querySelector('#gb-title').focus();
          },
        }),
        el('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Add from a quiz',
          onClick: () => {
            manualForm.hidden = true;
            openQuizPicker();
          },
        }),
      ]),
      manualForm,
      quizPicker,
    );
  }

  container.append(body);
  await refresh();
  return container;
}
