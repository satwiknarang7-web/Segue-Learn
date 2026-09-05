import { calendarRepository } from '../repositories/calendarRepository.js';
import { classroomRepository } from '../repositories/classroomRepository.js';
import { dashboardRepository } from '../repositories/dashboardRepository.js';

/**
 * The dashboard.
 *
 * There is not a student dashboard and a teacher dashboard; there is one
 * dashboard that shows a teaching section to anyone who teaches and a
 * studying section to anyone who studies. A graduate student who runs one
 * seminar and sits another gets both, which is the whole reason role lives on
 * the enrolment rather than on the account.
 *
 * Nothing here is a new source of truth. Every number is read from the same
 * tables the relevant tab reads, so a dashboard can be wrong only by being
 * out of date, never by disagreeing.
 */

const UPCOMING = 6;
const OPEN_QUIZZES = 6;
const ANNOUNCEMENTS = 5;
const SUBMISSIONS = 6;

/** How far ahead "coming up" looks. Beyond a fortnight is not today's problem. */
const HORIZON_DAYS = 21;

export const dashboardService = {
  async forUser(user) {
    const classrooms = await classroomRepository.listForUser(user.universityId, user.id);
    const active = classrooms.filter((classroom) => classroom.archivedAt === null);

    const teaching = active.filter(
      (classroom) => classroom.role === 'teacher' || classroom.role === 'ta',
    );
    const studying = active.filter((classroom) => classroom.role === 'student');

    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);

    const [upcoming, announcements] = await Promise.all([
      calendarRepository.listUpcomingForUser(
        user.universityId,
        user.id,
        now.toISOString(),
        UPCOMING,
      ),
      dashboardRepository.recentAnnouncements(user.universityId, user.id, ANNOUNCEMENTS),
    ]);

    const dashboard = {
      name: user.name,
      // Both flags can be true. The page renders whichever sections apply
      // rather than choosing one shape of dashboard.
      teaches: teaching.length > 0,
      studies: studying.length > 0,
      archivedCount: classrooms.length - active.length,
      upcoming: upcoming.filter((entry) => Date.parse(entry.startsAt) <= horizon.getTime()),
      announcements,
    };

    if (studying.length > 0) {
      const [openQuizzes, standing] = await Promise.all([
        dashboardRepository.openQuizzesFor(user.universityId, user.id, OPEN_QUIZZES),
        dashboardRepository.quizStandingFor(user.universityId, user.id),
      ]);

      const byClassroom = new Map(standing.map((row) => [row.classroomId, row]));

      dashboard.studying = studying.map((classroom) => {
        const own = byClassroom.get(classroom.id);
        return {
          id: classroom.id,
          name: classroom.name,
          term: classroom.term,
          quizzesTaken: own?.submitted ?? 0,
          // Quiz marks only -- the gradebook is the real grade, and saying so
          // here would mean assembling six gradebooks to draw one screen.
          quizScore: own && own.possible > 0 ? Math.round((own.earned / own.possible) * 100) : null,
        };
      });
      dashboard.openQuizzes = openQuizzes;
    }

    if (teaching.length > 0) {
      const [backlog, submissions] = await Promise.all([
        dashboardRepository.teachingBacklog(user.universityId, user.id),
        dashboardRepository.recentSubmissions(user.universityId, user.id, SUBMISSIONS),
      ]);

      const byClassroom = new Map(backlog.map((row) => [row.classroomId, row]));

      dashboard.teaching = teaching.map((classroom) => {
        const counts = byClassroom.get(classroom.id);
        return {
          id: classroom.id,
          name: classroom.name,
          term: classroom.term,
          joinCode: classroom.joinCode,
          studentCount: counts?.studentCount ?? 0,
          // Each of these is a thing somebody is waiting on.
          draftQuizzes: counts?.draftQuizzes ?? 0,
          draftAnnouncements: counts?.draftAnnouncements ?? 0,
          ungradedCells: counts?.ungradedCells ?? 0,
          unansweredThreads: counts?.unansweredThreads ?? 0,
          outstanding:
            (counts?.ungradedCells ?? 0) +
            (counts?.unansweredThreads ?? 0) +
            (counts?.draftQuizzes ?? 0) +
            (counts?.draftAnnouncements ?? 0),
        };
      });
      dashboard.submissions = submissions;
    }

    return dashboard;
  },
};
