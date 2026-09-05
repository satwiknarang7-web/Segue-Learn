import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createId, createJoinCode } from '../lib/ids.js';
import { parseBulkQuestions } from '../lib/parseQuestions.js';
import {
  CHOICE,
  DRAW,
  QUESTION_TYPES,
  SHORT,
  hasOptions,
  normaliseAnswerText,
  typeOf as questionTypeOf,
} from '../lib/questionTypes.js';
import { optionOrder, questionOrder } from '../lib/shuffle.js';
import { asArray, asBoolean, asInteger, asOptionalString, asString } from '../lib/validate.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { gradeItemRepository } from '../repositories/gradeRepository.js';
import { quizRepository } from '../repositories/quizRepository.js';
import { classroomService } from './classroomService.js';

const { limits } = config;

/**
 * Question types this platform can currently accept.
 *
 * A drawn answer is stored as the image it was saved to, and there is nowhere
 * to put that image until file storage lands. The domain layer still knows how
 * to grade and mark one -- see questionTypes.js -- so switching it back on is
 * adding DRAW here, not rebuilding the feature.
 */
const SUPPORTED_TYPES = [CHOICE, SHORT];

/** Multiple choice: a list of options with exactly one of them marked. */
function parseChoiceQuestion(payload) {
  const rawOptions = asArray(payload.options, 'options', {
    min: limits.minOptions,
    max: limits.maxOptions,
  });
  const options = rawOptions.map((option, index) =>
    asString(option, `option ${index + 1}`, { max: limits.optionMaxLength }),
  );

  const deduplicated = new Set(options.map((option) => option.toLowerCase()));
  if (deduplicated.size !== options.length) {
    throw badRequest('Each answer option must be different.');
  }

  const correctIndex = asInteger(payload.correctIndex, 'correctIndex', {
    min: 0,
    max: options.length - 1,
  });

  return { options, correctIndex };
}

/**
 * Short answer: the taker types, and any of the accepted spellings earns the
 * marks. Duplicates are rejected using the same normalisation that grades, so
 * a teacher cannot list "15 N" and "15  n" and come away believing they have
 * covered two cases when they have covered one.
 */
function parseShortQuestion(payload) {
  const rawAnswers = asArray(payload.acceptedAnswers, 'acceptedAnswers', {
    min: 1,
    max: limits.maxAcceptedAnswers,
  });
  const acceptedAnswers = rawAnswers.map((answer, index) =>
    asString(answer, `accepted answer ${index + 1}`, { max: limits.shortAnswerMaxLength }),
  );

  const deduplicated = new Set(acceptedAnswers.map(normaliseAnswerText));
  if (deduplicated.size !== acceptedAnswers.length) {
    throw badRequest('Two accepted answers are the same once spacing and case are ignored.');
  }

  return { acceptedAnswers };
}

function parseQuestionPayload(payload = {}) {
  const text = asString(payload.text, 'question', { max: limits.questionMaxLength });

  // Absent means choice, so anything written before types existed still saves.
  const type = payload.type === undefined || payload.type === null ? CHOICE : payload.type;
  if (!QUESTION_TYPES.includes(type)) {
    throw badRequest(`"type" must be one of: ${QUESTION_TYPES.join(', ')}.`);
  }
  if (!SUPPORTED_TYPES.includes(type)) {
    throw badRequest(
      'Drawn answers need file storage, which is not connected yet. Use a multiple-choice or short-answer question.',
    );
  }

  const points =
    payload.points === undefined || payload.points === null || payload.points === ''
      ? 1
      : asInteger(payload.points, 'points', { min: limits.minPoints, max: limits.maxPoints });

  const specific = type === SHORT ? parseShortQuestion(payload) : parseChoiceQuestion(payload);

  return { text, type, ...specific, points };
}

/** An ISO timestamp, or null. Used for the availability window. */
function parseTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw badRequest(`"${field}" is not a date.`);
  return new Date(parsed).toISOString();
}

function parseQuizSettings(payload = {}, { partial = false } = {}) {
  const settings = {};

  if (!partial || payload.title !== undefined) {
    settings.title = asString(payload.title, 'title', { max: limits.titleMaxLength });
  }
  if (!partial || payload.description !== undefined) {
    settings.description =
      asOptionalString(payload.description, 'description', {
        max: limits.descriptionMaxLength,
      }) ?? '';
  }
  if (!partial || payload.timeLimitSeconds !== undefined) {
    settings.timeLimitSeconds = asInteger(payload.timeLimitSeconds, 'timeLimitSeconds', {
      min: limits.minTimeLimitSeconds,
      max: limits.maxTimeLimitSeconds,
    });
  }

  for (const flag of [
    'isPublished',
    'allowRetakes',
    'endOnLeave',
    'shuffleQuestions',
    'shuffleOptions',
    'revealAnswers',
  ]) {
    if (payload[flag] !== undefined) settings[flag] = asBoolean(payload[flag], flag);
  }

  if (payload.availableFrom !== undefined) {
    settings.availableFrom = parseTimestamp(payload.availableFrom, 'availableFrom');
  }
  if (payload.dueAt !== undefined) {
    settings.dueAt = parseTimestamp(payload.dueAt, 'dueAt');
  }

  if (
    settings.availableFrom &&
    settings.dueAt &&
    Date.parse(settings.dueAt) <= Date.parse(settings.availableFrom)
  ) {
    throw badRequest('The due date must be after the quiz opens.');
  }

  return settings;
}

/** Quizzes created before this setting existed still enforce it. */
const endsOnLeave = (quiz) => quiz.endOnLeave !== false;

const totalPoints = (quiz) =>
  quiz.questions.reduce((sum, question) => sum + question.points, 0);

/**
 * Where a quiz is in its availability window.
 *
 * Unpublished is invisible to students entirely. A window that has not opened
 * or has closed is visible but cannot be started, so a student can see what is
 * coming and what they missed.
 */
function availability(quiz, now = Date.now()) {
  if (!quiz.isPublished) return 'draft';
  if (quiz.availableFrom && now < Date.parse(quiz.availableFrom)) return 'scheduled';
  if (quiz.dueAt && now > Date.parse(quiz.dueAt)) return 'closed';
  return 'open';
}

async function allocateJoinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = createJoinCode(6);
    if (!(await quizRepository.joinCodeExists(candidate))) return candidate;
  }
  throw conflict('Could not allocate a join code. Please try again.');
}

export const quizService = {
  totalPoints,
  endsOnLeave,
  availability,

  /** The quiz, checked to be in a classroom this person may see. */
  async requireReadable(user, classroomId, quizId) {
    const access = await classroomService.requireAccess(user, classroomId);
    const quiz = await quizRepository.findById(classroomId, quizId);
    if (!quiz) throw notFound('That quiz does not exist.');
    return { quiz, access };
  },

  /** The quiz, checked to be one this person may change. */
  async requireWritable(user, classroomId, quizId) {
    await classroomService.requireTeaching(user, classroomId);
    const quiz = await quizRepository.findById(classroomId, quizId);
    if (!quiz) throw notFound('That quiz does not exist.');
    return quiz;
  },

  /**
   * The quiz list for a classroom.
   *
   * Staff see drafts and attempt counts. A student sees only published
   * quizzes, and gets their own standing with each one instead.
   */
  async listForClassroom(user, classroomId) {
    const { role } = await classroomService.requireAccess(user, classroomId);
    const staff = role === 'teacher' || role === 'ta' || user.platformRole === 'admin';

    const quizzes = await quizRepository.listForClassroom(classroomId);
    const visible = staff ? quizzes : quizzes.filter((quiz) => quiz.isPublished);

    return Promise.all(
      visible.map(async (quiz) => {
        const summary = {
          id: quiz.id,
          title: quiz.title,
          description: quiz.description,
          timeLimitSeconds: quiz.timeLimitSeconds,
          questionCount: quiz.questions.length,
          totalPoints: totalPoints(quiz),
          isPublished: quiz.isPublished,
          allowRetakes: quiz.allowRetakes,
          revealAnswers: quiz.revealAnswers,
          availableFrom: quiz.availableFrom,
          dueAt: quiz.dueAt,
          state: availability(quiz),
          createdAt: quiz.createdAt,
          updatedAt: quiz.updatedAt,
        };

        // Everybody's own standing with the quiz, staff included. Teaching
        // staff are members too and may sit their own quiz to see what it
        // looks like, and leaving these out told the taking page nothing --
        // which it then read as "already taken".
        const attempts = await attemptRepository.listForStudent(quiz.id, user.id);
        const submitted = attempts.filter((attempt) => attempt.status === 'submitted');
        const inProgress = attempts.find((attempt) => attempt.status === 'in_progress') ?? null;

        const own = {
          attemptsTaken: submitted.length,
          inProgressAttemptId: inProgress?.id ?? null,
          bestScore: submitted.length
            ? Math.max(...submitted.map((attempt) => attempt.score))
            : null,
          canStart:
            availability(quiz) === 'open' &&
            quiz.questions.length > 0 &&
            (Boolean(inProgress) || quiz.allowRetakes || submitted.length === 0),
        };

        // Only staff learn anything about anyone else.
        return staff
          ? { ...summary, ...own, attemptCount: quiz.attemptCount, joinCode: quiz.joinCode }
          : { ...summary, ...own };
      }),
    );
  },

  async create(user, classroomId, payload) {
    await classroomService.requireTeaching(user, classroomId);
    const settings = parseQuizSettings(payload);

    return quizRepository.insert({
      classroomId,
      createdBy: user.id,
      title: settings.title,
      description: settings.description,
      timeLimitSeconds: settings.timeLimitSeconds,
      isPublished: false,
      allowRetakes: settings.allowRetakes ?? false,
      endOnLeave: settings.endOnLeave ?? true,
      shuffleQuestions: settings.shuffleQuestions ?? false,
      shuffleOptions: settings.shuffleOptions ?? false,
      revealAnswers: settings.revealAnswers ?? false,
      availableFrom: settings.availableFrom ?? null,
      dueAt: settings.dueAt ?? null,
      questions: [],
    });
  },

  async update(user, classroomId, quizId, payload) {
    const quiz = await this.requireWritable(user, classroomId, quizId);
    const settings = parseQuizSettings(payload, { partial: true });

    if (settings.isPublished === true && quiz.questions.length === 0) {
      throw badRequest('Add at least one question before publishing this quiz.');
    }

    return quizRepository.update(classroomId, quizId, (current) => ({ ...current, ...settings }));
  },

  async remove(user, classroomId, quizId) {
    const quiz = await this.requireWritable(user, classroomId, quizId);

    // A quiz that counts towards a grade is not deleted out from under the
    // gradebook: the column may hold marks typed by hand as an override, and
    // losing those silently is worse than an extra step.
    const column = await gradeItemRepository.findByQuiz(classroomId, quizId);
    if (column) {
      throw conflict(
        `"${quiz.title}" is in the gradebook. Remove its gradebook column first, then delete it.`,
      );
    }

    await attemptRepository.removeByQuiz(quiz.id);
    await quizRepository.remove(classroomId, quizId);
    return { removed: true };
  },

  async addQuestion(user, classroomId, quizId, payload) {
    await this.requireWritable(user, classroomId, quizId);
    const question = { id: createId(), ...parseQuestionPayload(payload) };

    return quizRepository.update(classroomId, quizId, (current) => ({
      ...current,
      questions: [...current.questions, question],
    }));
  },

  async updateQuestion(user, classroomId, quizId, questionId, payload) {
    const quiz = await this.requireWritable(user, classroomId, quizId);
    if (!quiz.questions.some((question) => question.id === questionId)) {
      throw notFound('That question does not exist.');
    }
    const parsed = parseQuestionPayload(payload);

    return quizRepository.update(classroomId, quizId, (current) => ({
      ...current,
      questions: current.questions.map((question) =>
        question.id === questionId ? { id: question.id, ...parsed } : question,
      ),
    }));
  },

  async removeQuestion(user, classroomId, quizId, questionId) {
    const quiz = await this.requireWritable(user, classroomId, quizId);
    if (!quiz.questions.some((question) => question.id === questionId)) {
      throw notFound('That question does not exist.');
    }

    return quizRepository.update(classroomId, quizId, (current) => {
      const questions = current.questions.filter((question) => question.id !== questionId);
      // A published quiz with no questions cannot be taken, so unpublish it.
      return {
        ...current,
        questions,
        isPublished: questions.length > 0 && current.isPublished,
      };
    });
  },

  async moveQuestion(user, classroomId, quizId, questionId, direction) {
    const quiz = await this.requireWritable(user, classroomId, quizId);
    const index = quiz.questions.findIndex((question) => question.id === questionId);
    if (index === -1) throw notFound('That question does not exist.');

    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= quiz.questions.length) return quiz;

    return quizRepository.update(classroomId, quizId, (current) => {
      const questions = [...current.questions];
      [questions[index], questions[target]] = [questions[target], questions[index]];
      return { ...current, questions };
    });
  },

  /**
   * Add many questions from one pasted block.
   *
   * All or nothing: if any line is bad the whole paste is refused, because a
   * half-imported quiz is harder to repair than one that was never imported.
   * `dryRun` runs the same parse and validation but saves nothing, so what you
   * preview is what you get.
   */
  async addQuestionsFromText(user, classroomId, quizId, text, { dryRun = false } = {}) {
    await this.requireWritable(user, classroomId, quizId);
    const { questions, errors } = parseBulkQuestions(text);

    const parsed = [];
    for (const question of questions) {
      try {
        parsed.push({ line: question.line, ...parseQuestionPayload(question) });
      } catch (error) {
        errors.push({ line: question.line, message: error.message });
      }
    }

    errors.sort((a, b) => a.line - b.line);

    if (dryRun) return { questions: parsed, errors, added: 0 };

    if (errors.length > 0) {
      throw badRequest(
        `${errors.length} line(s) could not be read. Fix them and paste again.`,
        errors,
      );
    }
    if (parsed.length === 0) throw badRequest('Nothing to import.');

    const quiz = await quizRepository.update(classroomId, quizId, (current) => ({
      ...current,
      questions: [
        ...current.questions,
        ...parsed.map(({ line, ...question }) => ({ id: createId(), ...question })),
      ],
    }));

    return { quiz, questions: parsed, errors: [], added: parsed.length };
  },

  /** Hands out a code for a live QR run, generating one the first time. */
  async ensureJoinCode(user, classroomId, quizId) {
    const quiz = await this.requireWritable(user, classroomId, quizId);
    if (quiz.joinCode) return { joinCode: quiz.joinCode };

    const joinCode = await allocateJoinCode();
    const updated = await quizRepository.setJoinCode(classroomId, quizId, joinCode);
    return { joinCode: updated.joinCode };
  },

  /**
   * The quiz as a taker may see it: no correct answers, no answer key.
   *
   * `attemptId` decides the shuffle. It is required whenever a quiz shuffles,
   * because the order has to be reproducible for that one attempt -- a refresh
   * must not rearrange options underneath answers already saved.
   */
  toParticipantView(quiz, attemptId = null) {
    const shuffleQuestions = Boolean(quiz.shuffleQuestions) && attemptId;
    const shuffleOptions = Boolean(quiz.shuffleOptions) && attemptId;

    const order = shuffleQuestions
      ? questionOrder(attemptId, quiz.questions.length)
      : quiz.questions.map((_, index) => index);

    return {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      timeLimitSeconds: quiz.timeLimitSeconds,
      endOnLeave: endsOnLeave(quiz),
      questionCount: quiz.questions.length,
      totalPoints: totalPoints(quiz),
      questions: order.map((questionIndex) => {
        const question = quiz.questions[questionIndex];

        const base = {
          id: question.id,
          type: questionTypeOf(question),
          text: question.text,
          points: question.points,
        };

        // Typed answers have nothing to shuffle and no options to leak.
        if (!hasOptions(question)) return base;

        // The taker sees options in their own order; the index they send back
        // is translated to the answer key's order before anything is stored.
        const options = shuffleOptions
          ? optionOrder(attemptId, question.id, question.options.length).map(
              (optionIndex) => question.options[optionIndex],
            )
          : question.options;

        return { ...base, options };
      }),
    };
  },
};
