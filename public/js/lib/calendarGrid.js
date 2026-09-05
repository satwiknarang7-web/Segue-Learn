import { el } from '../api.js';

/**
 * The month grid, shared by the classroom calendar and the cross-course one.
 *
 * Every date decision here is made in local time. The browser is the only
 * party that knows the reader's zone, so it works out which six weeks it is
 * showing and asks the server for exactly that window. Bucketing by local day
 * matters for the same reason: "which day is this on" is a local question, and
 * an event at 23:00 belongs to the day the reader calls it.
 */

/** Monday-first, which is what most of the world's timetables use. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A stable key for "which local day is this", used to bucket entries. */
export const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

export const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Monday of the week containing `date`. */
export function startOfWeek(date) {
  const day = startOfDay(date);
  // getDay() is Sunday-first; shift so Monday is 0.
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

/** The six-week window a month grid actually shows. */
export function gridRange(year, month) {
  const from = startOfWeek(new Date(year, month, 1));
  const to = new Date(from);
  to.setDate(to.getDate() + 42);
  return { from, to };
}

/** A day key back to the Date it names, at local midnight. */
export const dateFromKey = (key) => new Date(`${key}T00:00:00`);

export function timeText(entry) {
  if (entry.allDay) return 'All day';
  const start = new Date(entry.startsAt);
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!entry.endsAt || entry.endsAt === entry.startsAt) return time;
  const end = new Date(entry.endsAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${time} – ${end}`;
}

/** Entries grouped by the local day they fall on. */
export function bucketByDay(entries) {
  const byDay = new Map();
  for (const entry of entries) {
    const key = dayKey(new Date(entry.startsAt));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(entry);
  }
  return byDay;
}

/**
 * Six weeks of cells.
 *
 * `chipFor` builds whatever each caller wants inside a day -- the classroom
 * calendar colours by kind, the cross-course one by course -- so the grid
 * itself stays about dates and knows nothing about entries.
 */
export function renderMonthGrid({
  year,
  month,
  byDay,
  selectedDay,
  onSelectDay,
  chipFor,
  maxChips = 3,
}) {
  const { from } = gridRange(year, month);
  const todayKey = dayKey(new Date());

  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(from);
    date.setDate(date.getDate() + index);

    const key = dayKey(date);
    const entries = byDay.get(key) ?? [];

    cells.push(
      el(
        'div',
        {
          class: 'cal-day',
          dataset: {
            outside: String(date.getMonth() !== month),
            today: String(key === todayKey),
            selected: String(key === selectedDay),
          },
        },
        [
          el('button', {
            class: 'cal-day__number',
            type: 'button',
            text: String(date.getDate()),
            'aria-label': date.toLocaleDateString(undefined, { dateStyle: 'full' }),
            onClick: () => onSelectDay(key),
          }),
          el(
            'div',
            { class: 'cal-day__entries' },
            // Only a few fit before the cell has to say "more"; a taller cell
            // on a phone would push the rest of the month off screen.
            entries.slice(0, maxChips).map((entry) => chipFor(entry, key)),
          ),
          entries.length > maxChips
            ? el('span', {
                class: 'cal-day__more',
                text: `+${entries.length - maxChips} more`,
              })
            : null,
        ],
      ),
    );
  }

  return el('div', { class: 'cal-grid' }, [
    ...WEEKDAYS.map((day) => el('div', { class: 'cal-weekday', text: day })),
    ...cells,
  ]);
}
