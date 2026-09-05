import { api, el, formatDateTime, showError, toast } from '../api.js';
import {
  bucketByDay,
  dateFromKey,
  dayKey,
  gridRange,
  renderMonthGrid,
  timeText,
} from '../lib/calendarGrid.js';

/**
 * The Calendar tab.
 *
 * A month grid with the days either side filled in, plus what is coming up
 * next. Deadlines from quizzes and gradebook columns appear here without
 * anybody copying them: the server unions them in, and they are read-only
 * because they are changed where they are set.
 *
 * The grid itself lives in lib/calendarGrid.js, shared with the cross-course
 * calendar so the two cannot drift apart.
 */

export const KIND_LABEL = {
  class: 'Class',
  due: 'Deadline',
  exam: 'Exam',
  office_hours: 'Office hours',
  other: 'Event',
};

export async function renderCalendarTab({ classroomId }) {
  const container = el('div', { class: 'stack' });
  const error = el('p', { class: 'notice notice--error', hidden: true });
  const body = el('div', { class: 'stack' });

  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth();
  /** The day whose detail is open, as a day key, or null. */
  let selectedDay = dayKey(today);

  /* ---- The event form ---- */

  const form = el('form', { class: 'card stack', hidden: true });
  let editingId = null;

  const field = (labelText, input) =>
    el('div', { class: 'field' }, [el('label', { text: labelText }), input]);

  const titleInput = el('input', { type: 'text', maxlength: '120', required: true });
  const descriptionInput = el('textarea', { rows: '2', maxlength: '500' });
  const startInput = el('input', { type: 'datetime-local', required: true });
  const endInput = el('input', { type: 'datetime-local' });
  const kindInput = el(
    'select',
    {},
    Object.entries(KIND_LABEL).map(([value, label]) =>
      el('option', { value, text: label }),
    ),
  );
  const allDayInput = el('input', { type: 'checkbox' });
  const formTitle = el('h3', { class: 'card__title', text: 'New event' });
  const submitButton = el('button', { class: 'button', type: 'submit', text: 'Add event' });

  /** datetime-local speaks local wall-clock with no zone; the API wants ISO. */
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  };

  const closeForm = () => {
    form.hidden = true;
    editingId = null;
  };

  const openForm = (entry = null, onDay = null) => {
    editingId = entry?.id ?? null;
    formTitle.textContent = entry ? 'Edit event' : 'New event';
    submitButton.textContent = entry ? 'Save changes' : 'Add event';

    titleInput.value = entry?.title ?? '';
    descriptionInput.value = entry?.description ?? '';
    kindInput.value = entry?.kind ?? 'other';
    allDayInput.checked = entry?.allDay ?? false;
    endInput.value = toLocalInput(entry?.endsAt);

    if (entry) {
      startInput.value = toLocalInput(entry.startsAt);
    } else {
      // A new event on a clicked day starts at a sensible hour on that day.
      const base = onDay ? new Date(onDay) : new Date();
      base.setHours(9, 0, 0, 0);
      startInput.value = toLocalInput(base.toISOString());
    }

    form.hidden = false;
    titleInput.focus();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      title: titleInput.value,
      description: descriptionInput.value,
      startsAt: new Date(startInput.value).toISOString(),
      endsAt: endInput.value ? new Date(endInput.value).toISOString() : null,
      allDay: allDayInput.checked,
      kind: kindInput.value,
    };

    try {
      if (editingId) {
        await api.updateCalendarEvent(classroomId, editingId, payload);
        toast('Event updated');
      } else {
        await api.createCalendarEvent(classroomId, payload);
        toast('Event added');
      }
      closeForm();
      await refresh();
    } catch (failure) {
      showError(error, failure.message);
    }
  });

  form.append(
    formTitle,
    field('Title', titleInput),
    field('Details', descriptionInput),
    el('div', { class: 'split' }, [field('Starts', startInput), field('Ends', endInput)]),
    el('div', { class: 'split' }, [
      field('Kind', kindInput),
      el('label', { class: 'switch' }, [allDayInput, el('span', { text: 'All day' })]),
    ]),
    el('div', { class: 'row' }, [
      submitButton,
      el('button', {
        class: 'button button--ghost',
        type: 'button',
        text: 'Cancel',
        onClick: closeForm,
      }),
    ]),
  );

  /* ---- Rendering ---- */

  function entryChip(entry, { onSelect }) {
    return el('button', {
      class: 'cal-chip',
      type: 'button',
      dataset: { kind: entry.kind },
      title: `${entry.title} · ${timeText(entry)}`,
      text: entry.title,
      onClick: onSelect,
    });
  }

  function dayDetail(entries, data, dayDate) {
    if (entries.length === 0) {
      return el('div', { class: 'card stack' }, [
        el('p', {
          class: 'meta',
          text: `Nothing on ${dayDate.toLocaleDateString(undefined, { dateStyle: 'full' })}.`,
        }),
        data.canEdit
          ? el('div', { class: 'row' }, [
              el('button', {
                class: 'button button--small',
                type: 'button',
                text: 'Add an event on this day',
                onClick: () => openForm(null, dayDate),
              }),
            ])
          : null,
      ]);
    }

    return el('section', { class: 'card card--flush' }, [
      ...entries.map((entry) =>
        el('div', { class: 'list-row' }, [
          el('span', { class: 'cal-dot', dataset: { kind: entry.kind } }),
          el('div', { class: 'stack stack--tight list-row__main' }, [
            el('div', { class: 'row row--tight' }, [
              el('strong', { text: entry.title }),
              entry.derivedFrom
                ? el('span', {
                    class: 'badge',
                    text: entry.derivedFrom === 'quiz' ? 'Quiz' : 'Assessment',
                  })
                : el('span', { class: 'badge', text: KIND_LABEL[entry.kind] }),
            ]),
            el('span', { class: 'meta', text: timeText(entry) }),
            entry.description ? el('span', { class: 'meta', text: entry.description }) : null,
            // Saying where it comes from is what makes the missing edit button
            // make sense.
            entry.derivedFrom
              ? el('span', {
                  class: 'meta',
                  text:
                    entry.derivedFrom === 'quiz'
                      ? 'Set on the quiz — change it there.'
                      : 'Set on the gradebook column — change it there.',
                })
              : null,
          ]),
          el('span', { class: 'spacer' }),
          entry.editable
            ? el('div', { class: 'row row--tight' }, [
                el('button', {
                  class: 'button button--ghost button--small',
                  type: 'button',
                  text: 'Edit',
                  onClick: () => openForm(entry),
                }),
                el('button', {
                  class: 'button button--ghost button--small',
                  type: 'button',
                  text: 'Delete',
                  onClick: async () => {
                    if (!window.confirm(`Delete "${entry.title}"?`)) return;
                    try {
                      await api.removeCalendarEvent(classroomId, entry.id);
                      toast('Event deleted');
                      await refresh();
                    } catch (failure) {
                      showError(error, failure.message);
                    }
                  },
                }),
              ])
            : null,
        ]),
      ),
      data.canEdit
        ? el('div', { class: 'list-row' }, [
            el('button', {
              class: 'button button--ghost button--small',
              type: 'button',
              text: 'Add another on this day',
              onClick: () => openForm(null, dayDate),
            }),
          ])
        : null,
    ]);
  }

  const monthGrid = (data, byDay) =>
    renderMonthGrid({
      year,
      month,
      byDay,
      selectedDay,
      onSelectDay: (key) => {
        selectedDay = key;
        render(data);
      },
      chipFor: (entry, key) =>
        entryChip(entry, {
          onSelect: () => {
            selectedDay = key;
            render(data);
          },
        }),
    });

  function render(data) {
    // Bucket by local day, because "which day is this on" is a local question.
    const byDay = bucketByDay(data.entries);

    const monthName = new Date(year, month, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });

    const selectedDate = selectedDay ? dateFromKey(selectedDay) : new Date();

    body.replaceChildren(
      el('div', { class: 'row row--tight cal-toolbar' }, [
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: '‹',
          'aria-label': 'Previous month',
          onClick: () => step(-1),
        }),
        el('h2', { class: 'cal-month', text: monthName }),
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: '›',
          'aria-label': 'Next month',
          onClick: () => step(1),
        }),
        el('button', {
          class: 'button button--ghost button--small',
          type: 'button',
          text: 'Today',
          onClick: () => {
            const now = new Date();
            year = now.getFullYear();
            month = now.getMonth();
            selectedDay = dayKey(now);
            refresh();
          },
        }),
        el('span', { class: 'spacer' }),
        data.canEdit
          ? el('button', {
              class: 'button button--small',
              type: 'button',
              text: 'New event',
              onClick: () => openForm(null, selectedDate),
            })
          : null,
      ]),

      form,
      monthGrid(data, byDay),

      el('h3', {
        class: 'card__title',
        text: selectedDate.toLocaleDateString(undefined, { dateStyle: 'full' }),
      }),
      dayDetail(byDay.get(selectedDay) ?? [], data, selectedDate),

      data.upcoming.length > 0
        ? el('section', { class: 'stack' }, [
            el('h3', { class: 'card__title', text: 'Coming up' }),
            el(
              'section',
              { class: 'card card--flush' },
              data.upcoming.map((entry) =>
                el('div', { class: 'list-row' }, [
                  el('span', { class: 'cal-dot', dataset: { kind: entry.kind } }),
                  el('div', { class: 'stack stack--tight list-row__main' }, [
                    el('strong', { text: entry.title }),
                    el('span', { class: 'meta', text: formatDateTime(entry.startsAt) }),
                  ]),
                  el('span', { class: 'spacer' }),
                  el('span', {
                    class: 'badge',
                    text: entry.derivedFrom
                      ? entry.derivedFrom === 'quiz'
                        ? 'Quiz'
                        : 'Assessment'
                      : KIND_LABEL[entry.kind],
                  }),
                ]),
              ),
            ),
          ])
        : null,
    );
  }

  function step(delta) {
    month += delta;
    if (month < 0) {
      month = 11;
      year -= 1;
    } else if (month > 11) {
      month = 0;
      year += 1;
    }
    refresh();
  }

  async function refresh() {
    try {
      const { from, to } = gridRange(year, month);
      const data = await api.calendar(classroomId, from.toISOString(), to.toISOString());
      render(data);
    } catch (failure) {
      showError(error, failure.message);
    }
  }

  container.append(error, body);
  await refresh();
  return container;
}
