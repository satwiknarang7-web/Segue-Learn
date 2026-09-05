import { query, queryOne, transaction } from '../db/index.js';

/**
 * Discussion threads and the posts in them.
 *
 * A thread always has at least one post: the one that opened it, written in
 * the same transaction so a thread with nothing to read cannot exist.
 *
 * Posts are soft-deleted. Removing one that has replies must not take them
 * with it, and a reply whose parent vanished reads as nonsense, so the row
 * stays and its body stops being served.
 *
 * "Last activity" is read from the posts rather than stamped onto the thread.
 * Bumping a column on every reply would be a second write on the hottest path
 * for no gain, and max(created_at) is the same answer.
 */

const threadFromRow = (row) =>
  row && {
    id: row.id,
    classroomId: row.classroom_id,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    title: row.title,
    locked: row.locked,
    pinned: row.pinned,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    // Present on the list query only.
    ...(row.post_count === undefined ? {} : { postCount: row.post_count }),
    ...(row.last_activity_at
      ? { lastActivityAt: new Date(row.last_activity_at).toISOString() }
      : {}),
  };

const postFromRow = (row) =>
  row && {
    id: row.id,
    threadId: row.thread_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    // A removed post keeps its row so replies stay coherent; the body is not
    // served, so it cannot be recovered from the wire.
    body: row.deleted_at ? null : row.body,
    deleted: row.deleted_at !== null,
    edited: row.edited_at !== null,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
  };

const THREAD_COLUMNS = `t.id, t.classroom_id, t.author_id, t.title, t.locked, t.pinned,
                        t.created_at, t.updated_at`;

const POST_COLUMNS = `p.id, p.thread_id, p.parent_id, p.author_id, p.body,
                      p.edited_at, p.deleted_at, p.created_at`;

export const discussionRepository = {
  /** The thread list, with a post count and when it was last active. */
  async listThreads(classroomId) {
    const { rows } = await query(
      `select ${THREAD_COLUMNS}, u.name as author_name,
              coalesce(s.post_count, 0)::int as post_count,
              s.last_activity_at
         from discussion_threads t
         left join users u on u.id = t.author_id
         left join (
           select thread_id,
                  count(*) filter (where deleted_at is null) as post_count,
                  max(created_at) as last_activity_at
             from discussion_posts
            group by thread_id
         ) s on s.thread_id = t.id
        where t.classroom_id = $1
        order by t.pinned desc, coalesce(s.last_activity_at, t.created_at) desc`,
      [classroomId],
    );
    return rows.map(threadFromRow);
  },

  async findThread(classroomId, threadId) {
    return threadFromRow(
      await queryOne(
        `select ${THREAD_COLUMNS}, u.name as author_name
           from discussion_threads t
           left join users u on u.id = t.author_id
          where t.classroom_id = $1 and t.id = $2`,
        [classroomId, threadId],
      ),
    );
  },

  /** Every post in a thread, oldest first. The caller builds the tree. */
  async listPosts(threadId) {
    const { rows } = await query(
      `select ${POST_COLUMNS}, u.name as author_name
         from discussion_posts p
         left join users u on u.id = p.author_id
        where p.thread_id = $1
        order by p.created_at`,
      [threadId],
    );
    return rows.map(postFromRow);
  },

  async findPost(postId) {
    return postFromRow(
      await queryOne(
        `select ${POST_COLUMNS}, u.name as author_name
           from discussion_posts p
           left join users u on u.id = p.author_id
          where p.id = $1`,
        [postId],
      ),
    );
  },

  /**
   * Opens a thread and writes its first post together, so a thread with
   * nothing in it is not a state this table can reach.
   */
  async createThread({ classroomId, authorId, title, body, pinned = false }) {
    return transaction(async (tx) => {
      const thread = await tx.query(
        `insert into discussion_threads (classroom_id, author_id, title, pinned)
         values ($1, $2, $3, $4)
         returning id`,
        [classroomId, authorId, title, pinned],
      );
      const threadId = thread.rows[0].id;

      await tx.query(
        `insert into discussion_posts (thread_id, parent_id, author_id, body)
         values ($1, null, $2, $3)`,
        [threadId, authorId, body],
      );

      return threadId;
    });
  },

  async updateThread(classroomId, threadId, patch) {
    const row = await queryOne(
      `update discussion_threads
          set title      = coalesce($3, title),
              locked     = case when $4::boolean then $5::boolean else locked end,
              pinned     = case when $6::boolean then $7::boolean else pinned end,
              updated_at = now()
        where classroom_id = $1 and id = $2
      returning id`,
      [
        classroomId,
        threadId,
        patch.title ?? null,
        patch.locked !== undefined,
        patch.locked ?? false,
        patch.pinned !== undefined,
        patch.pinned ?? false,
      ],
    );
    return row ? discussionRepository.findThread(classroomId, threadId) : null;
  },

  async removeThread(classroomId, threadId) {
    const { rowCount } = await query(
      'delete from discussion_threads where classroom_id = $1 and id = $2',
      [classroomId, threadId],
    );
    return rowCount > 0;
  },

  async addPost({ threadId, parentId = null, authorId, body }) {
    const row = await queryOne(
      `insert into discussion_posts (thread_id, parent_id, author_id, body)
       values ($1, $2, $3, $4)
       returning id`,
      [threadId, parentId, authorId, body],
    );
    return discussionRepository.findPost(row.id);
  },

  async editPost(postId, body) {
    const row = await queryOne(
      `update discussion_posts
          set body = $2, edited_at = now()
        where id = $1 and deleted_at is null
      returning id`,
      [postId, body],
    );
    return row ? discussionRepository.findPost(row.id) : null;
  },

  /** Soft delete: the row stays so any replies to it still make sense. */
  async removePost(postId) {
    const { rowCount } = await query(
      'update discussion_posts set deleted_at = now() where id = $1 and deleted_at is null',
      [postId],
    );
    return rowCount > 0;
  },

  /**
   * The post that opened the thread.
   *
   * Exactly one post per thread has a null parent, and it is this one. Every
   * reply carries a parent -- a reply "to the thread" is stored as a reply to
   * the opening post -- so a null parent is never ambiguous.
   */
  async findOpeningPost(threadId) {
    return postFromRow(
      await queryOne(
        `select ${POST_COLUMNS}, u.name as author_name
           from discussion_posts p
           left join users u on u.id = p.author_id
          where p.thread_id = $1 and p.parent_id is null`,
        [threadId],
      ),
    );
  },
};
