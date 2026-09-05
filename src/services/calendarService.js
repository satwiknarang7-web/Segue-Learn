import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { asOptionalString, asString } from '../lib/validate.js';
import { calendarRepository } from '../repositories/calendarRepository.js';
import { classroomService } from './classroomService.js';

/**
 * The calendar.
 *
 * Anyone in the classroom may read it; teaching staff may add events. A due
 * date that comes from a quiz or a gradebook column is derived and read-only
 * here -- it is changed where it lives, and this refuses to pretend otherwise
 * rather than silently doing nothing.
 */

const KINDS = ['class', 'due', 'exam', 'office_hours', 'other'];
const MAX_UPCOMING = 10;

/** How far a request may ask for at once, so one call cannot scan a decade. */
const MAX_RANGE_DAYS = 400;

function parseWhen(value, field) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw badRequest(`"${field}" is not a date.`);
  return new Date(parsed).toISOString();
}

function parseEvent(payload, { partial = false } = {}) {
  const event = {};

  if (!partial || payload.title !== undefined) {
    event.title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
  }
  if (!partial || payload.description !== undefined) {
    event.description =
      asOptionalString(payload.description, 'description', {
        max: config.limits.descriptionMaxLength,
      }) ?? '';
  }
  if (!partial || payload.startsAt !== undefined) {
    event.startsAt = parseWhen(payload.startsAt, 'startsAt');
  }
  if (payload.endsAt !== undefined) {
    event.endsAt = payload.endsAt ? parseWhen(payload.endsAt, 'endsAt') : null;
  }
  if (payload.allDay !== undefined) event.allDay = payload.allDay === true;

  if (payload.kind !== undefined) {
    if (!KINDS.includes(payload.kind)) {
      throw badRequest(`"kind" must be one of: ${KINDS.join(', ')}.`);
    }
    event.kind = payload.kind;
  }

  if (event.endsAt && event.startsAt && Date.parse(event.endsAt) < Date.parse(event.startsAt)) {
    throw badRequest('An event cannot end before it starts.');
  }

  return event;
}

/** Entries the calendar shows but does not own. */
const isDerived = (entry) => entry.sourceType !== 'event';

function present(entry, { staff }) {
  return {
    ...entry,
    // Derived entries are changed at their source. Saying so here keeps the
    // page from offering an edit button that could not work.
    editable: staff && !isDerived(entry),
    derivedFrom: isDerived(entry) ? entry.sourceType : null,
  };
}

export const calendarService = {
  KINDS,

  /**
   * A window of the calendar, plus what is coming up next.
   *
   * `from` and `to` are whatever the page asks for -- normally the month it is
   * showing, widened to whole weeks so the grid's leading and trailing days are
   * filled in. The client sends the range because only it knows the reader's
   * time zone, and a month boundary is a local-time question.
   */
  async range(user, classroomId, { from, to } = {}) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = role === 'teacher' || role === 'ta' || user.platformRole === 'admin';

    const start = from ? parseWhen(from, 'from') : new Date().toISOString();
    const end = to
      ? parseWhen(to, 'to')
      : new Date(Date.parse(start) + 31 * 24 * 60 * 60 * 1000).toISOString();

    if (Date.parse(end) <= Date.parse(start)) {
      throw badRequest('"to" must be after "from".');
    }
    if (Date.parse(end) - Date.parse(start) > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
    }

    const [entries, upcoming] = await Promise.all([
      calendarRepository.listBetween(classroomId, start, end),
      calendarRepository.listUpcoming(classroomId, new Date().toISOString(), MAX_UPCOMING),
    ]);

    return {
      canEdit: staff,
      kinds: KINDS,
      from: start,
      to: end,
      entries: entries.map((entry) => present(entry, { staff })),
      upcoming: upcoming.map((entry) => present(entry, { staff })),
    };
  },

  async createEvent(user, classroomId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const event = parseEvent(payload);
    return calendarRepository.insertEvent({
      classroomId,
      createdBy: user.id,
      kind: 'other',
      ...event,
    });
  },

  async updateEvent(user, classroomId, eventId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const existing = await calendarRepository.findEvent(classroomId, eventId);
    // A quiz or gradebook due date has no row here, so this is also what
    // refuses an attempt to edit a derived entry through this endpoint.
    if (!existing) {
      throw notFound(
        'That event does not exist. A quiz or assessment deadline is changed where it is set, not here.',
      );
    }

    const patch = parseEvent(payload, { partial: true });

    // The ends-before-starts check needs whichever of the two is not changing.
    const startsAt = patch.startsAt ?? existing.startsAt;
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : existing.endsAt;
    if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      throw badRequest('An event cannot end before it starts.');
    }

    return calendarRepository.updateEvent(classroomId, eventId, patch);
  },

  async removeEvent(user, classroomId, eventId) {
    await classroomService.requireTeaching(user, classroomId);

    const removed = await calendarRepository.removeEvent(classroomId, eventId);
    if (!removed) {
      throw notFound(
        'That event does not exist. A quiz or assessment deadline is removed where it is set, not here.',
      );
    }
    return { removed: true };
  },
};
