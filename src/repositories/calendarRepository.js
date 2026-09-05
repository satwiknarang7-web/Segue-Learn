import { query, queryOne } from '../db/index.js';

/**
 * The calendar.
 *
 * Reads come from the classroom_calendar view, which unions hand-made events
 * with the due dates of published quizzes and of gradebook columns. Nothing is
 * copied: moving a quiz's due date moves its calendar entry by definition, so
 * the two cannot drift apart.
 *
 * Writes only ever touch calendar_events. A derived entry is edited where it
 * comes from -- in the quiz, or in the gradebook -- and the service refuses to
 * pretend otherwise.
 */

const entryFromRow = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description ?? '',
  startsAt: new Date(row.starts_at).toISOString(),
  endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
  allDay: row.all_day,
  kind: row.kind,
  // 'event' is editable here; 'quiz' and 'assessment' are derived.
  sourceType: row.source_type,
  sourceId: row.source_id,
});

const eventFromRow = (row) =>
  row && {
    id: row.id,
    classroomId: row.classroom_id,
    title: row.title,
    description: row.description ?? '',
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    allDay: row.all_day,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };

const EVENT_COLUMNS = `id, classroom_id, title, description, starts_at, ends_at,
                       all_day, kind, created_by, created_at`;

export const calendarRepository = {
  /**
   * Everything in a window, oldest first.
   *
   * The range is half-open: an event starting exactly at `to` belongs to the
   * next window, which is what stops the last day of a month appearing twice
   * when a caller pages through.
   */
  async listBetween(classroomId, from, to) {
    const { rows } = await query(
      `select id, classroom_id, title, starts_at, ends_at, all_day, kind,
              source_type, source_id, description
         from classroom_calendar
        where classroom_id = $1 and starts_at >= $2 and starts_at < $3
        order by starts_at`,
      [classroomId, from, to],
    );
    return rows.map(entryFromRow);
  },

  /** The next few things coming up, for the panel beside the month. */
  async listUpcoming(classroomId, from, limit) {
    const { rows } = await query(
      `select id, classroom_id, title, starts_at, ends_at, all_day, kind,
              source_type, source_id, description
         from classroom_calendar
        where classroom_id = $1 and starts_at >= $2
        order by starts_at
        limit $3`,
      [classroomId, from, limit],
    );
    return rows.map(entryFromRow);
  },

  /**
   * Everything across every classroom this person is in.
   *
   * Archived classrooms are left out: their deadlines have been and gone, and
   * a finished course crowding this term's calendar is noise.
   *
   * Scoped by university as well as by membership. Membership alone would be
   * enough, but the tenant boundary is the one thing this product cannot get
   * wrong, so it is stated rather than implied.
   */
  async listForUserBetween(universityId, userId, from, to) {
    const { rows } = await query(
      `select cal.id, cal.classroom_id, cal.title, cal.starts_at, cal.ends_at,
              cal.all_day, cal.kind, cal.source_type, cal.source_id, cal.description,
              room.name as classroom_name
         from classroom_calendar cal
         join classrooms room on room.id = cal.classroom_id
         join classroom_members member
           on member.classroom_id = cal.classroom_id and member.user_id = $2
        where room.university_id = $1
          and room.archived_at is null
          and cal.starts_at >= $3
          and cal.starts_at < $4
        order by cal.starts_at`,
      [universityId, userId, from, to],
    );
    return rows.map((row) => ({
      ...entryFromRow(row),
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
    }));
  },

  /** The next few things due anywhere, for the panel beside the month. */
  async listUpcomingForUser(universityId, userId, from, limit) {
    const { rows } = await query(
      `select cal.id, cal.classroom_id, cal.title, cal.starts_at, cal.ends_at,
              cal.all_day, cal.kind, cal.source_type, cal.source_id, cal.description,
              room.name as classroom_name
         from classroom_calendar cal
         join classrooms room on room.id = cal.classroom_id
         join classroom_members member
           on member.classroom_id = cal.classroom_id and member.user_id = $2
        where room.university_id = $1
          and room.archived_at is null
          and cal.starts_at >= $3
        order by cal.starts_at
        limit $4`,
      [universityId, userId, from, limit],
    );
    return rows.map((row) => ({
      ...entryFromRow(row),
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
    }));
  },

  async findEvent(classroomId, id) {
    return eventFromRow(
      await queryOne(
        `select ${EVENT_COLUMNS} from calendar_events where classroom_id = $1 and id = $2`,
        [classroomId, id],
      ),
    );
  },

  async insertEvent(event) {
    return eventFromRow(
      await queryOne(
        `insert into calendar_events (classroom_id, title, description, starts_at, ends_at,
                                      all_day, kind, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${EVENT_COLUMNS}`,
        [
          event.classroomId,
          event.title,
          event.description ?? '',
          event.startsAt,
          event.endsAt ?? null,
          event.allDay ?? false,
          event.kind ?? 'other',
          event.createdBy ?? null,
        ],
      ),
    );
  },

  async updateEvent(classroomId, id, patch) {
    return eventFromRow(
      await queryOne(
        `update calendar_events
            set title       = coalesce($3, title),
                description = coalesce($4, description),
                starts_at   = coalesce($5, starts_at),
                -- ends_at and all_day are clearable, so "given" has to be
                -- distinguishable from "null", which coalesce cannot express.
                ends_at     = case when $6::boolean then $7::timestamptz else ends_at end,
                all_day     = case when $8::boolean then $9::boolean else all_day end,
                kind        = coalesce($10, kind)
          where classroom_id = $1 and id = $2
        returning ${EVENT_COLUMNS}`,
        [
          classroomId,
          id,
          patch.title ?? null,
          patch.description ?? null,
          patch.startsAt ?? null,
          patch.endsAt !== undefined,
          patch.endsAt ?? null,
          patch.allDay !== undefined,
          patch.allDay ?? false,
          patch.kind ?? null,
        ],
      ),
    );
  },

  async removeEvent(classroomId, id) {
    const { rowCount } = await query(
      'delete from calendar_events where classroom_id = $1 and id = $2',
      [classroomId, id],
    );
    return rowCount > 0;
  },
};
