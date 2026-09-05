import { config } from '../config.js';
import { HttpError, badRequest, conflict, gone, notFound } from '../lib/errors.js';
import {
  awardFor,
  hasOptions,
  isAnswered,
  needsMarking,
  normaliseAnswerText,
  reviewRow,
} from '../lib/questionTypes.js';
import { toOriginalOption } from '../lib/shuffle.js';
import { asInteger, asString } from '../lib/validate.js';
import { attemptRepository } from '../repositories/attemptRepository.js';
import { quizRepository } from '../repositories/quizRepository.js';
import { classroomService } from './classroomService.js';
import { quizService } from './quizService.js';

const { submitGraceMs } = config;

/**
 * Taking a quiz.
 *
 * The break from SegueQuiz: a taker is an enrolled student, not a name typed
 * into a box. That removes the whole guessing apparatus -- participant keys,
 * device markers, and the two independent "has this person already been here"
 * checks -- and replaces it with one question the database can answer.
 */

/**
 * Grade a set of answers.
 *
 * Everything that can be marked by comparison is. Anything that cannot counts
 * towards pendingMarkCount instead, and the score is what is earned so far
 * rather than a final one.
 */
function grade(quiz, answers, marks = {}) {
  let score = 0;
  let correctCount = 0;
  let pendingMarkCount = 0;

  for (const question of quiz.questions) {
    const answer = answers[question.id];
    const award = awardFor(question, answer, marks[question.id]);

    score += award.points;
    if (award.pending) pendingMarkCount += 1;
    if (!award.pending && award.points === question.points && isAnswered(question, answer)) {
      correctCount += 1;
    }
  }

  return {
    score,
    correctCount,
    pendingMarkCount,
    maxScore: quizService.totalPoints(quiz),
    answeredCount: Object.keys(answers).length,
  };
}

/**
 * Read one submitted answer into the form it is stored in, or null for "not
 * answered". A blank typed answer is not an answer: it is stored as absent, so
 * clearing a text box leaves the same state as never having touched it.
 */
function readAnswer(quiz, question, value, attemptId) {
  if (value === null || value === undefined) return null;

  if (!hasOptions(question)) {
    const text = asString(value, 'answer', { max: config.limits.shortAnswerMaxLength, min: 0 });
    return normaliseAnswerText(text) === '' ? null : text;
  }

  const displayed = asInteger(value, 'answer', { min: 0, max: question.options.length - 1 });
  // Store against the answer key's order, never the order it was shown in.
  return toOriginalOption(quiz, attemptId, question, displayed);
}

/** Only accept answers for questions that exist, in a shape that type allows. */
function sanitiseAnswers(quiz, rawAnswers, attemptId = null) {
  if (rawAnswers === undefined || rawAnswers === null) return {};
  if (typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw badRequest('"answers" must be an object of questionId to answer.');
  }

  const answers = {};
  for (const [questionId, value] of Object.entries(rawAnswers)) {
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    // Silently drop stale questions rather than failing a whole submission.
    if (!question) continue;
    const answer = readAnswer(quiz, question, value, attemptId);
    if (answer !== null) answers[questionId] = answer;
  }
  return answers;
}

/**
 * End an attempt for good.
 *
 * `reason` is one of:
 *   submitted  - the student pressed submit
 *   timed_out  - the clock ran out, here or while they were away
 *   left_quiz  - they switched tab or app, and the quiz forbids that
 */
function finalise(attempt, quiz, { at = Date.now(), reason = 'submitted' } = {}) {
  const startedMs = Date.parse(attempt.startedAt);
  const limitMs = quiz.timeLimitSeconds * 1000;
  const elapsedMs = Math.max(0, at - startedMs);
  // Nobody can beat the clock by submitting late, so time is capped at the limit.
  const durationMs = Math.min(elapsedMs, limitMs);
  const result = grade(quiz, attempt.answers, attempt.marks ?? {});
  const ranOut = elapsedMs > limitMs + submitGraceMs;
  const endedReason = reason === 'submitted' && ranOut ? 'timed_out' : reason;

  return attemptRepository.update(attempt.id, (current) => ({
    ...current,
    status: 'submitted',
    submittedAt: new Date(startedMs + durationMs).toISOString(),
    durationMs,
    timedOut: endedReason === 'timed_out',
    endedReason,
    ...result,
  }));
}

/** A taker's own paper: their answer against the key, question by question. */
function buildReview(quiz, attempt) {
  const marks = attempt.marks ?? {};
  return quiz.questions.map((question, index) =>
    reviewRow(question, index, attempt.answers[question.id], marks[question.id]),
  );
}

/** Public shape of an attempt in progress -- never leaks the answer key. */
function toAttemptState(attempt, quiz) {
  return {
    attemptId: attempt.id,
    quizId: attempt.quizId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    remainingMs: Math.max(0, Date.parse(attempt.deadlineAt) - Date.now()),
    timeLimitSeconds: quiz.timeLimitSeconds,
    answers: attempt.answers,
  };
}

export const attemptService = {
  /** Auto-submit attempts whose timer ran out while the student was away. */
  async finaliseExpired(quiz) {
    const cutoff = Date.now() - submitGraceMs;

    for (const attempt of await attemptRepository.listInProgress(quiz.id)) {
      if (Date.parse(attempt.deadlineAt) > cutoff) continue;
      await finalise(attempt, quiz, {
        at: Date.parse(attempt.deadlineAt),
        reason: 'timed_out',
      });
    }
  },

  /**
   * The attempt, checked to belong to the person asking for it.
   *
   * Without this, holding any attempt id would reach somebody else's paper --
   * and the answers on it -- through a perfectly ordinary session.
   */
  async requireOwnAttempt(user, attemptId) {
    const attempt = await attemptRepository.findById(attemptId);
    if (!attempt || attempt.studentId !== user.id) {
      throw notFound('That attempt does not exist.');
    }

    const quiz = await attemptService.quizFor(attempt);
    return { attempt, quiz };
  },

  /**
   * The quiz an attempt belongs to. Unscoped by classroom, which is safe only
   * because the caller has already proved the attempt is the student's own.
   */
  async quizFor(attempt) {
    const quiz = await quizRepository.findByIdUnscoped(attempt.quizId);
    if (!quiz) throw notFound('That quiz does not exist.');
    return quiz;
  },

  /**
   * Begin, or resume, this student's attempt at a quiz.
   *
   * A refresh must not hand out a fresh timer, so an attempt already running is
   * always resumed before any other check.
   */
  async start(user, classroomId, quizId) {
    const { quiz, access } = await quizService.requireReadable(user, classroomId, quizId);

    if (!access.isMember) throw new HttpError(403, 'Join this classroom before taking its quizzes.');
    if (quiz.questions.length === 0) throw conflict('This quiz has no questions yet.');

    const state = quizService.availability(quiz);
    if (state === 'draft') throw conflict('This quiz is not open yet.');
    if (state === 'scheduled') {
      throw conflict('This quiz has not opened yet. Check the date it becomes available.');
    }

    await attemptService.finaliseExpired(quiz);

    const running = await attemptRepository.findInProgress(quiz.id, user.id);
    if (running) {
      return {
        attempt: toAttemptState(running, quiz),
        quiz: quizService.toParticipantView(quiz, running.id),
        resumed: true,
      };
    }

    // Only after resuming, so a student whose window closed mid-attempt can
    // still finish the paper they are holding.
    if (state === 'closed') throw gone('This quiz has closed.');

    if (!quiz.allowRetakes && (await attemptRepository.countSubmitted(quiz.id, user.id)) > 0) {
      throw conflict('You have already taken this quiz.');
    }

    const startedAt = new Date();
    const attempt = await attemptRepository.insert({
      quizId: quiz.id,
      studentId: user.id,
      attemptNumber: await attemptRepository.nextAttemptNumber(quiz.id, user.id),
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + quiz.timeLimitSeconds * 1000).toISOString(),
      maxScore: quizService.totalPoints(quiz),
    });

    return {
      attempt: toAttemptState(attempt, quiz),
      quiz: quizService.toParticipantView(quiz, attempt.id),
      resumed: false,
    };
  },

  async getState(user, attemptId) {
    const { attempt, quiz } = await attemptService.requireOwnAttempt(user, attemptId);
    return toAttemptState(attempt, quiz);
  },

  /** Autosave a single answer so a closed tab does not lose the whole attempt. */
  async saveAnswer(user, attemptId, payload = {}) {
    const { attempt, quiz } = await attemptService.requireOwnAttempt(user, attemptId);
    if (attempt.status !== 'in_progress') throw gone('This attempt has already been submitted.');

    if (Date.now() > Date.parse(attempt.deadlineAt) + submitGraceMs) {
      await finalise(attempt, quiz, {
        at: Date.parse(attempt.deadlineAt),
        reason: 'timed_out',
      });
      throw gone('Time is up — this attempt was submitted automatically.');
    }

    const questionId = asString(payload.questionId, 'questionId', { max: 100 });
    const question = quiz.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw notFound('That question does not exist.');

    const answer = readAnswer(quiz, question, payload.answer, attempt.id);

    const updated = await attemptRepository.update(attempt.id, (current) => {
      const answers = { ...current.answers };
      if (answer === null) delete answers[questionId];
      else answers[questionId] = answer;
      return { ...current, answers };
    });

    return toAttemptState(updated, quiz);
  },

  async submit(user, attemptId, payload = {}) {
    const { attempt, quiz } = await attemptService.requireOwnAttempt(user, attemptId);

    // Submitting twice (the timer and the button racing) returns the same result.
    if (attempt.status === 'submitted') return attemptService.toResult(attempt, quiz);

    // Answers already saved are in the answer key's order; the ones arriving
    // with the submission are in the order this attempt was shown, so they need
    // the same translation saveAnswer applies.
    const incoming = sanitiseAnswers(quiz, payload.answers, attempt.id);
    const withAnswers = await attemptRepository.update(attempt.id, (current) => ({
      ...current,
      answers: { ...current.answers, ...incoming },
    }));

    const deadlineMs = Date.parse(attempt.deadlineAt);
    const finalised =
      Date.now() - deadlineMs > submitGraceMs
        ? await finalise(withAnswers, quiz, { at: deadlineMs, reason: 'timed_out' })
        : await finalise(withAnswers, quiz);

    return attemptService.toResult(finalised, quiz);
  },

  /**
   * The student navigated away -- switched tab, switched app, or locked the
   * phone -- and this quiz does not allow that. Whatever they had answered is
   * scored and the attempt is closed immediately.
   */
  async abandon(user, attemptId) {
    const { attempt, quiz } = await attemptService.requireOwnAttempt(user, attemptId);

    // Idempotent: a beacon and a later reload can both arrive.
    if (attempt.status === 'submitted') return attemptService.toResult(attempt, quiz);

    // Never credit more time than the clock allowed.
    const at = Math.min(Date.now(), Date.parse(attempt.deadlineAt));
    const finalised = await finalise(attempt, quiz, { at, reason: 'left_quiz' });
    return attemptService.toResult(finalised, quiz);
  },

  /** What the student sees after submitting. */
  toResult(attempt, quiz) {
    return {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      quizTitle: quiz.title,
      attemptNumber: attempt.attemptNumber,
      score: attempt.score,
      maxScore: attempt.maxScore,
      correctCount: attempt.correctCount,
      questionCount: quiz.questions.length,
      answeredCount: attempt.answeredCount,
      pendingMarkCount: attempt.pendingMarkCount ?? 0,
      durationMs: attempt.durationMs,
      timedOut: attempt.timedOut,
      endedReason: attempt.endedReason,
      submittedAt: attempt.submittedAt,
      // Only present when the quiz reveals answers. Withheld from the payload
      // entirely rather than hidden in the page, so a student who opens the
      // network tab learns nothing the quiz did not choose to tell them.
      ...(quiz.revealAnswers ? { review: buildReview(quiz, attempt) } : {}),
    };
  },

  /** A student's own history with one quiz. */
  async listOwn(user, classroomId, quizId) {
    const { quiz } = await quizService.requireReadable(user, classroomId, quizId);
    const attempts = await attemptRepository.listForStudent(quiz.id, user.id);

    return attempts
      .filter((attempt) => attempt.status === 'submitted')
      .map((attempt) => attemptService.toResult(attempt, quiz));
  },

  /* ---- Staff views ------------------------------------------------------ */

  /** Every submitted attempt at a quiz, best first. Teaching staff only. */
  async results(user, classroomId, quizId) {
    const quiz = await quizService.requireWritable(user, classroomId, quizId);
    await attemptService.finaliseExpired(quiz);

    const attempts = await attemptRepository.listSubmitted(quiz.id);

    return {
      quiz: {
        id: quiz.id,
        title: quiz.title,
        questionCount: quiz.questions.length,
        totalPoints: quizService.totalPoints(quiz),
      },
      attempts: attempts.map((attempt, index) => ({
        rank: index + 1,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        studentName: attempt.studentName,
        studentEmail: attempt.studentEmail,
        attemptNumber: attempt.attemptNumber,
        score: attempt.score,
        maxScore: attempt.maxScore,
        correctCount: attempt.correctCount,
        answeredCount: attempt.answeredCount,
        pendingMarkCount: attempt.pendingMarkCount,
        durationMs: attempt.durationMs,
        endedReason: attempt.endedReason,
        submittedAt: attempt.submittedAt,
      })),
    };
  },

  /** One student's paper, for a teacher. */
  async reviewAttempt(user, classroomId, quizId, attemptId) {
    const quiz = await quizService.requireWritable(user, classroomId, quizId);
    const attempt = await attemptRepository.findById(attemptId);

    // Checking the quiz matches stops an id from another quiz being read
    // through a classroom this teacher happens to be in.
    if (!attempt || attempt.quizId !== quiz.id) throw notFound('That attempt does not exist.');

    return {
      attemptId: attempt.id,
      studentId: attempt.studentId,
      score: attempt.score,
      maxScore: attempt.maxScore,
      durationMs: attempt.durationMs,
      submittedAt: attempt.submittedAt,
      review: buildReview(quiz, attempt),
    };
  },

  async removeAttempt(user, classroomId, quizId, attemptId) {
    const quiz = await quizService.requireWritable(user, classroomId, quizId);
    const attempt = await attemptRepository.findById(attemptId);
    if (!attempt || attempt.quizId !== quiz.id) throw notFound('That attempt does not exist.');

    await attemptRepository.remove(attempt.id);
    return { removed: true };
  },

  /** Clears the board so the same quiz can be run with another group. */
  async clearResults(user, classroomId, quizId) {
    const quiz = await quizService.requireWritable(user, classroomId, quizId);
    const removed = await attemptRepository.removeByQuiz(quiz.id);
    return { removed };
  },
};
