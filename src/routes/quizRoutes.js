import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { attemptService } from '../services/attemptService.js';
import { quizService } from '../services/quizService.js';

/**
 * Quizzes live under the classroom that owns them, so the classroom id is in
 * every path and every service call re-checks it. Nothing here trusts a quiz
 * id on its own.
 *
 * Attempt routes are the exception: they hang off /api/attempts because the
 * attempt itself proves who the caller is. See attemptService.requireOwnAttempt.
 */
export const quizRoutes = new Router();

const signedIn = { signedIn: true };
const base = '/api/classrooms/:classroomId/quizzes';

/* ---- The quiz list and one quiz ----------------------------------------- */

quizRoutes.get(
  base,
  ({ user, params }) => quizService.listForClassroom(user, params.classroomId),
  signedIn,
);

quizRoutes.post(
  base,
  async ({ user, params, body, res }) => {
    const quiz = await quizService.create(user, params.classroomId, body ?? {});
    sendJson(res, 201, quiz);
  },
  signedIn,
);

/**
 * The full quiz, answer key and all. Teaching staff only -- a student reaches
 * a quiz through the participant view, which has no correct answers in it.
 */
quizRoutes.get(
  `${base}/:quizId`,
  ({ user, params }) => quizService.requireWritable(user, params.classroomId, params.quizId),
  signedIn,
);

quizRoutes.patch(
  `${base}/:quizId`,
  ({ user, params, body }) =>
    quizService.update(user, params.classroomId, params.quizId, body ?? {}),
  signedIn,
);

quizRoutes.delete(
  `${base}/:quizId`,
  ({ user, params }) => quizService.remove(user, params.classroomId, params.quizId),
  signedIn,
);

/* ---- Questions ----------------------------------------------------------- */

quizRoutes.post(
  `${base}/:quizId/questions`,
  async ({ user, params, body, res }) => {
    const quiz = await quizService.addQuestion(user, params.classroomId, params.quizId, body ?? {});
    sendJson(res, 201, quiz);
  },
  signedIn,
);

/** All or nothing; `dryRun` previews without saving. */
quizRoutes.post(
  `${base}/:quizId/questions/bulk`,
  ({ user, params, body }) =>
    quizService.addQuestionsFromText(user, params.classroomId, params.quizId, body?.text, {
      dryRun: body?.dryRun === true,
    }),
  signedIn,
);

quizRoutes.put(
  `${base}/:quizId/questions/:questionId`,
  ({ user, params, body }) =>
    quizService.updateQuestion(
      user,
      params.classroomId,
      params.quizId,
      params.questionId,
      body ?? {},
    ),
  signedIn,
);

quizRoutes.delete(
  `${base}/:quizId/questions/:questionId`,
  ({ user, params }) =>
    quizService.removeQuestion(user, params.classroomId, params.quizId, params.questionId),
  signedIn,
);

quizRoutes.post(
  `${base}/:quizId/questions/:questionId/move`,
  ({ user, params, body }) =>
    quizService.moveQuestion(
      user,
      params.classroomId,
      params.quizId,
      params.questionId,
      body?.direction,
    ),
  signedIn,
);

/* ---- Taking -------------------------------------------------------------- */

quizRoutes.post(
  `${base}/:quizId/attempts`,
  async ({ user, params, body, res }) => {
    const started = await attemptService.start(user, params.classroomId, params.quizId);
    sendJson(res, started.resumed ? 200 : 201, started);
  },
  signedIn,
);

/**
 * Registered before /attempts/:attemptId, because "mine" would otherwise be
 * read as an attempt id.
 */
quizRoutes.get(
  `${base}/:quizId/attempts/mine`,
  ({ user, params }) => attemptService.listOwn(user, params.classroomId, params.quizId),
  signedIn,
);

/* ---- Staff views --------------------------------------------------------- */

quizRoutes.get(
  `${base}/:quizId/results`,
  ({ user, params }) => attemptService.results(user, params.classroomId, params.quizId),
  signedIn,
);

quizRoutes.delete(
  `${base}/:quizId/results`,
  ({ user, params }) => attemptService.clearResults(user, params.classroomId, params.quizId),
  signedIn,
);

quizRoutes.get(
  `${base}/:quizId/attempts/:attemptId`,
  ({ user, params }) =>
    attemptService.reviewAttempt(user, params.classroomId, params.quizId, params.attemptId),
  signedIn,
);

quizRoutes.delete(
  `${base}/:quizId/attempts/:attemptId`,
  ({ user, params }) =>
    attemptService.removeAttempt(user, params.classroomId, params.quizId, params.attemptId),
  signedIn,
);

/** A code and QR for running the quiz live, generated on first ask. */
quizRoutes.post(
  `${base}/:quizId/join-code`,
  ({ user, params }) => quizService.ensureJoinCode(user, params.classroomId, params.quizId),
  signedIn,
);
