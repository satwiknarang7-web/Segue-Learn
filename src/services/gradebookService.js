import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { asOptionalString, asString } from '../lib/validate.js';
import { membershipRepository } from '../repositories/classroomRepository.js';
import { gradeItemRepository, gradeRepository } from '../repositories/gradeRepository.js';
import { quizRepository } from '../repositories/quizRepository.js';
import { classroomService } from './classroomService.js';

/**
 * The gradebook.
 *
 * A column is either typed by hand or backed by a quiz. A quiz column holds no
 * stored numbers: its cells are read from the attempts every time, so clearing
 * a quiz's results or re-marking an answer moves the gradebook with it and
 * cannot leave a stale figure behind.
 *
 * A teacher can still overrule one -- a cell written against a quiz column is
 * an override, and wins over the derived score until it is cleared.
 */

const MAX_FEEDBACK = 2000;

/** The column's maximum. For a quiz that is the quiz's own total, live. */
function maxFor(item, quizzesById) {
  if (item.sourceType !== 'quiz') return item.pointsPossible;

  const quiz = quizzesById.get(item.sourceId);
  if (!quiz) return item.pointsPossible;
  return quiz.questions.reduce((sum, question) => sum + question.points, 0);
}

function presentItem(item, quizzesById) {
  const quiz = item.sourceType === 'quiz' ? quizzesById.get(item.sourceId) : null;

  return {
    id: item.id,
    title: item.title,
    pointsPossible: maxFor(item, quizzesById),
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    // A quiz column whose quiz was deleted is left readable but flagged, so a
    // teacher can see why the numbers stopped moving.
    orphaned: item.sourceType === 'quiz' && !quiz,
    dueAt: item.dueAt,
    position: item.position,
  };
}

/**
 * One student's cell for one column.
 *
 * Order matters: an override beats a derived score, and a derived score beats
 * nothing at all.
 */
function buildCell(item, studentId, { overrides, quizScores, quizzesById }) {
  const max = maxFor(item, quizzesById);
  const override = overrides.get(`${item.id}:${studentId}`) ?? null;

  if (item.sourceType !== 'quiz') {
    return {
      itemId: item.id,
      points: override ? override.points : null,
      max,
      source: 'manual',
      feedback: override?.feedback ?? '',
      graded: Boolean(override),
    };
  }

  if (override) {
    return {
      itemId: item.id,
      points: override.points,
      max,
      source: 'override',
      feedback: override.feedback ?? '',
      graded: true,
    };
  }

  const attempt = quizScores.get(`${item.sourceId}:${studentId}`) ?? null;
  return {
    itemId: item.id,
    points: attempt ? attempt.score : null,
    max,
    source: 'quiz',
    attempts: attempt?.attempts ?? 0,
    feedback: '',
    graded: Boolean(attempt),
  };
}

/**
 * A student's standing so far.
 *
 * Only graded columns count. An assessment nobody has sat yet would otherwise
 * read as a zero and make every grade look like a failure in week one.
 */
function totalFor(cells) {
  const graded = cells.filter((cell) => cell.graded && cell.points !== null);
  const earned = graded.reduce((sum, cell) => sum + cell.points, 0);
  const possible = graded.reduce((sum, cell) => sum + cell.max, 0);

  return {
    earned,
    possible,
    percent: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null,
    gradedCount: graded.length,
  };
}

async function loadGrid(classroomId) {
  const [items, quizzes] = await Promise.all([
    gradeItemRepository.listForClassroom(classroomId),
    quizRepository.listForClassroom(classroomId),
  ]);

  const quizzesById = new Map(quizzes.map((quiz) => [quiz.id, quiz]));

  const quizIds = items
    .filter((item) => item.sourceType === 'quiz' && quizzesById.has(item.sourceId))
    .map((item) => item.sourceId);

  const [cells, scores] = await Promise.all([
    gradeRepository.listForClassroom(classroomId),
    gradeRepository.bestQuizScores(quizIds),
  ]);

  return {
    items,
    quizzesById,
    overrides: new Map(cells.map((cell) => [`${cell.gradeItemId}:${cell.studentId}`, cell])),
    quizScores: new Map(scores.map((score) => [`${score.quizId}:${score.studentId}`, score])),
  };
}

export const gradebookService = {
  /**
   * The whole grid for staff; one row for a student.
   *
   * A student's own row is assembled the same way, so what they see is the
   * same number their teacher sees rather than a second calculation that
   * could disagree.
   */
  async grid(user, classroomId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = role === 'teacher' || role === 'ta' || user.platformRole === 'admin';

    const context = await loadGrid(classroomId);
    const items = context.items.map((item) => presentItem(item, context.quizzesById));

    const members = await membershipRepository.listMembers(classroomId);
    const students = members.filter((member) => member.role === 'student');

    const rowFor = (student) => {
      const cells = context.items.map((item) => buildCell(item, student.id, context));
      return {
        studentId: student.id,
        name: student.name,
        ...(staff ? { email: student.email } : {}),
        cells,
        total: totalFor(cells),
      };
    };

    if (staff) {
      return { canEdit: true, items, rows: students.map(rowFor) };
    }

    // A student sees their own row and nothing about anyone else's.
    const own = students.find((student) => student.id === user.id);
    return { canEdit: false, items, rows: own ? [rowFor(own)] : [] };
  },

  /** Published quizzes that do not have a column yet, for the "add" menu. */
  async availableQuizzes(user, classroomId) {
    await classroomService.requireTeaching(user, classroomId);

    const [quizzes, items] = await Promise.all([
      quizRepository.listForClassroom(classroomId),
      gradeItemRepository.listForClassroom(classroomId),
    ]);

    const used = new Set(
      items.filter((item) => item.sourceType === 'quiz').map((item) => item.sourceId),
    );

    return quizzes
      .filter((quiz) => quiz.isPublished && !used.has(quiz.id))
      .map((quiz) => ({
        id: quiz.id,
        title: quiz.title,
        totalPoints: quiz.questions.reduce((sum, question) => sum + question.points, 0),
      }));
  },

  async createManualColumn(user, classroomId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    const pointsPossible = Number(payload.pointsPossible);
    if (!Number.isFinite(pointsPossible) || pointsPossible <= 0 || pointsPossible > 100_000) {
      throw badRequest('A column needs a positive number of marks.');
    }

    return gradeItemRepository.insert({
      classroomId,
      title,
      pointsPossible,
      sourceType: 'manual',
      dueAt: payload.dueAt ? new Date(payload.dueAt).toISOString() : null,
    });
  },

  /**
   * Adds a column backed by a quiz.
   *
   * Deliberately explicit rather than appearing the moment a quiz is
   * published: a teacher decides what counts towards a grade, and a quiz set
   * as practice should not silently start doing so.
   */
  async addQuizColumn(user, classroomId, quizId) {
    await classroomService.requireTeaching(user, classroomId);

    const quiz = await quizRepository.findById(classroomId, quizId);
    if (!quiz) throw notFound('That quiz does not exist.');

    if (await gradeItemRepository.findByQuiz(classroomId, quizId)) {
      throw conflict('That quiz is already in the gradebook.');
    }

    return gradeItemRepository.insert({
      classroomId,
      title: quiz.title,
      pointsPossible: quiz.questions.reduce((sum, question) => sum + question.points, 0),
      sourceType: 'quiz',
      sourceId: quiz.id,
      dueAt: quiz.dueAt,
    });
  },

  async updateColumn(user, classroomId, itemId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const item = await gradeItemRepository.findById(classroomId, itemId);
    if (!item) throw notFound('That column does not exist.');

    const patch = {};
    if (payload.title !== undefined) {
      patch.title = asString(payload.title, 'title', { max: config.limits.titleMaxLength });
    }
    if (payload.pointsPossible !== undefined) {
      if (item.sourceType === 'quiz') {
        throw badRequest("A quiz column's marks come from the quiz itself.");
      }
      const points = Number(payload.pointsPossible);
      if (!Number.isFinite(points) || points <= 0) {
        throw badRequest('A column needs a positive number of marks.');
      }
      patch.pointsPossible = points;
    }
    if (payload.dueAt !== undefined) {
      patch.dueAt = payload.dueAt ? new Date(payload.dueAt).toISOString() : null;
    }

    return gradeItemRepository.update(classroomId, itemId, patch);
  },

  async removeColumn(user, classroomId, itemId) {
    await classroomService.requireTeaching(user, classroomId);

    const item = await gradeItemRepository.findById(classroomId, itemId);
    if (!item) throw notFound('That column does not exist.');

    await gradeItemRepository.remove(classroomId, itemId);
    // Removing a quiz column never touches the quiz or its attempts; it only
    // stops the score counting towards a grade.
    return { removed: true, wasQuiz: item.sourceType === 'quiz' };
  },

  /** Writes one cell. On a quiz column this records an override. */
  async setGrade(user, classroomId, itemId, studentId, payload = {}) {
    await classroomService.requireTeaching(user, classroomId);

    const item = await gradeItemRepository.findById(classroomId, itemId);
    if (!item) throw notFound('That column does not exist.');

    const membership = await membershipRepository.find(classroomId, studentId);
    if (!membership) throw notFound('That person is not in this classroom.');

    const quizzes = await quizRepository.listForClassroom(classroomId);
    const max = maxFor(item, new Map(quizzes.map((quiz) => [quiz.id, quiz])));

    const points = Number(payload.points);
    if (!Number.isFinite(points) || points < 0) {
      throw badRequest('A mark must be zero or more.');
    }
    if (points > max) {
      throw badRequest(`That is more than the ${max} marks this column is worth.`);
    }

    const feedback = asOptionalString(payload.feedback, 'feedback', { max: MAX_FEEDBACK }) ?? '';

    await gradeRepository.set({
      gradeItemId: itemId,
      studentId,
      points,
      feedback,
      gradedBy: user.id,
    });

    return { itemId, studentId, points, feedback, source: item.sourceType === 'quiz' ? 'override' : 'manual' };
  },

  /**
   * Clears one cell. On a quiz column this drops the override, so the score
   * goes back to whatever the attempt says rather than becoming blank.
   */
  async clearGrade(user, classroomId, itemId, studentId) {
    await classroomService.requireTeaching(user, classroomId);

    const item = await gradeItemRepository.findById(classroomId, itemId);
    if (!item) throw notFound('That column does not exist.');

    const cleared = await gradeRepository.clear(itemId, studentId);
    return { cleared, revertedToQuizScore: item.sourceType === 'quiz' };
  },
};
