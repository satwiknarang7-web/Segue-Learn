/**
 * Turn pasted rows into questions.
 *
 * One question per line. The first cell is the question, every cell after it
 * is an option, and the correct one is marked with a leading asterisk:
 *
 *   Capital of France?<TAB>Berlin<TAB>*Paris<TAB>Madrid
 *
 * Tab-separated is the default because that is what copying cells out of Excel
 * or Google Sheets actually produces; comma-separated is accepted too, with
 * quoted cells so a question can contain a comma.
 *
 * Marking the answer inline rather than in a fixed column is what lets one
 * paste mix two-option and six-option questions.
 *
 * A question beginning with = is answered by typing instead of choosing, and
 * every cell after it is a spelling that will be accepted:
 *
 *   =SI unit of force?<TAB>newton<TAB>N
 *
 * It has to be marked explicitly. Treating "no asterisk anywhere" as a typed
 * question would quietly turn the commonest paste mistake - forgetting the * -
 * into a question of the wrong type, instead of the error it currently raises.
 */

import { normaliseAnswerText } from './questionTypes.js';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_ACCEPTED_ANSWERS = 12;
const SHORT_ANSWER_PREFIX = '=';

/** Split one line, honouring "quoted cells" so a delimiter can appear inside. */
function splitLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted cell is a literal quote.
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.trim() === '') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }

  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Tabs win when present, since that is what a spreadsheet paste looks like. */
function detectDelimiter(lines) {
  return lines.some((line) => line.includes('\t')) ? '\t' : ',';
}

export function parseBulkQuestions(input) {
  const lines = String(input ?? '')
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    // Blank lines and # comments let people annotate their paste.
    .filter(({ line }) => line.trim() !== '' && !line.trim().startsWith('#'));

  if (lines.length === 0) return { questions: [], errors: [] };

  const delimiter = detectDelimiter(lines.map(({ line }) => line));
  const questions = [];
  const errors = [];

  for (const { line, number } of lines) {
    const cells = splitLine(line, delimiter).filter((cell, index) => index === 0 || cell !== '');
    const [rawText, ...rawOptions] = cells;
    const isShort = rawText.startsWith(SHORT_ANSWER_PREFIX);
    const text = isShort ? rawText.slice(SHORT_ANSWER_PREFIX.length).trim() : rawText;

    if (!text) {
      errors.push({ line: number, message: 'No question text.' });
      continue;
    }

    if (isShort) {
      const accepted = rawOptions.map((answer) => answer.trim()).filter((answer) => answer !== '');

      if (accepted.length === 0) {
        errors.push({ line: number, message: 'A typed question needs at least one answer after it.' });
        continue;
      }

      if (accepted.length > MAX_ACCEPTED_ANSWERS) {
        errors.push({
          line: number,
          message: `${accepted.length} accepted answers; at most ${MAX_ACCEPTED_ANSWERS} are allowed.`,
        });
        continue;
      }

      const distinct = new Set(accepted.map(normaliseAnswerText));
      if (distinct.size !== accepted.length) {
        errors.push({
          line: number,
          message: 'Two accepted answers are the same once spacing and case are ignored.',
        });
        continue;
      }

      questions.push({
        line: number,
        type: 'short',
        text,
        acceptedAnswers: accepted,
        points: 1,
      });
      continue;
    }

    if (rawOptions.length < MIN_OPTIONS) {
      errors.push({
        line: number,
        message: `Only ${rawOptions.length} option(s); at least ${MIN_OPTIONS} are needed.`,
      });
      continue;
    }

    if (rawOptions.length > MAX_OPTIONS) {
      errors.push({
        line: number,
        message: `${rawOptions.length} options; at most ${MAX_OPTIONS} are allowed.`,
      });
      continue;
    }

    const marked = rawOptions
      .map((option, index) => (option.startsWith('*') ? index : -1))
      .filter((index) => index !== -1);

    if (marked.length === 0) {
      errors.push({ line: number, message: 'No correct answer marked. Put * before one option.' });
      continue;
    }

    if (marked.length > 1) {
      errors.push({
        line: number,
        message: `${marked.length} options marked correct; exactly one * is allowed.`,
      });
      continue;
    }

    const options = rawOptions.map((option) => option.replace(/^\*\s*/, '').trim());

    if (options.some((option) => option === '')) {
      errors.push({ line: number, message: 'An option is empty.' });
      continue;
    }

    questions.push({
      line: number,
      type: 'choice',
      text,
      options,
      correctIndex: marked[0],
      points: 1,
    });
  }

  return { questions, errors };
}
