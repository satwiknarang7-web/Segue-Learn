import { query, queryOne } from '../db/index.js';

/**
 * Classrooms and who is in them.
 *
 * Every read takes the university it belongs to. Passing an id alone would
 * work in SQL but would let a bug in a caller reach across tenants, and the
 * tenant boundary is the one thing this product cannot get wrong.
 */

const fromRow = (row) =>
  row && {
    id: row.id,
    universityId: row.university_id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description ?? '',
    visibility: row.visibility,
    joinCode: row.join_code,
    term: row.term ?? null,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };

const COLUMNS = `id, university_id, owner_id, name, description, visibility, join_code,
                 term, archived_at, created_at, updated_at`;

const C = COLUMNS.split(',')
  .map((c) => `c.${c.trim()}`)
  .join(', ');

export const classroomRepository = {
  async findById(universityId, id) {
    return fromRow(
      await queryOne(`select ${COLUMNS} from classrooms where university_id = $1 and id = $2`, [
        universityId,
        id,
      ]),
    );
  },

  /** What a student types to enrol. Scoped, so codes only collide within a tenant. */
  async findByJoinCode(universityId, joinCode) {
    return fromRow(
      await queryOne(
        `select ${COLUMNS} from classrooms where university_id = $1 and join_code = $2`,
        [universityId, String(joinCode ?? '').trim()],
      ),
    );
  },

  async joinCodeExists(universityId, joinCode) {
    const row = await queryOne(
      'select 1 as hit from classrooms where university_id = $1 and join_code = $2',
      [universityId, joinCode],
    );
    return row !== null;
  },

  async insert(classroom) {
    return fromRow(
      await queryOne(
        `insert into classrooms (university_id, owner_id, name, description, visibility,
                                 join_code, term)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning ${COLUMNS}`,
        [
          classroom.universityId,
          classroom.ownerId,
          classroom.name,
          classroom.description ?? '',
          classroom.visibility ?? 'private',
          classroom.joinCode,
          classroom.term ?? null,
        ],
      ),
    );
  },

  async update(universityId, id, patch) {
    return fromRow(
      await queryOne(
        `update classrooms
            set name        = coalesce($3, name),
                description = coalesce($4, description),
                visibility  = coalesce($5, visibility),
                term        = coalesce($6, term),
                updated_at  = now()
          where university_id = $1 and id = $2
        returning ${COLUMNS}`,
        [
          universityId,
          id,
          patch.name ?? null,
          patch.description ?? null,
          patch.visibility ?? null,
          patch.term ?? null,
        ],
      ),
    );
  },

  /** Closes enrolment without removing anyone: the old code stops working. */
  async rotateJoinCode(universityId, id, joinCode) {
    return fromRow(
      await queryOne(
        `update classrooms set join_code = $3, updated_at = now()
          where university_id = $1 and id = $2
        returning ${COLUMNS}`,
        [universityId, id, joinCode],
      ),
    );
  },

  async setArchived(universityId, id, archived) {
    return fromRow(
      await queryOne(
        `update classrooms
            set archived_at = case when $3 then now() else null end, updated_at = now()
          where university_id = $1 and id = $2
        returning ${COLUMNS}`,
        [universityId, id, archived],
      ),
    );
  },

  async remove(universityId, id) {
    const { rowCount } = await query(
      'delete from classrooms where university_id = $1 and id = $2',
      [universityId, id],
    );
    return rowCount > 0;
  },

  /**
   * Every classroom this person belongs to, with the role they hold in each.
   * The home screen's only query.
   */
  async listForUser(universityId, userId) {
    const { rows } = await query(
      `select ${C}, m.role, m.joined_at
         from classrooms c
         join classroom_members m on m.classroom_id = c.id
        where c.university_id = $1 and m.user_id = $2
        order by c.archived_at nulls first, c.name`,
      [universityId, userId],
    );
    return rows.map((row) => ({
      ...fromRow(row),
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
    }));
  },

  /** Public classrooms a student could browse and join without a code. */
  async listPublic(universityId) {
    const { rows } = await query(
      `select ${COLUMNS} from classrooms
        where university_id = $1 and visibility = 'public' and archived_at is null
        order by name`,
      [universityId],
    );
    return rows.map(fromRow);
  },
};

export const membershipRepository = {
  async find(classroomId, userId) {
    const row = await queryOne(
      `select classroom_id, user_id, role, joined_at
         from classroom_members where classroom_id = $1 and user_id = $2`,
      [classroomId, userId],
    );
    return (
      row && {
        classroomId: row.classroom_id,
        userId: row.user_id,
        role: row.role,
        joinedAt: new Date(row.joined_at).toISOString(),
      }
    );
  },

  /**
   * Enrols someone, or leaves an existing enrolment alone. Idempotent so that
   * a student pasting a join code twice is not an error.
   */
  async add(classroomId, userId, role = 'student') {
    const row = await queryOne(
      `insert into classroom_members (classroom_id, user_id, role)
       values ($1, $2, $3)
       on conflict (classroom_id, user_id) do update set role = classroom_members.role
       returning classroom_id, user_id, role, joined_at`,
      [classroomId, userId, role],
    );
    return {
      classroomId: row.classroom_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
    };
  },

  async setRole(classroomId, userId, role) {
    const { rowCount } = await query(
      'update classroom_members set role = $3 where classroom_id = $1 and user_id = $2',
      [classroomId, userId, role],
    );
    return rowCount > 0;
  },

  async remove(classroomId, userId) {
    const { rowCount } = await query(
      'delete from classroom_members where classroom_id = $1 and user_id = $2',
      [classroomId, userId],
    );
    return rowCount > 0;
  },

  /** The roster, joined to accounts so a caller gets names in one query. */
  async listMembers(classroomId) {
    const { rows } = await query(
      `select u.id, u.name, u.email, m.role, m.joined_at
         from classroom_members m
         join users u on u.id = m.user_id
        where m.classroom_id = $1
        order by case m.role when 'teacher' then 0 when 'ta' then 1 else 2 end, u.name`,
      [classroomId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      joinedAt: new Date(row.joined_at).toISOString(),
    }));
  },

  async countStudents(classroomId) {
    const row = await queryOne(
      `select count(*)::int as n from classroom_members
        where classroom_id = $1 and role = 'student'`,
      [classroomId],
    );
    return row?.n ?? 0;
  },
};
