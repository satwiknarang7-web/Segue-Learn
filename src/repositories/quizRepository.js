import { query, queryOne, transaction } from '../db/index.js';

/**
 * Quizzes.
 *
 * Questions stay in a jsonb column: a quiz is always read and written whole,
 * and question order is part of the document, so splitting them into a table
 * would buy joins nobody makes and lose the ordering for free.
 *
 * Every read is scoped by classroom for the same reason classrooms are scoped
 * by university -- so a bug in a caller cannot reach across the boundary.
 */

const fromRow = (row) =>
  row && {
    id: row.id,
    classroomId: row.classroom_id,
    createdBy: row.created_by,
    title: row.title,
    description: row.description ?? '',
    timeLimitSeconds: row.time_limit_seconds,
    questions: row.questions ?? [],
    isPublished: row.is_published,
    allowRetakes: row.allow_retakes,
    endOnLeave: row.end_on_leave,
    shuffleQuestions: Boolean(row.shuffle_questions),
    shuffleOptions: Boolean(row.shuffle_options),
    revealAnswers: Boolean(row.reveal_answers),
    joinCode: row.join_code ?? null,
    availableFrom: row.available_from ? new Date(row.available_from).toISOString() : null,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    pointsPossible: Number(row.points_possible),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };

const COLUMNS = `id, classroom_id, created_by, title, description, time_limit_seconds,
                 questions, is_published, allow_retakes, end_on_leave, shuffle_questions,
                 shuffle_options, reveal_answers, join_code, available_from, due_at,
                 points_possible, created_at, updated_at`;

/** The mutable settings, as columns. Questions are handled separately. */
const SETTABLE = [
  ['title', 'title'],
  ['description', 'description'],
  ['timeLimitSeconds', 'time_limit_seconds'],
  ['isPublished', 'is_published'],
  ['allowRetakes', 'allow_retakes'],
  ['endOnLeave', 'end_on_leave'],
  ['shuffleQuestions', 'shuffle_questions'],
  ['shuffleOptions', 'shuffle_options'],
  ['revealAnswers', 'reveal_answers'],
  ['availableFrom', 'available_from'],
  ['dueAt', 'due_at'],
  ['pointsPossible', 'points_possible'],
];

export const quizRepository = {
  async findById(classroomId, id) {
    return fromRow(
      await queryOne(`select ${COLUMNS} from quizzes where classroom_id = $1 and id = $2`, [
        classroomId,
        id,
      ]),
    );
  },

  /**
   * A quiz by id alone, with no classroom scope.
   *
   * Only for the attempt routes, which reach a quiz *through* an attempt that
   * has already been proved to belong to the caller. Everything a person
   * reaches by classroom must use findById instead, so a stray id cannot cross
   * a boundary.
   */
  async findByIdUnscoped(id) {
    return fromRow(await queryOne(`select ${COLUMNS} from quizzes where id = $1`, [id]));
  },

  /** Used by the live QR run, where the code is all the taker has. */
  async findByJoinCode(joinCode) {
    return fromRow(
      await queryOne(`select ${COLUMNS} from quizzes where join_code = $1`, [
        String(joinCode ?? '').trim(),
      ]),
    );
  },

  async joinCodeExists(joinCode) {
    return (await queryOne('select 1 as hit from quizzes where join_code = $1', [joinCode])) !== null;
  },

  /**
   * The classroom's quizzes with their submitted-attempt counts, in one query
   * rather than one per quiz.
   */
  async listForClassroom(classroomId) {
    const { rows } = await query(
      `select ${COLUMNS.split(',')
        .map((c) => `q.${c.trim()}`)
        .join(', ')},
              coalesce(a.submitted, 0)::int as attempt_count
         from quizzes q
         left join (
           select quiz_id, count(*) as submitted
             from quiz_attempts
            where status = 'submitted'
            group by quiz_id
         ) a on a.quiz_id = q.id
        where q.classroom_id = $1
        order by q.created_at desc`,
      [classroomId],
    );
    return rows.map((row) => ({ ...fromRow(row), attemptCount: row.attempt_count }));
  },

  async insert(quiz) {
    return fromRow(
      await queryOne(
        `insert into quizzes (classroom_id, created_by, title, description, time_limit_seconds,
                              questions, is_published, allow_retakes, end_on_leave,
                              shuffle_questions, shuffle_options, reveal_answers, join_code,
                              available_from, due_at, points_possible)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         returning ${COLUMNS}`,
        [
          quiz.classroomId,
          quiz.createdBy ?? null,
          quiz.title,
          quiz.description ?? '',
          quiz.timeLimitSeconds,
          JSON.stringify(quiz.questions ?? []),
          quiz.isPublished ?? false,
          quiz.allowRetakes ?? false,
          quiz.endOnLeave !== false,
          Boolean(quiz.shuffleQuestions),
          Boolean(quiz.shuffleOptions),
          Boolean(quiz.revealAnswers),
          quiz.joinCode ?? null,
          quiz.availableFrom ?? null,
          quiz.dueAt ?? null,
          quiz.pointsPossible ?? 100,
        ],
      ),
    );
  },

  /**
   * Read-modify-write under a row lock, so two staff editing one quiz cannot
   * lose each other's change. `updater` receives the current quiz and returns
   * the next one, which keeps the service code the same shape it had when the
   * whole table lived in memory.
   */
  async update(classroomId, id, updater) {
    return transaction(async (tx) => {
      const { rows } = await tx.query(
        `select ${COLUMNS} from quizzes where classroom_id = $1 and id = $2 for update`,
        [classroomId, id],
      );
      if (rows.length === 0) return null;

      const next = await updater(fromRow(rows[0]));

      const assignments = [];
      const values = [classroomId, id];
      for (const [key, column] of SETTABLE) {
        if (next[key] === undefined) continue;
        values.push(next[key]);
        assignments.push(`${column} = $${values.length}`);
      }
      values.push(JSON.stringify(next.questions ?? []));
      assignments.push(`questions = $${values.length}::jsonb`);
      assignments.push('updated_at = now()');

      const updated = await tx.query(
        `update quizzes set ${assignments.join(', ')}
          where classroom_id = $1 and id = $2
        returning ${COLUMNS}`,
        values,
      );
      return fromRow(updated.rows[0]);
    });
  },

  async setJoinCode(classroomId, id, joinCode) {
    return fromRow(
      await queryOne(
        `update quizzes set join_code = $3, updated_at = now()
          where classroom_id = $1 and id = $2 returning ${COLUMNS}`,
        [classroomId, id, joinCode],
      ),
    );
  },

  async remove(classroomId, id) {
    const { rowCount } = await query(
      'delete from quizzes where classroom_id = $1 and id = $2',
      [classroomId, id],
    );
    return rowCount > 0;
  },
};
