import { query, queryOne } from '../db/index.js';

/**
 * Gradebook columns and cells.
 *
 * A grade_item is a column, a grade is a cell. A column either mirrors a quiz
 * or is typed by hand, which is what lets participation marks and essays sit
 * beside auto-marked quizzes in one table.
 *
 * A quiz-backed column holds no cells of its own by default: its numbers are
 * read from the attempts, so a re-mark or a cleared result cannot leave a
 * stale figure behind. A cell written against a quiz column is an override,
 * and the service treats it as one.
 */

const itemFromRow = (row) =>
  row && {
    id: row.id,
    classroomId: row.classroom_id,
    title: row.title,
    pointsPossible: Number(row.points_possible),
    position: row.position,
    sourceType: row.source_type,
    sourceId: row.source_id,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };

const ITEM_COLUMNS = `id, classroom_id, title, points_possible, position, source_type,
                      source_id, due_at, created_at`;

export const gradeItemRepository = {
  async listForClassroom(classroomId) {
    const { rows } = await query(
      `select ${ITEM_COLUMNS} from grade_items
        where classroom_id = $1
        order by position, created_at`,
      [classroomId],
    );
    return rows.map(itemFromRow);
  },

  async findById(classroomId, id) {
    return itemFromRow(
      await queryOne(`select ${ITEM_COLUMNS} from grade_items where classroom_id = $1 and id = $2`, [
        classroomId,
        id,
      ]),
    );
  },

  /** Whether this quiz already has a column, so it is not added twice. */
  async findByQuiz(classroomId, quizId) {
    return itemFromRow(
      await queryOne(
        `select ${ITEM_COLUMNS} from grade_items
          where classroom_id = $1 and source_type = 'quiz' and source_id = $2`,
        [classroomId, quizId],
      ),
    );
  },

  async insert(item) {
    const next = await queryOne(
      'select coalesce(max(position), -1) + 1 as position from grade_items where classroom_id = $1',
      [item.classroomId],
    );

    return itemFromRow(
      await queryOne(
        `insert into grade_items (classroom_id, title, points_possible, position,
                                  source_type, source_id, due_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning ${ITEM_COLUMNS}`,
        [
          item.classroomId,
          item.title,
          item.pointsPossible,
          next.position,
          item.sourceType ?? 'manual',
          item.sourceId ?? null,
          item.dueAt ?? null,
        ],
      ),
    );
  },

  async update(classroomId, id, patch) {
    return itemFromRow(
      await queryOne(
        `update grade_items
            set title           = coalesce($3, title),
                points_possible = coalesce($4, points_possible),
                due_at          = case when $5::boolean then $6 else due_at end
          where classroom_id = $1 and id = $2
        returning ${ITEM_COLUMNS}`,
        [
          classroomId,
          id,
          patch.title ?? null,
          patch.pointsPossible ?? null,
          // A due date can be cleared, so "given" has to be distinguishable
          // from "null", which coalesce alone cannot express.
          patch.dueAt !== undefined,
          patch.dueAt ?? null,
        ],
      ),
    );
  },

  async remove(classroomId, id) {
    const { rowCount } = await query(
      'delete from grade_items where classroom_id = $1 and id = $2',
      [classroomId, id],
    );
    return rowCount > 0;
  },
};

const gradeFromRow = (row) =>
  row && {
    gradeItemId: row.grade_item_id,
    studentId: row.student_id,
    points: row.points === null ? null : Number(row.points),
    feedback: row.feedback ?? '',
    gradedBy: row.graded_by,
    gradedAt: new Date(row.graded_at).toISOString(),
  };

export const gradeRepository = {
  /** Every cell in one classroom's gradebook, in one query. */
  async listForClassroom(classroomId) {
    const { rows } = await query(
      `select g.grade_item_id, g.student_id, g.points, g.feedback, g.graded_by, g.graded_at
         from grades g
         join grade_items i on i.id = g.grade_item_id
        where i.classroom_id = $1`,
      [classroomId],
    );
    return rows.map(gradeFromRow);
  },

  /** One student's own cells. */
  async listForStudent(classroomId, studentId) {
    const { rows } = await query(
      `select g.grade_item_id, g.student_id, g.points, g.feedback, g.graded_by, g.graded_at
         from grades g
         join grade_items i on i.id = g.grade_item_id
        where i.classroom_id = $1 and g.student_id = $2`,
      [classroomId, studentId],
    );
    return rows.map(gradeFromRow);
  },

  /** Writes a cell, replacing whatever was there. */
  async set({ gradeItemId, studentId, points, feedback = '', gradedBy }) {
    return gradeFromRow(
      await queryOne(
        `insert into grades (grade_item_id, student_id, points, feedback, graded_by, graded_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (grade_item_id, student_id) do update
           set points = excluded.points,
               feedback = excluded.feedback,
               graded_by = excluded.graded_by,
               graded_at = now()
         returning grade_item_id, student_id, points, feedback, graded_by, graded_at`,
        [gradeItemId, studentId, points, feedback, gradedBy ?? null],
      ),
    );
  },

  /** Clears a cell. On a quiz column this drops the override, not the score. */
  async clear(gradeItemId, studentId) {
    const { rowCount } = await query(
      'delete from grades where grade_item_id = $1 and student_id = $2',
      [gradeItemId, studentId],
    );
    return rowCount > 0;
  },

  /**
   * Best submitted score per student for the given quizzes, in one query.
   *
   * Best rather than latest, because a quiz that allows retakes is usually
   * offered so somebody can improve, and the improvement is the thing worth
   * recording.
   */
  async bestQuizScores(quizIds) {
    if (quizIds.length === 0) return [];

    const { rows } = await query(
      `select quiz_id, student_id,
              max(score)::int      as score,
              max(max_score)::int  as max_score,
              count(*)::int        as attempts
         from quiz_attempts
        where quiz_id = any($1::uuid[]) and status = 'submitted'
        group by quiz_id, student_id`,
      [quizIds],
    );

    return rows.map((row) => ({
      quizId: row.quiz_id,
      studentId: row.student_id,
      score: row.score,
      maxScore: row.max_score,
      attempts: row.attempts,
    }));
  },
};
