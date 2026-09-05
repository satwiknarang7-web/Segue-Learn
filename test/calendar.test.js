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

  return { teacher, student, classroomId: created.body.id };
}

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const WINDOW = { from: at(-30), to: at(60) };

const calendar = (client, classroomId, window = WINDOW) =>
  client.get(
    `/api/classrooms/${classroomId}/calendar?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
  );

const addEvent = (client, classroomId, payload) =>
  client.post(`/api/classrooms/${classroomId}/calendar/events`, payload);

describe('events', () => {
  it('refuses a student who tries to add one', async () => {
    const { student, classroomId } = await seedClassroom();
    const response = await addEvent(student, classroomId, {
      title: 'Nope',
      startsAt: at(1),
    });
    assert.equal(response.status, 403);
  });

  it('lets staff add one, and students see it', async () => {
    const { teacher, student, classroomId } = await seedClassroom();

    const created = await addEvent(teacher, classroomId, {
      title: 'Guest lecture',
      description: 'Prof. Knuth on analysis of algorithms.',
      startsAt: at(3),
      endsAt: at(3.1),
      kind: 'class',
    });
    assert.equal(created.status, 201, created.text);

    const seen = await calendar(student, classroomId);
    assert.equal(seen.body.entries.length, 1);
    assert.equal(seen.body.entries[0].title, 'Guest lecture');
    assert.equal(seen.body.entries[0].kind, 'class');
    // A student cannot edit anything.
    assert.equal(seen.body.canEdit, false);
    assert.equal(seen.body.entries[0].editable, false);
  });

  it('refuses an event that ends before it starts', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const response = await addEvent(teacher, classroomId, {
      title: 'Backwards',
      startsAt: at(5),
      endsAt: at(4),
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /cannot end before it starts/i);
  });

  it('refuses a kind it does not know', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const response = await addEvent(teacher, classroomId, {
      title: 'Odd',
      startsAt: at(1),
      kind: 'party',
    });
    assert.equal(response.status, 400);
  });

  it('edits and deletes', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await addEvent(teacher, classroomId, {
      title: 'Seminar',
      startsAt: at(2),
    });
    const path = `/api/classrooms/${classroomId}/calendar/events/${created.body.id}`;

    const edited = await teacher.patch(path, { title: 'Seminar (moved)', kind: 'exam' });
    assert.equal(edited.body.title, 'Seminar (moved)');
    assert.equal(edited.body.kind, 'exam');

    await teacher.del(path);
    assert.equal((await calendar(teacher, classroomId)).body.entries.length, 0);
  });

  it('keeps the calendar away from somebody not in the classroom', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await addEvent(teacher, classroomId, { title: 'Members only', startsAt: at(1) });

    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });
    assert.equal((await calendar(outsider, classroomId)).status, 404);
  });
});

describe('derived deadlines', () => {
  /** A published quiz with a due date. */
  async function seedQuiz(teacher, classroomId, { dueAt, publish = true } = {}) {
    const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title: 'Week 1 quiz',
      timeLimitSeconds: 600,
      dueAt,
    });
    await teacher.post(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`, {
      text: 'What is 2 + 2?',
      options: ['3', '4'],
      correctIndex: 1,
    });
    if (publish) {
      await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}`, {
        isPublished: true,
      });
    }
    return quiz.body.id;
  }

  it('shows a published quiz due date without anybody copying it there', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    await seedQuiz(teacher, classroomId, { dueAt: at(7) });

    const seen = await calendar(student, classroomId);
    const entry = seen.body.entries.find((e) => e.derivedFrom === 'quiz');

    assert.ok(entry, 'the quiz deadline should appear');
    assert.equal(entry.title, 'Week 1 quiz');
    assert.equal(entry.kind, 'due');
    // Derived, so not editable even by staff.
    assert.equal(entry.editable, false);
  });

  it('moves the calendar entry when the quiz due date moves', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { dueAt: at(7) });

    const before = await calendar(teacher, classroomId);
    const original = before.body.entries.find((e) => e.derivedFrom === 'quiz').startsAt;

    // Captured once: at() is relative to now, and now moves between calls.
    const newDueAt = at(14);
    await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quizId}`, { dueAt: newDueAt });

    const after = await calendar(teacher, classroomId);
    const moved = after.body.entries.find((e) => e.derivedFrom === 'quiz').startsAt;

    assert.notEqual(moved, original);
    // Nothing was copied, so nothing had to be kept in step.
    assert.equal(new Date(moved).getTime(), new Date(newDueAt).getTime());
  });

  it('leaves an unpublished quiz off the calendar', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await seedQuiz(teacher, classroomId, { dueAt: at(7), publish: false });

    const seen = await calendar(teacher, classroomId);
    assert.equal(seen.body.entries.filter((e) => e.derivedFrom === 'quiz').length, 0);
  });

  it('shows a gradebook deadline', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, {
      title: 'Essay 1',
      pointsPossible: 40,
      dueAt: at(10),
    });

    const seen = await calendar(student, classroomId);
    const entry = seen.body.entries.find((e) => e.derivedFrom === 'assessment');

    assert.ok(entry, 'the essay deadline should appear');
    assert.equal(entry.title, 'Essay 1');
    assert.equal(entry.editable, false);
  });

  it('does not show a quiz deadline twice when it is also a gradebook column', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { dueAt: at(7) });

    // Adding the quiz to the gradebook copies its due date onto the column.
    await teacher.post(`/api/classrooms/${classroomId}/gradebook/columns`, { quizId });

    const seen = await calendar(teacher, classroomId);
    const deadlines = seen.body.entries.filter((e) => e.kind === 'due');
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0].derivedFrom, 'quiz');
  });

  it('refuses to edit or delete a derived deadline through the calendar', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const quizId = await seedQuiz(teacher, classroomId, { dueAt: at(7) });

    const path = `/api/classrooms/${classroomId}/calendar/events/${quizId}`;

    const edited = await teacher.patch(path, { title: 'Renamed' });
    assert.equal(edited.status, 404);
    assert.match(edited.body.error, /changed where it is set/i);

    const removed = await teacher.del(path);
    assert.equal(removed.status, 404);

    // And the quiz is untouched.
    const quiz = await teacher.get(`/api/classrooms/${classroomId}/quizzes/${quizId}`);
    assert.equal(quiz.body.title, 'Week 1 quiz');
  });
});

describe('the window', () => {
  it('leaves out anything outside the range asked for', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await addEvent(teacher, classroomId, { title: 'Soon', startsAt: at(2) });
    await addEvent(teacher, classroomId, { title: 'Far off', startsAt: at(200) });

    const seen = await calendar(teacher, classroomId, { from: at(0), to: at(30) });
    assert.deepEqual(
      seen.body.entries.map((e) => e.title),
      ['Soon'],
    );
  });

  it('is half-open, so a day is never in two windows at once', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const boundary = at(10);
    await addEvent(teacher, classroomId, { title: 'On the boundary', startsAt: boundary });

    const before = await calendar(teacher, classroomId, { from: at(0), to: boundary });
    const after = await calendar(teacher, classroomId, { from: boundary, to: at(20) });

    assert.equal(before.body.entries.length, 0);
    assert.equal(after.body.entries.length, 1);
  });

  it('refuses a range that is backwards or absurdly wide', async () => {
    const { teacher, classroomId } = await seedClassroom();

    assert.equal((await calendar(teacher, classroomId, { from: at(10), to: at(1) })).status, 400);
    assert.equal(
      (await calendar(teacher, classroomId, { from: at(0), to: at(500) })).status,
      400,
    );
  });

  it('lists what is coming up regardless of the window being viewed', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await addEvent(teacher, classroomId, { title: 'Next week', startsAt: at(7) });

    // Looking at last month still reports what is next.
    const seen = await calendar(teacher, classroomId, { from: at(-60), to: at(-30) });
    assert.equal(seen.body.entries.length, 0);
    assert.equal(seen.body.upcoming[0].title, 'Next week');
  });

  it('orders entries oldest first', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await addEvent(teacher, classroomId, { title: 'Third', startsAt: at(9) });
    await addEvent(teacher, classroomId, { title: 'First', startsAt: at(1) });
    await addEvent(teacher, classroomId, { title: 'Second', startsAt: at(5) });

    const seen = await calendar(teacher, classroomId);
    assert.deepEqual(
      seen.body.entries.map((e) => e.title),
      ['First', 'Second', 'Third'],
    );
  });
});
