import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { accountService } from '../services/accountService.js';
import { classroomService } from '../services/classroomService.js';

/**
 * Everything under here needs a signed-in account, which app.js enforces with
 * `{ signedIn: true }` before the handler runs. Creating a classroom needs
 * more than that, so those routes ask for faculty themselves.
 */
export const classroomRoutes = new Router();

const signedIn = { signedIn: true };

classroomRoutes.get('/api/classrooms', ({ user }) => classroomService.listForUser(user), signedIn);

classroomRoutes.get(
  '/api/classrooms/public',
  ({ user }) => classroomService.listPublic(user),
  signedIn,
);

classroomRoutes.post(
  '/api/classrooms',
  async ({ req, res, body }) => {
    const user = await accountService.requireFaculty(req);
    const classroom = await classroomService.create(user, body ?? {});
    sendJson(res, 201, classroom);
  },
  signedIn,
);

/** Enrol by the code a teacher shared. */
classroomRoutes.post(
  '/api/classrooms/join',
  ({ user, body }) => classroomService.joinByCode(user, body?.code),
  signedIn,
);

classroomRoutes.get(
  '/api/classrooms/:classroomId',
  ({ user, params }) => classroomService.describe(user, params.classroomId),
  signedIn,
);

classroomRoutes.patch(
  '/api/classrooms/:classroomId',
  ({ user, params, body }) => classroomService.update(user, params.classroomId, body ?? {}),
  signedIn,
);

classroomRoutes.get(
  '/api/classrooms/:classroomId/members',
  ({ user, params }) => classroomService.roster(user, params.classroomId),
  signedIn,
);

classroomRoutes.delete(
  '/api/classrooms/:classroomId/members/:memberId',
  ({ user, params }) =>
    classroomService.removeMember(user, params.classroomId, params.memberId),
  signedIn,
);

classroomRoutes.post(
  '/api/classrooms/:classroomId/join-code',
  ({ user, params }) => classroomService.rotateJoinCode(user, params.classroomId),
  signedIn,
);

classroomRoutes.post(
  '/api/classrooms/:classroomId/archive',
  ({ user, params, body }) =>
    classroomService.setArchived(user, params.classroomId, body?.archived !== false),
  signedIn,
);
