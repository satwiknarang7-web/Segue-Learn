/**
 * What a question type is, in one place.
 *
 * Grading, validation, review and the CSV export all dispatch through here
 * rather than each branching on a type string, so adding a type means adding
 * an entry below instead of hunting down every `correctIndex` comparison.
 *
 * Questions authored before types existed have no `type` field at all. Absent
 * therefore means CHOICE, which is what lets every stored quiz keep working
 * without migrating a single row.
 */

export const CHOICE = 'choice';
export const SHORT = 'short';
export const DRAW = 'draw';

export const QUESTION_TYPES = [CHOICE, SHORT, DRAW];

/**
 * Fold away the differences that are about typing rather than knowing.
 *
 * Case and stray whitespace are obvious. The rest are real sources of wrong
 * marks rather than theoretical ones: phone keyboards turn ' into a curly
 * quote, and pasting from a document turns a minus sign into U+2212, which
 * would otherwise fail every negative-number answer.
 */
export function normaliseAnswerText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Absent means choice, so quizzes written before types keep working. */
export const typeOf = (question) =>
  QUESTION_TYPES.includes(question?.type) ? question.type : CHOICE;

export const isChoice = (question) => typeOf(question) === CHOICE;

/** Only choice questions have options, so anything reading them must ask. */
export const hasOptions = (question) => isChoice(question);

/**
 * Whether a person has to decide the marks.
 *
 * A drawing cannot be compared to an answer key, so an attempt containing one
 * has no final score when it is submitted. Everything downstream that assumes
 * a score exists - the leaderboard, the ranking, the tie on time - has to know
 * that, which is why this is asked rather than inferred from a missing value.
 */
export const needsMarking = (question) => typeOf(question) === DRAW;

/**
 * Whether a stored answer counts as given.
 *
 * Option 0 is a real answer and an empty string is not, so this cannot be a
 * truthiness check.
 */
export function isAnswered(question, answer) {
  if (answer === undefined || answer === null) return false;
  if (isChoice(question)) return Number.isInteger(answer);
  // A drawing is stored as the URL of the image it was saved to.
  return normaliseAnswerText(answer) !== '';
}

/** Whether a given answer earns the marks. */
export function isCorrect(question, answer) {
  if (!isAnswered(question, answer)) return false;

  // A drawing is never right or wrong on its own; awardFor decides, once
  // somebody has marked it.
  if (needsMarking(question)) return false;

  if (isChoice(question)) return answer === question.correctIndex;

  const given = normaliseAnswerText(answer);
  return (question.acceptedAnswers ?? []).some(
    (accepted) => normaliseAnswerText(accepted) === given,
  );
}

/** The answer key, as something a person can read. A drawing has none. */
export function correctAnswerText(question) {
  if (needsMarking(question)) return '';
  if (isChoice(question)) return question.options?.[question.correctIndex] ?? '';
  return question.acceptedAnswers?.[0] ?? '';
}

/**
 * The marks one answer earns, and whether anything is still owed.
 *
 * A mark is clamped to the question's own points rather than trusted, so a bad
 * value - or a model's suggestion someone accepted without reading - cannot put
 * a taker above the maximum and break the leaderboard.
 */
export function awardFor(question, answer, mark) {
  if (!isAnswered(question, answer)) return { points: 0, pending: false };

  if (!needsMarking(question)) {
    return { points: isCorrect(question, answer) ? question.points : 0, pending: false };
  }

  if (!mark || !Number.isFinite(Number(mark.points))) return { points: 0, pending: true };

  const points = Math.max(0, Math.min(question.points, Math.round(Number(mark.points))));
  return { points, pending: false };
}

/** What the taker actually gave, as something a person can read. */
export function answerText(question, answer) {
  if (!isAnswered(question, answer)) return '';
  if (needsMarking(question)) return 'a drawing';
  return isChoice(question) ? (question.options?.[answer] ?? '') : String(answer);
}

/**
 * One row of a marked paper, in the shape both the taker's own review and the
 * organiser's per-person review use. Kept here so the two cannot drift, and so
 * a new type only has to teach one place how it is displayed.
 *
 * `options` and `correctIndex` are present only for choice questions; a client
 * should switch on `type` rather than assume either exists.
 */
export function reviewRow(question, index, answer, mark = null) {
  const answered = isAnswered(question, answer);
  const award = awardFor(question, answer, mark);
  const correct = needsMarking(question)
    ? !award.pending && award.points === question.points
    : isCorrect(question, answer);

  const row = {
    number: index + 1,
    questionId: question.id,
    type: typeOf(question),
    text: question.text,
    // The diagram is part of the question, so a review without it cannot be
    // read back.
    imageUrl: question.imageUrl ?? null,
    imageAlt: question.imageAlt ?? '',
    isCorrect: correct,
    points: question.points,
    pointsAwarded: award.points,
    awaitingMarking: award.pending,
    correctAnswer: correctAnswerText(question),
    givenAnswer: answered ? answerText(question, answer) : null,
  };

  if (needsMarking(question)) {
    row.drawingUrl = answered ? String(answer) : null;
    row.markNote = mark?.note ?? '';
    row.markSource = mark?.source ?? null;
    return row;
  }

  if (isChoice(question)) {
    row.options = question.options;
    row.correctIndex = question.correctIndex;
    row.chosenIndex = answered ? answer : null;
  } else {
    // Every spelling that would have earned the marks, so a taker who wrote a
    // near miss can see what the teacher was willing to accept.
    row.acceptedAnswers = question.acceptedAnswers ?? [];
  }

  return row;
}

/**
 * Whether `url` is an image this application stored.
 *
 * Only our own uploads are allowed on a question. An arbitrary URL would let
 * whoever writes a quiz embed anything they liked from anywhere - a tracking
 * pixel, or content that changes after the quiz was reviewed - and it would be
 * fetched by every taker's browser.
 */
export function isOwnMediaUrl(url, { supabaseUrl = '' } = {}) {
  if (typeof url !== 'string' || url === '') return false;

  // Served by this process, from the disk store.
  if (/^\/media\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(url)) return true;

  if (supabaseUrl === '') return false;

  const prefix = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/quiz-media/`;
  return url.startsWith(prefix) && !url.slice(prefix.length).includes('/');
}
