import { query, queryOne, transaction } from '../db/index.js';

/**
 * Quiz attempts.
 *
 * The sharpest break from SegueQuiz: an attempt belongs to an enrolled
 * student, not to a typed-in name plus a device marker. There is no
 * participant_key and no device_id, because identity is no longer guessed --
 * which also means the two independent "has this person already taken it"
 * checks collapse into one.
 *
 * Retakes are numbered rather than overwritten, so a gradebook can show every
 * try and a teacher can see improvement.
 */

const fromRow = (row) =>
  row && {
    id: row.id,
    quizId: row.quiz_id,
    studentId: row.student_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    durationMs: row.duration_ms,
    timedOut: row.timed_out,
    endedReason: row.ended_reason,
    answers: row.answers ?? {},
    marks: row.marks ?? {},
    score: row.score,
    correctCount: row.correct_count,
    pendingMarkCount: row.pending_mark_count ?? 0,
    maxScore: row.max_score,
    answeredCount: row.answered_count,
    // Present only on the joined reads; the results table needs a name.
    ...(row.student_name ? { studentName: row.student_name } : {}),
    ...(row.student_email ? { studentEmail: row.student_email } : {}),
  };

const COLUMNS = `id, quiz_id, student_id, attempt_number, status, started_at, deadline_at,
                 submitted_at, duration_ms, timed_out, ended_reason, answers, marks,
                 score, correct_count, pending_mark_count, max_score, answered_count`;

const PREFIXED = COLUMNS.split(',')
  .map((c) => `a.${c.trim()}`)
  .join(', ');

const SETTABLE = [
  ['status', 'status'],
  ['submittedAt', 'submitted_at'],
  ['durationMs', 'duration_ms'],
  ['timedOut', 'timed_out'],
  ['endedReason', 'ended_reason'],
  ['score', 'score'],
  ['correctCount', 'correct_count'],
  ['pendingMarkCount', 'pending_mark_count'],
  ['maxScore', 'max_score'],
  ['answeredCount', 'answered_count'],
];

export const attemptRepository = {
  async findById(id) {
    return fromRow(await queryOne(`select ${COLUMNS} from quiz_attempts where id = $1`, [id]));
  },

  async findInProgress(quizId, studentId) {
    return fromRow(
      await queryOne(
        `select ${COLUMNS} from quiz_attempts
          where quiz_id = $1 and student_id = $2 and status = 'in_progress'
          order by attempt_number desc limit 1`,
        [quizId, studentId],
      ),
    );
  },

  async findLatestSubmitted(quizId, studentId) {
    return fromRow(
      await queryOne(
        `select ${COLUMNS} from quiz_attempts
          where quiz_id = $1 and student_id = $2 and status = 'submitted'
          order by attempt_number desc limit 1`,
        [quizId, studentId],
      ),
    );
  },

  async countSubmitted(quizId, studentId) {
    const row = await queryOne(
      `select count(*)::int as n from quiz_attempts
        where quiz_id = $1 and student_id = $2 and status = 'submitted'`,
      [quizId, studentId],
    );
    return row?.n ?? 0;
  },

  async nextAttemptNumber(quizId, studentId) {
    const row = await queryOne(
      `select coalesce(max(attempt_number), 0)::int as n from quiz_attempts
        where quiz_id = $1 and student_id = $2`,
      [quizId, studentId],
    );
    return (row?.n ?? 0) + 1;
  },

  /** Attempts still running, so the timer sweep can close the expired ones. */
  async listInProgress(quizId) {
    const { rows } = await query(
      `select ${COLUMNS} from quiz_attempts where quiz_id = $1 and status = 'in_progress'`,
      [quizId],
    );
    return rows.map(fromRow);
  },

  /**
   * The results table: every submitted attempt with the student's name, best
   * first. Ties are broken on time taken, which is what makes a leaderboard
   * from a set of equal scores.
   */
  async listSubmitted(quizId) {
    const { rows } = await query(
      `select ${PREFIXED}, u.name as student_name, u.email as student_email
         from quiz_attempts a
         join users u on u.id = a.student_id
        where a.quiz_id = $1 and a.status = 'submitted'
        order by a.score desc, a.duration_ms asc, a.submitted_at asc`,
      [quizId],
    );
    return rows.map(fromRow);
  },

  /** One student's own attempts at one quiz, newest first. */
  async listForStudent(quizId, studentId) {
    const { rows } = await query(
      `select ${COLUMNS} from quiz_attempts
        where quiz_id = $1 and student_id = $2
        order by attempt_number desc`,
      [quizId, studentId],
    );
    return rows.map(fromRow);
  },

  async insert(attempt) {
    return fromRow(
      await queryOne(
        `insert into quiz_attempts (quiz_id, student_id, attempt_number, status, started_at,
                                    deadline_at, answers, marks, max_score)
         values ($1, $2, $3, 'in_progress', $4, $5, '{}'::jsonb, '{}'::jsonb, $6)
         returning ${COLUMNS}`,
        [
          attempt.quizId,
          attempt.studentId,
          attempt.attemptNumber,
          attempt.startedAt,
          attempt.deadlineAt,
          attempt.maxScore ?? 0,
        ],
      ),
    );
  },

  /**
   * Read-modify-write under a row lock. Answers autosave on every keystroke's
   * worth of change, so two saves racing is ordinary rather than exotic.
   */
  async update(id, updater) {
    return transaction(async (tx) => {
      const { rows } = await tx.query(
        `select ${COLUMNS} from quiz_attempts where id = $1 for update`,
        [id],
      );
      if (rows.length === 0) return null;

      const next = await updater(fromRow(rows[0]));

      const assignments = [];
      const values = [id];
      for (const [key, column] of SETTABLE) {
        if (next[key] === undefined) continue;
        values.push(next[key]);
        assignments.push(`${column} = $${values.length}`);
      }
      values.push(JSON.stringify(next.answers ?? {}));
      assignments.push(`answers = $${values.length}::jsonb`);
      values.push(JSON.stringify(next.marks ?? {}));
      assignments.push(`marks = $${values.length}::jsonb`);

      const updated = await tx.query(
        `update quiz_attempts set ${assignments.join(', ')} where id = $1 returning ${COLUMNS}`,
        values,
      );
      return fromRow(updated.rows[0]);
    });
  },

  async remove(id) {
    const { rowCount } = await query('delete from quiz_attempts where id = $1', [id]);
    return rowCount > 0;
  },

  async removeByQuiz(quizId) {
    const { rowCount } = await query('delete from quiz_attempts where quiz_id = $1', [quizId]);
    return rowCount;
  },
};
