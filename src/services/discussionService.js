import { config } from '../config.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { asString } from '../lib/validate.js';
import { discussionRepository } from '../repositories/discussionRepository.js';
import { classroomService } from './classroomService.js';

/**
 * Discussions: the two-way counterpart to Announcements.
 *
 * Anyone in the classroom may start a thread and reply. Teaching staff may
 * pin, lock, and remove anything; everybody else may edit and remove their
 * own posts and nothing else.
 *
 * Replies nest one level below a top-level reply and no further. Unlimited
 * threading is unreadable on a phone and turns a seminar into a forum, so a
 * reply to something already two deep is folded up to sit beside it rather
 * than refused -- the person still gets to say their piece.
 */

const MAX_BODY = 10_000;
const MAX_DEPTH = 2;

function parseBody(value) {
  const body = asString(value, 'body', { max: MAX_BODY });
  if (body.trim() === '') throw badRequest('A post needs something in it.');
  return body;
}

const isStaff = (role, user) =>
  role === 'teacher' || role === 'ta' || user.platformRole === 'admin';

/** How far below the opening post a post sits. The opener is 0. */
function depthOf(post, byId) {
  let depth = 0;
  let current = post;
  while (current?.parentId) {
    depth += 1;
    current = byId.get(current.parentId);
    if (depth > 10) break; // defensive; the cap keeps real data far below this
  }
  return depth;
}

function presentPost(post, { user, staff }) {
  return {
    id: post.id,
    parentId: post.parentId,
    author: post.deleted ? null : (post.authorName ?? 'A former member'),
    body: post.body,
    deleted: post.deleted,
    edited: post.edited,
    createdAt: post.createdAt,
    editedAt: post.editedAt,
    // What this person may do with it, decided here rather than guessed by
    // the page.
    canEdit: !post.deleted && post.authorId === user.id,
    canRemove: !post.deleted && (post.authorId === user.id || staff),
  };
}

function presentThread(thread, { user, staff }) {
  return {
    id: thread.id,
    title: thread.title,
    author: thread.authorName ?? 'A former member',
    locked: thread.locked,
    pinned: thread.pinned,
    postCount: thread.postCount,
    lastActivityAt: thread.lastActivityAt ?? thread.createdAt,
    createdAt: thread.createdAt,
    canModerate: staff,
    // The author's own right to delete lapses once it is locked or somebody
    // else has replied -- see removeThread. In the list only the post count is
    // to hand, so "one post" stands in for "nobody else has spoken"; a thread
    // the author replied to themselves reads as not-deletable here and is
    // corrected by readThread, which never offers a button that would fail.
    canRemove:
      staff || (thread.authorId === user.id && !thread.locked && thread.postCount === 1),
  };
}

export const discussionService = {
  async listThreads(user, classroomId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = isStaff(role, user);

    const threads = await discussionRepository.listThreads(classroomId);
    return {
      canModerate: staff,
      threads: threads.map((thread) => presentThread(thread, { user, staff })),
    };
  },

  /** One thread with its posts, as a tree the page can render directly. */
  async readThread(user, classroomId, threadId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = isStaff(role, user);

    const thread = await discussionRepository.findThread(classroomId, threadId);
    if (!thread) throw notFound('That discussion does not exist.');

    const posts = await discussionRepository.listPosts(threadId);

    const presented = posts.map((post) => ({
      ...presentPost(post, { user, staff }),
      replies: [],
    }));
    const byId = new Map(presented.map((post) => [post.id, post]));

    let opening = null;
    const replies = [];

    // Two levels, so the tree is built by asking only whether a post's parent
    // is the opener.
    for (const post of presented) {
      if (post.parentId === null) {
        opening = post;
        continue;
      }
      const parent = byId.get(post.parentId);
      if (!parent) continue;
      if (parent.parentId === null) replies.push(post);
      else parent.replies.push(post);
    }

    const fromOthers = posts.some(
      (post) => !post.deleted && post.authorId && post.authorId !== user.id,
    );

    return {
      ...presentThread(thread, { user, staff }),
      // Counted from the posts already in hand. findThread does not carry a
      // count the way the list query does, and a second query for a number we
      // are holding would be waste.
      postCount: posts.filter((post) => !post.deleted).length,
      // The exact answer, which the list can only approximate.
      canRemove:
        staff || (thread.authorId === user.id && !thread.locked && !fromOthers),
      // Staff can still post in a locked thread, to close it with a word.
      canPost: !thread.locked || staff,
      opening,
      replies,
    };
  },

  async createThread(user, classroomId, payload = {}) {
    const { role, classroom } = await classroomService.requireAccess(user, classroomId);
    if (classroom.archivedAt) throw conflict('That classroom is archived.');

    const title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    const body = parseBody(payload.body);

    // Only staff may open a thread already pinned.
    const pinned = payload.pinned === true && isStaff(role, user);

    const threadId = await discussionRepository.createThread({
      classroomId,
      authorId: user.id,
      title,
      body,
      pinned,
    });

    return discussionService.readThread(user, classroomId, threadId);
  },

  /**
   * Replies to a post, or to the thread when no parent is named.
   *
   * A reply aimed at something already at the cap is attached beside it
   * instead, so the conversation stays two levels deep however people click.
   */
  async reply(user, classroomId, threadId, payload = {}) {
    const { role, classroom, isMember } = await classroomService.requireAccess(user, classroomId);
    const staff = isStaff(role, user);

    if (!isMember) throw new HttpError(403, 'Join this classroom to take part.');
    if (classroom.archivedAt) throw conflict('That classroom is archived.');

    const thread = await discussionRepository.findThread(classroomId, threadId);
    if (!thread) throw notFound('That discussion does not exist.');
    if (thread.locked && !staff) throw conflict('This discussion is closed.');

    const body = parseBody(payload.body);

    const posts = await discussionRepository.listPosts(threadId);
    const byId = new Map(posts.map((post) => [post.id, post]));
    const opening = posts.find((post) => post.parentId === null);

    let parentId = opening?.id ?? null;

    if (payload.parentId) {
      const target = byId.get(payload.parentId);
      if (!target) throw notFound('That post does not exist.');

      const depth = depthOf(target, byId);
      // Replying to the opener gives depth 1; to a depth-1 post gives depth 2;
      // anything deeper is folded up to sit beside its target.
      parentId = depth >= MAX_DEPTH ? target.parentId : target.id;
    }

    await discussionRepository.addPost({ threadId, parentId, authorId: user.id, body });
    return discussionService.readThread(user, classroomId, threadId);
  },

  async editPost(user, classroomId, threadId, postId, payload = {}) {
    await classroomService.requireAccess(user, classroomId);

    const post = await discussionRepository.findPost(postId);
    if (!post || post.threadId !== threadId) throw notFound('That post does not exist.');
    if (post.deleted) throw conflict('That post was removed.');

    // Editing is the author's alone. Staff may remove a post but never put
    // words in somebody's mouth.
    if (post.authorId !== user.id) {
      throw new HttpError(403, 'You can only edit your own posts.');
    }

    await discussionRepository.editPost(postId, parseBody(payload.body));
    return discussionService.readThread(user, classroomId, threadId);
  },

  async removePost(user, classroomId, threadId, postId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = isStaff(role, user);

    const post = await discussionRepository.findPost(postId);
    if (!post || post.threadId !== threadId) throw notFound('That post does not exist.');

    if (post.authorId !== user.id && !staff) {
      throw new HttpError(403, 'You can only remove your own posts.');
    }

    if (post.parentId === null) {
      throw badRequest('That is the post that opened the discussion. Delete the discussion instead.');
    }

    await discussionRepository.removePost(postId);
    return discussionService.readThread(user, classroomId, threadId);
  },

  /** Pinning, locking and renaming are staff-only. */
  async updateThread(user, classroomId, threadId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const thread = await discussionRepository.findThread(classroomId, threadId);
    if (!thread) throw notFound('That discussion does not exist.');

    const patch = {};
    if (payload.title !== undefined) {
      patch.title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    }
    if (payload.locked !== undefined) patch.locked = payload.locked === true;
    if (payload.pinned !== undefined) patch.pinned = payload.pinned === true;

    await discussionRepository.updateThread(classroomId, threadId, patch);
    return discussionService.readThread(user, classroomId, threadId);
  },

  /**
   * Staff may delete any thread. The author may delete their own, but only
   * while it is still theirs alone to delete:
   *
   * once somebody else has replied, deleting it would destroy their words as
   * well; and once staff have closed it, deleting it would undo the
   * moderation. Neither is the author's to decide.
   */
  async removeThread(user, classroomId, threadId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = isStaff(role, user);

    const thread = await discussionRepository.findThread(classroomId, threadId);
    if (!thread) throw notFound('That discussion does not exist.');

    if (!staff) {
      if (thread.authorId !== user.id) {
        throw new HttpError(403, 'You can only delete your own discussions.');
      }
      if (thread.locked) {
        throw conflict('A member of staff closed this discussion, so it cannot be deleted.');
      }

      const posts = await discussionRepository.listPosts(threadId);
      const fromOthers = posts.some(
        (post) => !post.deleted && post.authorId && post.authorId !== user.id,
      );
      if (fromOthers) {
        throw conflict(
          'Others have replied, so this can no longer be deleted. Remove your own post instead.',
        );
      }
    }

    await discussionRepository.removeThread(classroomId, threadId);
    return { removed: true };
  },
};
