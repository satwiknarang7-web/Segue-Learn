/**
 * Draft quiz questions with Gemini.
 *
 * Plain fetch against the Interactions API, so the project keeps its zero
 * dependencies. The key is server-side only and never reaches a browser.
 *
 * The model is asked for structured JSON rather than prose, because parsing a
 * model's free text is the part that breaks quietly. Even so, nothing it
 * returns is trusted: every question goes through the same validation a typed
 * one does, and a person reviews the draft before it becomes a quiz.
 */

const ENDPOINT =
  process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const MIN_COUNT = 1;
const MAX_COUNT = 25;

/**
 * The shape the model must return.
 *
 * Only text and type are required: a choice question carries options and
 * correctIndex, a typed one carries acceptedAnswers, and asking for all four
 * every time is what produces empty arrays glued onto the wrong kind.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['choice', 'short'] },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctIndex: { type: 'integer' },
          acceptedAnswers: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'text'],
      },
    },
  },
  required: ['questions'],
};

export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

const STYLE_INSTRUCTIONS = {
  choice: ['- Every question must be type "choice".'],
  short: ['- Every question must be type "short".'],
  mixed: [
    '- Mix both types. Use "short" where there is one obvious word, name or',
    '  number to give, and "choice" where the answer needs options to be fair.',
  ],
};

function buildPrompt({ topic, count, difficulty, notes, style }) {
  const lines = [
    `Write ${count} quiz questions about: ${topic}.`,
    '',
    'Each question is one of two types.',
    '',
    'type "choice" - the taker picks an option:',
    '- Give 3 to 5 options, exactly one of them correct.',
    '- correctIndex is the zero-based position of the correct option.',
    '- Wrong options must be plausible, not obviously silly.',
    '- Vary which position the correct answer sits in.',
    '',
    'type "short" - the taker types the answer:',
    '- Give acceptedAnswers: every spelling a teacher would mark right.',
    '- Include abbreviations and unit variants, e.g. ["15 N", "15 newtons"].',
    '- Ask these only where the answer is a short, unambiguous word, name or',
    '  number. If a reasonable person could word it several ways, use "choice".',
    '- Do not give options or correctIndex for these.',
    '',
    'Rules for both:',
    ...(STYLE_INSTRUCTIONS[style] ?? STYLE_INSTRUCTIONS.mixed),
    '- Keep each question to one sentence where possible.',
    '- Do not number the questions, and do not repeat a question.',
    '- Ask only about things that are settled and checkable, not opinion.',
  ];

  if (difficulty) lines.push(`- Aim for ${difficulty} difficulty.`);
  if (notes) lines.push('', `Extra instructions from the teacher: ${notes}`);

  return lines.join('\n');
}

/** The two documented shapes for where the generated text ends up. */
function extractText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim() !== '') {
    return payload.output_text;
  }

  const fromSteps = (payload?.steps ?? [])
    .flatMap((step) => step?.content ?? [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string' && text.trim() !== '')
    .join('');

  if (fromSteps) return fromSteps;

  throw new Error('Gemini returned a response with no text in it.');
}

export async function generateQuestions(
  { topic, count = 10, difficulty = '', notes = '', style = 'mixed' },
  { fetchImpl = fetch, signal } = {},
) {
  if (!isConfigured()) {
    throw new Error('Question generation is switched off: GEMINI_API_KEY is not set.');
  }

  const wanted = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Number(count) || 10));

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt({ topic, count: wanted, difficulty, notes, style }),
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (error) {
    // No response at all: DNS, firewall, or the endpoint being unreachable.
    // "fetch failed" on its own is useless to whoever sees it.
    throw new Error(`Could not reach Gemini (${error.message}). Check the server's connection.`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Say which failure it is: a bad key and a rate limit need different fixes.
    if (response.status === 401 || response.status === 403) {
      throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Gemini is rate limiting this key. Wait a moment and try again.');
    }
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const text = extractText(await response.json());

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini did not return usable JSON. Try again, or reword the topic.');
  }

  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (questions.length === 0) throw new Error('Gemini returned no questions. Try a clearer topic.');

  // Shape only. Real validation happens where a typed question is validated.
  const usable = questions.map(readQuestion).filter(Boolean);

  // Returning an empty list here would show a teacher an empty box and no
  // reason for it, which reads as the feature being broken.
  if (usable.length === 0) {
    throw new Error('Gemini returned questions, but none were usable. Try again.');
  }

  return usable;
}

/** One drafted question, or null if it is not usable as either type. */
function readQuestion(question) {
  if (typeof question?.text !== 'string' || question.text.trim() === '') return null;
  const text = question.text.trim();

  if (question.type === 'short') {
    const accepted = (Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [])
      .map((answer) => String(answer).trim())
      .filter((answer) => answer !== '');

    return accepted.length > 0 ? { type: 'short', text, acceptedAnswers: accepted } : null;
  }

  // Anything not explicitly short is judged as a choice question, so a model
  // that omits the type field still produces something usable.
  if (!Array.isArray(question.options) || !Number.isInteger(question.correctIndex)) return null;
  const options = question.options.map((option) => String(option).trim());
  if (question.correctIndex < 0 || question.correctIndex >= options.length) return null;

  return { type: 'choice', text, options, correctIndex: question.correctIndex };
}

/**
 * Render drafts in the same pasted-text format the bulk importer reads, so an
 * AI draft and a spreadsheet paste land in exactly the same review box.
 */
export function toPasteFormat(questions) {
  return questions
    .map((question) => {
      const cells =
        question.type === 'short'
          ? [`=${question.text}`, ...question.acceptedAnswers]
          : [
              question.text,
              ...question.options.map((option, index) =>
                index === question.correctIndex ? `*${option}` : option,
              ),
            ];

      // Tabs are the separator, so strip any the model produced.
      return cells.map((cell) => cell.replace(/\t/g, ' ')).join('\t');
    })
    .join('\n');
}

/* ---- Suggesting a mark for a drawing ------------------------------------ */

const MARK_SCHEMA = {
  type: 'object',
  properties: {
    points: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['points', 'reason'],
};

function buildMarkPrompt({ questionText, maxPoints, guidance }) {
  const lines = [
    'You are helping a teacher mark one hand-drawn answer.',
    '',
    `The question was: ${questionText}`,
    `It is worth ${maxPoints} point(s).`,
    '',
    'Look at the drawing and suggest a mark out of those points.',
    '',
    'Rules:',
    `- points must be a whole number from 0 to ${maxPoints}.`,
    '- reason must be one short sentence a teacher could read out.',
    '- Judge only what is drawn. Do not assume anything not visible.',
    '- Say so in the reason if the drawing is unclear or you cannot tell what',
    '  it shows, and mark low rather than guessing generously.',
    '- Neatness is not the point. Mark what the drawing shows, not how tidy it is.',
  ];

  if (guidance) lines.push('', `What the teacher is looking for: ${guidance}`);

  return lines.join('\n');
}

/**
 * Ask for a suggested mark on one drawing.
 *
 * A suggestion only. Nothing here writes a mark: the caller shows it to the
 * teacher, who awards the points. Marking a child's work is not a decision to
 * hand to a model, and the clamp in awardFor means an accepted suggestion still
 * cannot exceed what the question is worth.
 */
export async function suggestMark(
  { questionText, maxPoints, guidance = '', imageBase64, mimeType = 'image/png' },
  { fetchImpl = fetch, signal } = {},
) {
  if (!isConfigured()) {
    throw new Error('Mark suggestions are switched off: GEMINI_API_KEY is not set.');
  }
  if (!imageBase64) throw new Error('There is no drawing to look at.');

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildMarkPrompt({ questionText, maxPoints, guidance }) },
              { type: 'image', mime_type: mimeType, data: imageBase64 },
            ],
          },
        ],
        response_format: { type: 'text', mime_type: 'application/json', schema: MARK_SCHEMA },
      }),
    });
  } catch (error) {
    throw new Error(`Could not reach Gemini (${error.message}). Check the server's connection.`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY.');
    }
    if (response.status === 429) {
      throw new Error('Gemini is rate limiting this key. Wait a moment and try again.');
    }
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(extractText(await response.json()));
  } catch {
    throw new Error('Gemini did not return a usable suggestion. Mark it yourself.');
  }

  if (!Number.isFinite(Number(parsed?.points))) {
    throw new Error('Gemini did not suggest a mark. Mark it yourself.');
  }

  return {
    // Clamped here as well as at the point of award, so a teacher is never
    // shown a suggestion the question could not carry.
    points: Math.max(0, Math.min(maxPoints, Math.round(Number(parsed.points)))),
    reason: String(parsed.reason ?? '').slice(0, 300),
  };
}
