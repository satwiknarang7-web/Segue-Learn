import {
  api,
  applyCourseTheme,
  el,
  emptyState,
  formatDateTime,
  renderHeader,
  requireSession,
  showError,
} from './api.js';
import {
  bucketByDay,
  dateFromKey,
  dayKey,
  gridRange,
  renderMonthGrid,
  timeText,
} from './lib/calendarGrid.js';
import { KIND_LABEL } from './tabs/calendar.js';

/**
 * The calendar across every course.
 *
 * The classroom tab answers "what is happening in this course"; this answers
 * "what is coming at me", which is the question a student actually has on a
 * Sunday evening.
 *
 * Chips are coloured by COURSE here rather than by kind. In one classroom the
 * useful distinction is class-versus-deadline; across six, it is which course
 * a thing belongs to -- the kind is still on the entry, in its badge.
 *
 * Nothing here is editable. A deadline belongs to a course and is changed in
 * that course, so every entry links back to where it lives instead.
 */

const nodes = {
  root: document.querySelector('#calendar'),
  pageError: document.querySelector('#page-error'),
};

const today = new Date();
let year = today.getFullYear();
let month = today.getMonth();
let selectedDay = dayKey(today);
let data = null;

/** A dot in the course's colour, used wherever an entry names its course. */
const courseDot = (classroomId) =>
  applyCourseTheme(el('span', { class: 'menu__dot', 'aria-hidden': 'true' }), classroomId);

function entryRow(entry) {
  return el('a', { class: 'list-row cal-entry', href: `/classrooms/${entry.classroomId}#calendar` }, [
    courseDot(entry.classroomId),
    el('div', { class: 'stack stack--tight list-row__main' }, [
      el('strong', { text: entry.title }),
      el('span', {
        class: 'meta',
        text: `${entry.classroomName} · ${timeText(entry)}`,
      }),
    ]),
    el('span', { class: 'spacer' }),
    el('span', {
      class: entry.kind === 'due' ? 'badge badge--draft' : 'badge',
      text: entry.derivedFrom === 'quiz' ? 'Quiz' : (KIND_LABEL[entry.kind] ?? entry.kind),
    }),
  ]);
}

function dayDetail(entries, dayDate) {
  const heading = el('h2', {
    class: 'card__title',
    text: dayDate.toLocaleDateString(undefined, { dateStyle: 'full' }),
  });

  if (entries.length === 0) {
    return el('div', { class: 'stack' }, [
      heading,
      el('div', { class: 'card' }, [
        el('p', { class: 'meta', text: 'Nothing on this day.' }),
      ]),
    ]);
  }

  return el('div', { class: 'stack' }, [
    heading,
    el('section', { class: 'card card--flush' }, entries.map(entryRow)),
  ]);
}

function render() {
  const byDay = bucketByDay(data.entries);

  const monthName = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const grid = renderMonthGrid({
    year,
    month,
    byDay,
    selectedDay,
    onSelectDay: (key) => {
      selectedDay = key;
      render();
    },
    chipFor: (entry, key) =>
      applyCourseTheme(
        el('button', {
          class: 'cal-chip cal-chip--course',
          type: 'button',
          title: `${entry.title} — ${entry.classroomName} · ${timeText(entry)}`,
          text: entry.title,
          onClick: () => {
            selectedDay = key;
            render();
          },
        }),
        entry.classroomId,
      ),
  });

  nodes.root.replaceChildren(
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
    ]),

    grid,
    dayDetail(byDay.get(selectedDay) ?? [], dateFromKey(selectedDay)),

    data.upcoming.length > 0
      ? el('div', { class: 'stack' }, [
          el('h2', { class: 'card__title', text: 'Coming up' }),
          el('section', { class: 'card card--flush' }, data.upcoming.map((entry) =>
            el('a', {
              class: 'list-row cal-entry',
              href: `/classrooms/${entry.classroomId}#calendar`,
            }, [
              courseDot(entry.classroomId),
              el('div', { class: 'stack stack--tight list-row__main' }, [
                el('strong', { text: entry.title }),
                el('span', {
                  class: 'meta',
                  text: `${entry.classroomName} · ${formatDateTime(entry.startsAt)}`,
                }),
              ]),
              el('span', { class: 'spacer' }),
              el('span', {
                class: entry.kind === 'due' ? 'badge badge--draft' : 'badge',
                text: entry.derivedFrom === 'quiz' ? 'Quiz' : (KIND_LABEL[entry.kind] ?? entry.kind),
              }),
            ]),
          )),
        ])
      : null,

    // Only when the whole calendar is empty, not merely the month on screen --
    // paging into a quiet January should not say there is nothing at all.
    data.entries.length === 0 && data.upcoming.length === 0
      ? emptyState(
          'calendar',
          'Nothing scheduled',
          'Deadlines and classes from every course you are in will appear here.',
        )
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
    data = await api.myCalendar(from.toISOString(), to.toISOString());
    render();
  } catch (error) {
    showError(nodes.pageError, error.message);
  }
}

async function boot() {
  const user = await requireSession();
  if (!user) return;

  // No `current`: that labels the course switcher, and this page is not in a
  // course. It should read "Switch course", not "Calendar".
  renderHeader({ user });
  await refresh();
}

boot();
