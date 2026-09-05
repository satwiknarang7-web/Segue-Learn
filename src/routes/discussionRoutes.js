import { sendJson } from '../lib/http.js';
import { Router } from '../lib/router.js';
import { discussionService } from '../services/discussionService.js';

/**
 * Every write returns the whole thread rather than the one post that changed.
 * A discussion is read as a tree, and re-sending it keeps the page and the
 * server from disagreeing about where a reply landed -- which matters here,
 * because the server may fold a reply up a level.
 */
export const discussionRoutes = new Router();

const signedIn = { signedIn: true };
const base = '/api/classrooms/:classroomId/discussions';

discussionRoutes.get(
  base,
  ({ user, params }) => discussionService.listThreads(user, params.classroomId),
  signedIn,
);

discussionRoutes.post(
  base,
  async ({ user, params, body, res }) => {
    const thread = await discussionService.createThread(user, params.classroomId, body ?? {});
    sendJson(res, 201, thread);
  },
  signedIn,
);

discussionRoutes.get(
  `${base}/:threadId`,
  ({ user, params }) => discussionService.readThread(user, params.classroomId, params.threadId),
  signedIn,
);

/** Pinning, locking and renaming. Teaching staff only. */
discussionRoutes.patch(
  `${base}/:threadId`,
  ({ user, params, body }) =>
    discussionService.updateThread(user, params.classroomId, params.threadId, body ?? {}),
  signedIn,
);

discussionRoutes.delete(
  `${base}/:threadId`,
  ({ user, params }) => discussionService.removeThread(user, params.classroomId, params.threadId),
  signedIn,
);

/** A reply to the thread, or to a post within it when parentId is given. */
discussionRoutes.post(
  `${base}/:threadId/posts`,
  async ({ user, params, body, res }) => {
    const thread = await discussionService.reply(
      user,
      params.classroomId,
      params.threadId,
      body ?? {},
    );
    sendJson(res, 201, thread);
  },
  signedIn,
);

discussionRoutes.patch(
  `${base}/:threadId/posts/:postId`,
  ({ user, params, body }) =>
    discussionService.editPost(
      user,
      params.classroomId,
      params.threadId,
      params.postId,
      body ?? {},
    ),
  signedIn,
);

discussionRoutes.delete(
  `${base}/:threadId/posts/:postId`,
  ({ user, params }) =>
    discussionService.removePost(user, params.classroomId, params.threadId, params.postId),
  signedIn,
);
