/**
 * Deterministic per-attempt shuffling.
 *
 * The order a participant sees must be stable: refreshing, resuming after a
 * dropped connection, or coming back to an earlier question all have to show
 * the same arrangement, or the answers already saved would point at the wrong
 * options. So nothing is stored - the order is derived from the attempt id and
 * the question id, which means the same inputs always rebuild the same order.
 *
 * Answers are stored against the *original* option index, so scoring, the
 * question breakdown and the CSV export never need to know shuffling happened.
 */

import { hasOptions } from './questionTypes.js';

/** FNV-1a, for turning a seed string into a 32-bit number. */
function hash(seed) {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** mulberry32: small, fast, and identical across runs for a given seed. */
function createRandom(seed) {
  let state = hash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The positions 0..length-1 in shuffled order, decided entirely by `seed`.
 * Reading it as a mapping: result[displayedPosition] = originalPosition.
 */
export function seededOrder(seed, length) {
  const order = Array.from({ length }, (_, index) => index);
  const random = createRandom(seed);

  // Fisher-Yates, walked backwards so every permutation is equally likely.
  for (let index = length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

/** The order this attempt sees a quiz's questions in. */
export const questionOrder = (attemptId, count) => seededOrder(`${attemptId}:questions`, count);

/** The order this attempt sees one question's options in. */
export const optionOrder = (attemptId, questionId, count) =>
  seededOrder(`${attemptId}:${questionId}`, count);

/**
 * Translate the option index a participant clicked back to the index the
 * answer key uses. Without shuffling the two are the same.
 */
export function toOriginalOption(quiz, attemptId, question, displayedIndex) {
  // A typed answer has no positions to translate.
  if (!hasOptions(question)) return displayedIndex;
  if (!quiz.shuffleOptions) return displayedIndex;

  const order = optionOrder(attemptId, question.id, question.options.length);
  return order[displayedIndex] ?? displayedIndex;
}
