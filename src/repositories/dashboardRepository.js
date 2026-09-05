import { query } from '../db/index.js';

/**
 * Cross-classroom aggregates, for the dashboards.
 *
 * Everything here answers a question that spans courses, which is what a
 * dashboard is for: a per-classroom query repeated six times would work, but
 * it would be six round trips to say one thing.
 *
 * Every query is scoped by university *and* by membership. Membership alone
 * would be enough, but the tenant boundary is the one thing this product
 * cannot get wrong, so it is stated rather than implied. Archived classrooms
 * are left out throughout -- a finished course is not something to act on.
 */

/**
 * Joins a classroom to the caller's membership of it, unarchived only.
 *
 * `column` is always a literal from this file -- never anything a caller
 * supplies -- so there is nothing here for a value to escape from.
 */
const mine = (column) => `
  join classrooms room on room.id = ${column}
  join classroom_members member
    on member.classroom_id = room.id and member.user_id = $2
 where room.university_id = $1
   and room.archived_at is null
`;

export const dashboardRepository = {
  /**
   * Published quizzes a student may still sit and has not submitted.
   *
   * Retakes are deliberately not offered here: something already done is not
   * outstanding work, and a dashboard that keeps listing it becomes noise.
   */
  async openQuizzesFor(universityId, studentId, limit) {
    const { rows } = await query(
      `select quiz.id, quiz.title, quiz.due_at, quiz.time_limit_seconds,
              room.id as classroom_id, room.name as classroom_name,
              jsonb_array_length(quiz.questions) as question_count
         from quizzes quiz
         ${mine('quiz.classroom_id')}
           and quiz.is_published
           and jsonb_array_length(quiz.questions) > 0
           and (quiz.available_from is null or quiz.available_from <= now())
           and (quiz.due_at is null or quiz.due_at >= now())
           and not exists (
             select 1 from quiz_attempts attempt
              where attempt.quiz_id = quiz.id
                and attempt.student_id = $2
                and attempt.status = 'submitted'
           )
        order by quiz.due_at nulls last, quiz.created_at
        limit $3`,
      [universityId, studentId, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
      timeLimitSeconds: row.time_limit_seconds,
      questionCount: row.question_count,
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
    }));
  },

  /** The latest published announcements from every course. */
  async recentAnnouncements(universityId, userId, limit) {
    const { rows } = await query(
      `select note.id, note.title, note.published_at, note.pinned,
              room.id as classroom_id, room.name as classroom_name,
              author.name as author_name
         from announcements note
         left join users author on author.id = note.author_id
         ${mine('note.classroom_id')}
           and note.published_at is not null
        order by note.published_at desc
        limit $3`,
      [universityId, userId, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      publishedAt: new Date(row.published_at).toISOString(),
      pinned: row.pinned,
      author: row.author_name ?? 'A former member of staff',
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
    }));
  },

  /**
   * A student's own quiz standing per course: how many they have submitted
   * and how they did, as one row per classroom.
   */
  async quizStandingFor(universityId, studentId) {
    const { rows } = await query(
      `select room.id as classroom_id,
              count(*)::int              as submitted,
              coalesce(sum(best.score), 0)::int      as earned,
              coalesce(sum(best.max_score), 0)::int  as possible
         from (
           select attempt.quiz_id,
                  max(attempt.score)     as score,
                  max(attempt.max_score) as max_score
             from quiz_attempts attempt
            where attempt.student_id = $2 and attempt.status = 'submitted'
            group by attempt.quiz_id
         ) best
         join quizzes quiz on quiz.id = best.quiz_id
         ${mine('quiz.classroom_id')}
        group by room.id`,
      [universityId, studentId],
    );

    return rows.map((row) => ({
      classroomId: row.classroom_id,
      submitted: row.submitted,
      earned: row.earned,
      possible: row.possible,
    }));
  },

  /**
   * What a teacher has left undone, per course.
   *
   * One query rather than four, because each of these is a count over the
   * same set of classrooms and asking separately would mean four scans of the
   * membership join for no gain.
   */
  async teachingBacklog(universityId, teacherId) {
    const { rows } = await query(
      `select room.id as classroom_id,
              room.name as classroom_name,
              (select count(*) from classroom_members other
                where other.classroom_id = room.id and other.role = 'student')::int
                as student_count,
              (select count(*) from quizzes quiz
                where quiz.classroom_id = room.id and not quiz.is_published)::int
                as draft_quizzes,
              (select count(*) from announcements note
                where note.classroom_id = room.id and note.published_at is null)::int
                as draft_announcements,
              -- Manual gradebook cells with nobody's mark in them yet. Quiz
              -- columns are derived and never need a hand, so they are left out.
              (select count(*)
                 from grade_items item
                 cross join classroom_members student
                where item.classroom_id = room.id
                  and item.source_type = 'manual'
                  and student.classroom_id = room.id
                  and student.role = 'student'
                  and not exists (
                    select 1 from grades mark
                     where mark.grade_item_id = item.id
                       and mark.student_id = student.user_id
                  ))::int as ungraded_cells,
              -- Threads nobody has answered: the opening post and nothing else.
              (select count(*)
                 from discussion_threads thread
                where thread.classroom_id = room.id
                  and not thread.locked
                  and (select count(*) from discussion_posts post
                        where post.thread_id = thread.id
                          and post.deleted_at is null) = 1)::int
                as unanswered_threads
         from classrooms room
         join classroom_members member
           on member.classroom_id = room.id and member.user_id = $2
        where room.university_id = $1
          and room.archived_at is null
          and member.role in ('teacher', 'ta')
        order by room.name`,
      [universityId, teacherId],
    );

    return rows.map((row) => ({
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
      studentCount: row.student_count,
      draftQuizzes: row.draft_quizzes,
      draftAnnouncements: row.draft_announcements,
      ungradedCells: row.ungraded_cells,
      unansweredThreads: row.unanswered_threads,
    }));
  },

  /** Recent submissions across a teacher's courses, newest first. */
  async recentSubmissions(universityId, teacherId, limit) {
    const { rows } = await query(
      `select attempt.id, attempt.score, attempt.max_score, attempt.submitted_at,
              student.name as student_name,
              quiz.id as quiz_id, quiz.title as quiz_title,
              room.id as classroom_id, room.name as classroom_name
         from quiz_attempts attempt
         join users student on student.id = attempt.student_id
         join quizzes quiz on quiz.id = attempt.quiz_id
         join classrooms room on room.id = quiz.classroom_id
         join classroom_members member
           on member.classroom_id = room.id and member.user_id = $2
        where room.university_id = $1
          and room.archived_at is null
          and member.role in ('teacher', 'ta')
          and attempt.status = 'submitted'
        order by attempt.submitted_at desc
        limit $3`,
      [universityId, teacherId, limit],
    );

    return rows.map((row) => ({
      attemptId: row.id,
      score: row.score,
      maxScore: row.max_score,
      submittedAt: new Date(row.submitted_at).toISOString(),
      studentName: row.student_name,
      quizId: row.quiz_id,
      quizTitle: row.quiz_title,
      classroomId: row.classroom_id,
      classroomName: row.classroom_name,
    }));
  },
};
