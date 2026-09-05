import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { calendarService } from '../services/calendarService.js';

export const calendarRoutes = new Router();

const signedIn = { signedIn: true };
const base = '/api/classrooms/:classroomId/calendar';

/**
 * Everything due anywhere, across every classroom this person is in.
 *
 * Read-only: a deadline belongs to a course and is changed in that course, so
 * there are no write routes hanging off this one.
 */
calendarRoutes.get(
  '/api/calendar',
  ({ user, query }) =>
    calendarService.forUser(user, {
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
    }),
  signedIn,
);

/**
 * The window comes from the query string because only the browser knows the
 * reader's time zone, and "which month is this" is a local-time question.
 */
calendarRoutes.get(
  base,
  ({ user, params, query }) =>
    calendarService.range(user, params.classroomId, {
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
    }),
  signedIn,
);

calendarRoutes.post(
  `${base}/events`,
  async ({ user, params, body, res }) => {
    const event = await calendarService.createEvent(user, params.classroomId, body ?? {});
    sendJson(res, 201, event);
  },
  signedIn,
);

calendarRoutes.patch(
  `${base}/events/:eventId`,
  ({ user, params, body }) =>
    calendarService.updateEvent(user, params.classroomId, params.eventId, body ?? {}),
  signedIn,
);

calendarRoutes.delete(
  `${base}/events/:eventId`,
  ({ user, params }) => calendarService.removeEvent(user, params.classroomId, params.eventId),
  signedIn,
);
