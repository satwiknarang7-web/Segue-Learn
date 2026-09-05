import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { gradebookService } from '../services/gradebookService.js';

export const gradebookRoutes = new Router();

const signedIn = { signedIn: true };
const base = '/api/classrooms/:classroomId/gradebook';

/** The whole grid for staff; a student's own row for a student. */
gradebookRoutes.get(base, ({ user, params }) => gradebookService.grid(user, params.classroomId), signedIn);

/**
 * Registered before /columns/:itemId, so "available-quizzes" is not read as a
 * column id.
 */
gradebookRoutes.get(
  `${base}/available-quizzes`,
  ({ user, params }) => gradebookService.availableQuizzes(user, params.classroomId),
  signedIn,
);

gradebookRoutes.post(
  `${base}/columns`,
  async ({ user, params, body, res }) => {
    // One endpoint, two kinds of column: a quizId makes it quiz-backed.
    const column = body?.quizId
      ? await gradebookService.addQuizColumn(user, params.classroomId, body.quizId)
      : await gradebookService.createManualColumn(user, params.classroomId, body ?? {});
    sendJson(res, 201, column);
  },
  signedIn,
);

gradebookRoutes.patch(
  `${base}/columns/:itemId`,
  ({ user, params, body }) =>
    gradebookService.updateColumn(user, params.classroomId, params.itemId, body ?? {}),
  signedIn,
);

gradebookRoutes.delete(
  `${base}/columns/:itemId`,
  ({ user, params }) => gradebookService.removeColumn(user, params.classroomId, params.itemId),
  signedIn,
);

gradebookRoutes.put(
  `${base}/columns/:itemId/grades/:studentId`,
  ({ user, params, body }) =>
    gradebookService.setGrade(
      user,
      params.classroomId,
      params.itemId,
      params.studentId,
      body ?? {},
    ),
  signedIn,
);

gradebookRoutes.delete(
  `${base}/columns/:itemId/grades/:studentId`,
  ({ user, params }) =>
    gradebookService.clearGrade(user, params.classroomId, params.itemId, params.studentId),
  signedIn,
);
