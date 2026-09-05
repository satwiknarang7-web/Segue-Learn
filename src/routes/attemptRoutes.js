import { Router } from '../lib/router.js';
import { attemptService } from '../services/attemptService.js';

/**
 * An attempt in flight.
 *
 * These sit outside the classroom path on purpose: the attempt id is what the
 * page holds while somebody is taking a quiz, and every handler here re-checks
 * that the attempt belongs to the signed-in student before touching it.
 */
export const attemptRoutes = new Router();

const signedIn = { signedIn: true };

attemptRoutes.get(
  '/api/attempts/:attemptId',
  ({ user, params }) => attemptService.getState(user, params.attemptId),
  signedIn,
);

/** Autosave, so a closed tab does not lose the whole attempt. */
attemptRoutes.post(
  '/api/attempts/:attemptId/answers',
  ({ user, params, body }) => attemptService.saveAnswer(user, params.attemptId, body ?? {}),
  signedIn,
);

attemptRoutes.post(
  '/api/attempts/:attemptId/submit',
  ({ user, params, body }) => attemptService.submit(user, params.attemptId, body ?? {}),
  signedIn,
);

/** The student left the page and the quiz does not allow that. */
attemptRoutes.post(
  '/api/attempts/:attemptId/abandon',
  ({ user, params }) => attemptService.abandon(user, params.attemptId),
  signedIn,
);
