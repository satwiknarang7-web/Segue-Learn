import { query, queryOne } from '../db/index.js';

/**
 * Announcements: one-way notices from teaching staff to a classroom.
 *
 * `published_at` null means draft, which is visible to staff and to nobody
 * else. Setting it is what publishes, and the value is the moment it went out
 * rather than the moment it was written -- a notice drafted on Monday and sent
 * on Friday is a Friday notice.
 *
 * The author is joined in, and survives that account being deleted: the row
 * keeps a null author_id rather than vanishing, so a departed teacher's
 * announcements stay readable.
 */

const fromRow = (row) =>
  row && {
    id: row.id,
    classroomId: row.classroom_id,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };

const COLUMNS = `a.id, a.classroom_id, a.author_id, a.title, a.body, a.pinned,
                 a.published_at, a.created_at, a.updated_at`;

const WITH_AUTHOR = `${COLUMNS}, u.name as author_name
                       from announcements a
                       left join users u on u.id = a.author_id`;

/**
 * Pinned first, then newest. A draft sorts by when it was written, so one just
 * started appears at the top where its author left it.
 */
const ORDER = 'order by a.pinned desc, coalesce(a.published_at, a.created_at) desc';

export const announcementRepository = {
  async findById(classroomId, id) {
    return fromRow(
      await queryOne(
        `select ${WITH_AUTHOR} where a.classroom_id = $1 and a.id = $2`,
        [classroomId, id],
      ),
    );
  },

  /** Everything in the classroom, drafts included. Staff only. */
  async listAll(classroomId) {
    const { rows } = await query(
      `select ${WITH_AUTHOR} where a.classroom_id = $1 ${ORDER}`,
      [classroomId],
    );
    return rows.map(fromRow);
  },

  /** Only what has actually been sent. What a student may read. */
  async listPublished(classroomId) {
    const { rows } = await query(
      `select ${WITH_AUTHOR}
        where a.classroom_id = $1 and a.published_at is not null ${ORDER}`,
      [classroomId],
    );
    return rows.map(fromRow);
  },

  async insert({ classroomId, authorId, title, body, pinned = false, publishedAt = null }) {
    const row = await queryOne(
      `insert into announcements (classroom_id, author_id, title, body, pinned, published_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [classroomId, authorId, title, body, pinned, publishedAt],
    );
    return announcementRepository.findById(classroomId, row.id);
  },

  /**
   * Only the fields that were given are touched. `publishedAt` and `pinned`
   * each need a "was it given" flag, because null and false are both real
   * values that coalesce would silently ignore.
   */
  async update(classroomId, id, patch) {
    const row = await queryOne(
      `update announcements
          set title        = coalesce($3, title),
              body         = coalesce($4, body),
              pinned       = case when $5::boolean then $6::boolean else pinned end,
              published_at = case when $7::boolean then $8::timestamptz else published_at end,
              updated_at   = now()
        where classroom_id = $1 and id = $2
      returning id`,
      [
        classroomId,
        id,
        patch.title ?? null,
        patch.body ?? null,
        patch.pinned !== undefined,
        patch.pinned ?? false,
        patch.publishedAt !== undefined,
        patch.publishedAt ?? null,
      ],
    );
    return row ? announcementRepository.findById(classroomId, row.id) : null;
  },

  async remove(classroomId, id) {
    const { rowCount } = await query(
      'delete from announcements where classroom_id = $1 and id = $2',
      [classroomId, id],
    );
    return rowCount > 0;
  },

  /** How many notices are waiting, for a badge on the tab. */
  async countPublished(classroomId) {
    const row = await queryOne(
      `select count(*)::int as n from announcements
        where classroom_id = $1 and published_at is not null`,
      [classroomId],
    );
    return row?.n ?? 0;
  },
};
