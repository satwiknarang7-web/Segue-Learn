import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { freshDatabase, truncateAll } from './helpers/database.js';
import { signedInClient, startTestServer } from './helpers/http.js';

const { close } = await freshDatabase();

const { universityRepository } = await import('../src/repositories/universityRepository.js');
const { quizRepository } = await import('../src/repositories/quizRepository.js');

let harness;

before(async () => {
  harness = await startTestServer();
});

after(async () => {
  await harness.close();
  await close();
});

beforeEach(() => truncateAll());

const seedUniversity = () =>
  universityRepository.insert({
    name: 'Test University',
    slug: 'test',
    emailDomain: 'test.edu',
    facultySignupCode: 'STAFF',
  });

/** A classroom with a teacher and one enrolled student. */
async function seedClassroom() {
  await seedUniversity();
  const teacher = await signedInClient(harness, {
    email: 'teacher@test.edu',
    facultyCode: 'STAFF',
  });
  const student = await signedInClient(harness, { email: 'student@test.edu' });

  const created = await teacher.post('/api/classrooms', { name: 'Discrete Maths' });
  assert.equal(created.status, 201, created.text);
  await student.post('/api/classrooms/join', { code: created.body.joinCode });

  return { teacher, student, classroomId: created.body.id };
}

const QUESTIONS = [
  {
    text: 'What is 2 + 2?',
    type: 'choice',
    options: ['3', '4', '5'],
    correctIndex: 1,
    points: 2,
  },
  {
    text: 'Name the smallest prime.',
    type: 'short',
    acceptedAnswers: ['2', 'two'],
    points: 3,
  },
];

/** A published quiz with both question types. */
async function seedQuiz(teacher, classroomId, settings = {}) {
  const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
    title: 'Week 1',
    timeLimitSeconds: 600,
    ...settings,
  });
  assert.equal(quiz.status, 201, quiz.text);

  for (const question of QUESTIONS) {
    const added = await teacher.post(
      `/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`,
      question,
    );
    assert.equal(added.status, 201, added.text);
  }

  await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}`, {
    isPublished: true,
  });

  return quiz.body.id;
}

describe('authoring', () => {
  it('refuses a student who tries to create a quiz', async () => {
    const { student, classroomId } = await seedClassroom();
    const response = await student.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Nope',
      timeLimitSeconds: 60,
    });
    assert.equal(response.status, 403);
  });

  it('will not publish a quiz with no questions', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Empty',
      timeLimitSeconds: 60,
    });

    const response = await teacher.patch(
      `/api/classrooms/${classroomId}/quizzes/${quiz.body.id}`,
      { isPublished: true },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /at least one question/i);
  });

  it('unpublishes a quiz when its last question is removed', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const quiz = await teacher.get(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    for (const question of quiz.body.questions) {
      await teacher.del(
        `/api/classrooms/${classroomId}/quizzes/${quizId}/questions/${question.id}`,
      );
    }

    const after = await teacher.get(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    assert.equal(after.body.isPublished, false);
  });

  it('rejects duplicate options and duplicate accepted answers', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Q',
      timeLimitSeconds: 60,
    });
    const path = `/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`;

    const options = await teacher.post(path, {
      text: 'Pick',
      options: ['same', 'SAME'],
      correctIndex: 0,
    });
    assert.equal(options.status, 400);

    // Duplicates are caught with the same normalisation that grades, so
    // "2" and " 2 " are one answer, not two.
    const answers = await teacher.post(path, {
      text: 'Type',
      type: 'short',
      acceptedAnswers: ['2', ' 2 '],
    });
    assert.equal(answers.status, 400);
  });

  it('refuses a drawn question until file storage exists', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Q',
      timeLimitSeconds: 60,
    });

    const response = await teacher.post(
      `/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`,
      { text: 'Sketch a graph', type: 'draw' },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /file storage/i);
  });

  it('refuses a due date before the quiz opens', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const response = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Q',
      timeLimitSeconds: 60,
      availableFrom: '2026-10-02T09:00:00Z',
      dueAt: '2026-10-01T09:00:00Z',
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /after the quiz opens/i);
  });
});

describe('what a student may see', () => {
  it('hides an unpublished quiz from students but shows it to staff', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Draft',
      timeLimitSeconds: 60,
    });

    const asStaff = await teacher.get(`/api/classrooms/${classroomId}/quizzes`);
    assert.equal(asStaff.body.length, 1);

    const asStudent = await student.get(`/api/classrooms/${classroomId}/quizzes`);
    assert.equal(asStudent.body.length, 0);
  });

  it('tells staff their own standing, not just everyone else\'s', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await seedQuiz(teacher, classroomId);

    const [quiz] = (await teacher.get(`/api/classrooms/${classroomId}/quizzes`)).body;

    // Staff are members too and may sit their own quiz. Without these the
    // taking page knew nothing and read the silence as "already taken".
    assert.equal(quiz.attemptsTaken, 0);
    assert.equal(quiz.canStart, true);
    assert.equal(quiz.inProgressAttemptId, null);

    // And they still get what only staff may see.
    assert.equal(quiz.attemptCount, 0);
    assert.ok(quiz.joinCode !== undefined);
  });

  it('never hands a student the answer key', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    // The full quiz endpoint is staff-only.
    const full = await student.get(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    assert.equal(full.status, 403);

    // And the taking view carries no correctIndex or acceptedAnswers.
    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const serialised = JSON.stringify(started.body.quiz);
    assert.doesNotMatch(serialised, /correctIndex/);
    assert.doesNotMatch(serialised, /acceptedAnswers/);
  });

  it('keeps a quiz away from somebody who is not in the classroom', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });

    const list = await outsider.get(`/api/classrooms/${classroomId}/quizzes`);
    assert.equal(list.status, 404);

    const start = await outsider.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    assert.equal(start.status, 404);
  });
});

describe('taking a quiz', () => {
  it('grades both question types and reports the score', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { revealAnswers: true });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    assert.equal(started.status, 201);

    const { attemptId } = started.body.attempt;
    const shown = started.body.quiz.questions;

    // Answer the multiple choice by the index it was shown at, and the short
    // answer in a spelling the key does not list literally.
    const choice = shown.find((q) => q.type === 'choice');
    const short = shown.find((q) => q.type === 'short');

    const submitted = await student.post(`/api/attempts/${attemptId}/submit`, {
      answers: {
        [choice.id]: choice.options.indexOf('4'),
        [short.id]: '  TWO  ',
      },
    });

    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(submitted.body.score, 5);
    assert.equal(submitted.body.maxScore, 5);
    assert.equal(submitted.body.correctCount, 2);
    assert.ok(Array.isArray(submitted.body.review));
  });

  it('withholds the review unless the quiz reveals answers', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { revealAnswers: false });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const submitted = await student.post(
      `/api/attempts/${started.body.attempt.attemptId}/submit`,
      { answers: {} },
    );

    assert.equal(submitted.body.review, undefined);
  });

  it('resumes an attempt already running instead of restarting the clock', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const first = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    const second = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);

    assert.equal(second.status, 200);
    assert.equal(second.body.resumed, true);
    assert.equal(second.body.attempt.attemptId, first.body.attempt.attemptId);
    assert.equal(second.body.attempt.deadlineAt, first.body.attempt.deadlineAt);
  });

  it('allows one attempt unless retakes are switched on', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { allowRetakes: false });

    const first = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    await student.post(`/api/attempts/${first.body.attempt.attemptId}/submit`, { answers: {} });

    const again = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already taken/i);
  });

  it('numbers retakes rather than overwriting the first try', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { allowRetakes: true });

    const first = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    await student.post(`/api/attempts/${first.body.attempt.attemptId}/submit`, { answers: {} });

    const second = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    await student.post(`/api/attempts/${second.body.attempt.attemptId}/submit`, { answers: {} });

    assert.equal(first.body.attempt.attemptNumber, 1);
    assert.equal(second.body.attempt.attemptNumber, 2);

    const mine = await student.get(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts/mine`,
    );
    assert.equal(mine.body.length, 2);
  });

  it('autosaves an answer so a closed tab does not lose it', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const { attemptId } = started.body.attempt;
    const choice = started.body.quiz.questions.find((q) => q.type === 'choice');

    await student.post(`/api/attempts/${attemptId}/answers`, {
      questionId: choice.id,
      answer: choice.options.indexOf('4'),
    });

    // Submitting with no answers at all still keeps what was saved.
    const submitted = await student.post(`/api/attempts/${attemptId}/submit`, { answers: {} });
    assert.equal(submitted.body.score, 2);
  });

  it('will not let a student open somebody else\'s attempt', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const classmate = await signedInClient(harness, { email: 'classmate@test.edu' });
    const classroom = await teacher.get(`/api/classrooms/${classroomId}`);
    await classmate.post('/api/classrooms/join', { code: classroom.body.joinCode });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const { attemptId } = started.body.attempt;

    assert.equal((await classmate.get(`/api/attempts/${attemptId}`)).status, 404);
    assert.equal(
      (await classmate.post(`/api/attempts/${attemptId}/submit`, { answers: {} })).status,
      404,
    );
  });
});

describe('the availability window', () => {
  it('refuses a quiz that has not opened yet', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, {
      availableFrom: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const response = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    assert.equal(response.status, 409);
    assert.match(response.body.error, /not opened yet/i);
  });

  it('refuses a quiz whose due date has passed', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    // Set the window into the past only after publishing, so seeding is simple.
    await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quizId}`, {
      dueAt: new Date(Date.now() - 1000).toISOString(),
    });

    const response = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    assert.equal(response.status, 410);
  });

  it('reports the state to the student without letting them start', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    await seedQuiz(teacher, classroomId, {
      availableFrom: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const list = await student.get(`/api/classrooms/${classroomId}/quizzes`);
    assert.equal(list.body[0].state, 'scheduled');
    assert.equal(list.body[0].canStart, false);
  });
});

describe('shuffling', () => {
  it('keeps one attempt\'s option order stable across reloads', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { shuffleOptions: true });

    const first = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
    const second = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);

    const optionsOf = (payload) => payload.body.quiz.questions.find((q) => q.options)?.options;
    assert.deepEqual(optionsOf(first), optionsOf(second));
  });

  it('marks a shuffled answer against the key, not the displayed order', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { shuffleOptions: true });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const choice = started.body.quiz.questions.find((q) => q.options);

    const submitted = await student.post(
      `/api/attempts/${started.body.attempt.attemptId}/submit`,
      { answers: { [choice.id]: choice.options.indexOf('4') } },
    );

    assert.equal(submitted.body.score, 2);
  });

  it('scores a wrong pick as zero whatever position it was shown in', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { shuffleOptions: true });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const choice = started.body.quiz.questions.find((q) => q.options);

    const submitted = await student.post(
      `/api/attempts/${started.body.attempt.attemptId}/submit`,
      { answers: { [choice.id]: choice.options.indexOf('5') } },
    );

    assert.equal(submitted.body.score, 0);
  });
});

describe('results', () => {
  it('ranks submitted attempts and names the students', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    const choice = started.body.quiz.questions.find((q) => q.type === 'choice');
    await student.post(`/api/attempts/${started.body.attempt.attemptId}/submit`, {
      answers: { [choice.id]: choice.options.indexOf('4') },
    });

    const results = await teacher.get(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/results`,
    );
    assert.equal(results.status, 200, results.text);
    assert.equal(results.body.attempts.length, 1);
    assert.equal(results.body.attempts[0].studentName, 'student');
    assert.equal(results.body.attempts[0].score, 2);
    assert.equal(results.body.attempts[0].rank, 1);
  });

  it('keeps results away from students', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const response = await student.get(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/results`,
    );
    assert.equal(response.status, 403);
  });

  it('clearing results lets a one-attempt quiz be run again', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { allowRetakes: false });

    const started = await student.post(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`,
    );
    await student.post(`/api/attempts/${started.body.attempt.attemptId}/submit`, { answers: {} });

    assert.equal(
      (await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`)).status,
      409,
    );

    await teacher.del(`/api/classrooms/${classroomId}/quizzes/${quizId}/results`);

    assert.equal(
      (await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`)).status,
      201,
    );
  });
});
