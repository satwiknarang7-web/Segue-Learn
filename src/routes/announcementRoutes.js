import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { announcementService } from '../services/announcementService.js';

export const announcementRoutes = new Router();

const signedIn = { signedIn: true };
const base = '/api/classrooms/:classroomId/announcements';

/** Staff see drafts too; a student is sent only what has been published. */
announcementRoutes.get(
  base,
  ({ user, params }) => announcementService.list(user, params.classroomId),
  signedIn,
);

announcementRoutes.post(
  base,
  async ({ user, params, body, res }) => {
    const announcement = await announcementService.create(user, params.classroomId, body ?? {});
    sendJson(res, 201, announcement);
  },
  signedIn,
);

announcementRoutes.patch(
  `${base}/:announcementId`,
  ({ user, params, body }) =>
    announcementService.update(user, params.classroomId, params.announcementId, body ?? {}),
  signedIn,
);

announcementRoutes.delete(
  `${base}/:announcementId`,
  ({ user, params }) =>
    announcementService.remove(user, params.classroomId, params.announcementId),
  signedIn,
);
