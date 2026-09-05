import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { freshDatabase, truncateAll } from './helpers/database.js';
import { signedInClient, startTestServer } from './helpers/http.js';

const { close } = await freshDatabase();

const { universityRepository } = await import('../src/repositories/universityRepository.js');

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

async function seedClassroom() {
  await seedUniversity();
  const teacher = await signedInClient(harness, {
    email: 'teacher@test.edu',
    facultyCode: 'STAFF',
  });
  const student = await signedInClient(harness, { email: 'student@test.edu', name: 'Ada' });

  const created = await teacher.post('/api/classrooms', { name: 'Discrete Maths' });
  await student.post('/api/classrooms/join', { code: created.body.joinCode });

  return { teacher, student, classroomId: created.body.id, joinCode: created.body.joinCode };
}

/** A published quiz worth 5 marks: one 2-mark choice, one 3-mark short answer. */
async function seedQuiz(teacher, classroomId, settings = {}) {
  const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
    title: 'Week 1',
    timeLimitSeconds: 600,
    ...settings,
  });

  await teacher.post(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`, {
    text: 'What is 2 + 2?',
    options: ['3', '4', '5'],
    correctIndex: 1,
    points: 2,
  });
  await teacher.post(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`, {
    text: 'Smallest prime?',
    type: 'short',
    acceptedAnswers: ['2', 'two'],
    points: 3,
  });

  await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}`, {
    isPublished: true,
  });

  return quiz.body.id;
}

/** Takes the quiz, answering the choice correctly and optionally the short one. */
async function takeQuiz(student, classroomId, quizId, { full = true } = {}) {
  const started = await student.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/attempts`);
  const shown = started.body.quiz.questions;
  const choice = shown.find((q) => q.type === 'choice');
  const short = shown.find((q) => q.type === 'short');

  const answers = { [choice.id]: choice.options.indexOf('4') };
  if (full) answers[short.id] = 'two';

  const submitted = await student.post(
    `/api/attempts/${started.body.attempt.attemptId}/submit`,
    { answers },
  );
  return submitted.body;
}

const gradebook = (client, classroomId) => client.get(`/api/classrooms/${classroomId}/gradebook`);

describe('columns', () => {
  it('refuses a student who tries to add a column', async () => {
    const { student, classroomId } = await seedClassroom();
    const response = await student.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Nope',
      pointsPossible: 10,
    });
    assert.equal(response.status, 403);
  });

  it('creates a manual column', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay 1',
      pointsPossible: 40,
    });

    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.sourceType, 'manual');
    assert.equal(created.body.pointsPossible, 40);
  });

  it('refuses a column worth nothing', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const response = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Zero',
      pointsPossible: 0,
    });
    assert.equal(response.status, 400);
  });

  it('offers published quizzes that are not in the gradebook yet', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    const before = await teacher.get(
      `/api/classrooms/${classroomId}/gradebook/available-quizzes`,
    );
    assert.equal(before.body.length, 1);
    assert.equal(before.body[0].totalPoints, 5);

    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });

    const after = await teacher.get(`/api/classrooms/${classroomId}/gradebook/available-quizzes`);
    assert.equal(after.body.length, 0);
  });

  it('does not offer an unpublished quiz', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Draft',
      timeLimitSeconds: 60,
    });

    const available = await teacher.get(
      `/api/classrooms/${classroomId}/gradebook/available-quizzes`,
    );
    assert.equal(available.body.length, 0);
  });

  it('refuses the same quiz twice', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);

    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    const again = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      quizId,
    });

    assert.equal(again.status, 409);
  });

  it("will not let a quiz column's marks be edited by hand", async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      quizId,
    });

    const response = await teacher.patch(
      `/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}`,
      { pointsPossible: 99 },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /come from the quiz/i);
  });
});

describe('quiz-backed columns', () => {
  it('reads a score straight from the attempt', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });

    await takeQuiz(student, classroomId, quizId);

    const grid = await gradebook(teacher, classroomId);
    const cell = grid.body.rows[0].cells[0];

    assert.equal(cell.points, 5);
    assert.equal(cell.max, 5);
    assert.equal(cell.source, 'quiz');
  });

  it('follows the quiz when its total changes', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    await takeQuiz(student, classroomId, quizId);

    // A sixth mark is added to the quiz after the column was made.
    await teacher.post(`/api/classrooms/${classroomId}/quizzes/${quizId}/questions`, {
      text: 'Extra',
      options: ['a', 'b'],
      correctIndex: 0,
      points: 4,
    });

    const grid = await gradebook(teacher, classroomId);
    // The column's maximum is the quiz's, live -- not the 5 it was created with.
    assert.equal(grid.body.items[0].pointsPossible, 9);
  });

  it('clearing a quiz\'s results empties the column rather than stranding a score', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    await takeQuiz(student, classroomId, quizId);

    assert.equal((await gradebook(teacher, classroomId)).body.rows[0].cells[0].points, 5);

    await teacher.del(`/api/classrooms/${classroomId}/quizzes/${quizId}/results`);

    const after = await gradebook(teacher, classroomId);
    assert.equal(after.body.rows[0].cells[0].points, null);
    assert.equal(after.body.rows[0].cells[0].graded, false);
  });

  it('takes the best attempt when retakes are allowed', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { allowRetakes: true });
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });

    // A weak attempt first, then a perfect one.
    await takeQuiz(student, classroomId, quizId, { full: false });
    await takeQuiz(student, classroomId, quizId, { full: true });

    const grid = await gradebook(teacher, classroomId);
    assert.equal(grid.body.rows[0].cells[0].points, 5);
    assert.equal(grid.body.rows[0].cells[0].attempts, 2);
  });

  it('refuses to delete a quiz that counts towards a grade', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      quizId,
    });
    await takeQuiz(student, classroomId, quizId);

    // A gradebook column can hold marks typed by hand, so deleting the quiz
    // would be silent data loss. The teacher is told to remove the column.
    const refused = await teacher.del(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /in the gradebook/i);

    // The quiz and its attempts are untouched.
    const results = await teacher.get(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/results`,
    );
    assert.equal(results.body.attempts.length, 1);

    // Removing the column first is what makes the delete possible.
    await teacher.del(`/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}`);
    const allowed = await teacher.del(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    assert.equal(allowed.status, 200);
  });

  it('removing a quiz column leaves the quiz and its attempts alone', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      quizId,
    });
    await takeQuiz(student, classroomId, quizId);

    await teacher.del(`/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}`);

    const results = await teacher.get(
      `/api/classrooms/${classroomId}/quizzes/${quizId}/results`,
    );
    assert.equal(results.body.attempts.length, 1);
  });
});

describe('overrides', () => {
  it('a written mark beats the quiz score, and clearing it gives the score back', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      quizId,
    });
    await takeQuiz(student, classroomId, quizId);

    const studentId = (await gradebook(teacher, classroomId)).body.rows[0].studentId;
    const cellPath = `/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}/grades/${studentId}`;

    await teacher.put(cellPath, { points: 3, feedback: 'Question 2 was ambiguous.' });

    const overridden = (await gradebook(teacher, classroomId)).body.rows[0].cells[0];
    assert.equal(overridden.points, 3);
    assert.equal(overridden.source, 'override');
    assert.equal(overridden.feedback, 'Question 2 was ambiguous.');

    await teacher.del(cellPath);

    const reverted = (await gradebook(teacher, classroomId)).body.rows[0].cells[0];
    assert.equal(reverted.points, 5);
    assert.equal(reverted.source, 'quiz');
  });

  it('refuses a mark above what the column is worth', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 20,
    });
    void student;

    const studentId = (await gradebook(teacher, classroomId)).body.rows[0].studentId;
    const response = await teacher.put(
      `/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}/grades/${studentId}`,
      { points: 21 },
    );

    assert.equal(response.status, 400);
    assert.match(response.body.error, /more than the 20 marks/i);
  });

  it('refuses a mark for somebody not in the classroom', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });
    void outsider;

    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 20,
    });

    const response = await teacher.put(
      `/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}/grades/00000000-0000-0000-0000-000000000000`,
      { points: 5 },
    );
    assert.equal(response.status, 404);
  });
});

describe('what a student sees', () => {
  it('shows a student their own row and nobody else\'s', async () => {
    const { teacher, student, classroomId, joinCode } = await seedClassroom();
    const classmate = await signedInClient(harness, {
      email: 'classmate@test.edu',
      name: 'Grace',
    });
    await classmate.post('/api/classrooms/join', { code: joinCode });

    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    await takeQuiz(student, classroomId, quizId);
    await takeQuiz(classmate, classroomId, quizId, { full: false });

    const asTeacher = await gradebook(teacher, classroomId);
    assert.equal(asTeacher.body.rows.length, 2);
    assert.equal(asTeacher.body.canEdit, true);

    const asStudent = await gradebook(student, classroomId);
    assert.equal(asStudent.body.rows.length, 1);
    assert.equal(asStudent.body.canEdit, false);
    assert.equal(asStudent.body.rows[0].name, 'Ada');
    // No email addresses reach a student.
    assert.equal(asStudent.body.rows[0].email, undefined);
  });

  it('refuses a student who tries to write a mark', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const column = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 20,
    });
    const studentId = (await gradebook(teacher, classroomId)).body.rows[0].studentId;

    const response = await student.put(
      `/api/classrooms/${classroomId}/gradebook/columns/${column.body.id}/grades/${studentId}`,
      { points: 20 },
    );
    assert.equal(response.status, 403);
  });
});

describe('the running total', () => {
  it('counts only what has been graded', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    // A second column nobody has been graded on yet.
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 45,
    });

    await takeQuiz(student, classroomId, quizId);

    const { total } = (await gradebook(teacher, classroomId)).body.rows[0];

    // 5/5, not 5/50: an essay nobody has sat must not read as a zero.
    assert.equal(total.earned, 5);
    assert.equal(total.possible, 5);
    assert.equal(total.percent, 100);
    assert.equal(total.gradedCount, 1);
  });

  it('reports no percentage when nothing has been graded', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 45,
    });

    const { total } = (await gradebook(teacher, classroomId)).body.rows[0];
    assert.equal(total.percent, null);
    assert.equal(total.gradedCount, 0);
  });

  it('mixes a manual mark and a quiz score into one total', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId);
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });
    const essay = await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay',
      pointsPossible: 15,
    });

    await takeQuiz(student, classroomId, quizId);
    const studentId = (await gradebook(teacher, classroomId)).body.rows[0].studentId;
    await teacher.put(
      `/api/classrooms/${classroomId}/gradebook/columns/${essay.body.id}/grades/${studentId}`,
      { points: 12 },
    );

    const { total } = (await gradebook(teacher, classroomId)).body.rows[0];
    assert.equal(total.earned, 17);
    assert.equal(total.possible, 20);
    assert.equal(total.percent, 85);
  });
});
