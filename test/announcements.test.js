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
    name: 'Grace Hopper',
    facultyCode: 'STAFF',
  });
  const student = await signedInClient(harness, { email: 'student@test.edu', name: 'Ada' });

  const created = await teacher.post('/api/classrooms', { name: 'Discrete Maths' });
  await student.post('/api/classrooms/join', { code: created.body.joinCode });

  return { teacher, student, classroomId: created.body.id, joinCode: created.body.joinCode };
}

const list = (client, classroomId) =>
  client.get(`/api/classrooms/${classroomId}/announcements`);

const post = (client, classroomId, payload) =>
  client.post(`/api/classrooms/${classroomId}/announcements`, payload);

describe('posting', () => {
  it('refuses a student who tries to post', async () => {
    const { student, classroomId } = await seedClassroom();
    const response = await post(student, classroomId, {
      title: 'Nope',
      body: 'Not allowed.',
      publish: true,
    });
    assert.equal(response.status, 403);
  });

  it('publishes when asked to, and records the author', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Room change',
      body: 'Thursday is in Lecture Hall B.',
      publish: true,
    });

    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.isDraft, false);
    assert.equal(created.body.author, 'Grace Hopper');
    assert.ok(created.body.publishedAt);
  });

  it('saves an unpublished notice as a draft', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Next week',
      body: 'Not ready yet.',
    });

    assert.equal(created.body.isDraft, true);
    assert.equal(created.body.publishedAt, null);
  });

  it('refuses an empty body', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const response = await post(teacher, classroomId, { title: 'Hello', body: '   ' });
    assert.equal(response.status, 400);
  });
});

describe('what a student sees', () => {
  it('hides drafts from students and shows them to staff', async () => {
    const { teacher, student, classroomId } = await seedClassroom();

    await post(teacher, classroomId, { title: 'Published', body: 'Out.', publish: true });
    await post(teacher, classroomId, { title: 'Draft', body: 'Not out.' });

    const asStaff = await list(teacher, classroomId);
    assert.equal(asStaff.body.announcements.length, 2);
    assert.equal(asStaff.body.canPost, true);

    const asStudent = await list(student, classroomId);
    assert.equal(asStudent.body.announcements.length, 1);
    assert.equal(asStudent.body.announcements[0].title, 'Published');
    assert.equal(asStudent.body.canPost, false);
  });

  it('never sends a draft\'s text to a student', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    await post(teacher, classroomId, { title: 'Secret', body: 'Exam paper leaked here.' });

    const asStudent = await list(student, classroomId);
    // Withheld from the payload entirely, not hidden in the page.
    assert.doesNotMatch(asStudent.text, /Exam paper leaked/);
    assert.doesNotMatch(asStudent.text, /Secret/);
  });

  it('keeps announcements away from somebody not in the classroom', async () => {
    const { teacher, classroomId } = await seedClassroom();
    await post(teacher, classroomId, { title: 'Hello', body: 'Members only.', publish: true });

    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });
    const response = await list(outsider, classroomId);
    assert.equal(response.status, 404);
  });
});

describe('editing', () => {
  it('publishes a draft later without changing what it says', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const draft = await post(teacher, classroomId, { title: 'Later', body: 'Ready now.' });

    assert.equal((await list(student, classroomId)).body.announcements.length, 0);

    await teacher.patch(
      `/api/classrooms/${classroomId}/announcements/${draft.body.id}`,
      { publish: true },
    );

    const seen = await list(student, classroomId);
    assert.equal(seen.body.announcements.length, 1);
    assert.equal(seen.body.announcements[0].body, 'Ready now.');
  });

  it('keeps the original date when a published notice is corrected', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Room change',
      body: 'Hall A.',
      publish: true,
    });

    const corrected = await teacher.patch(
      `/api/classrooms/${classroomId}/announcements/${created.body.id}`,
      { body: 'Hall B, sorry.', publish: true },
    );

    // The class saw it when they saw it; a correction does not make it new.
    assert.equal(corrected.body.publishedAt, created.body.publishedAt);
    assert.equal(corrected.body.body, 'Hall B, sorry.');
  });

  it('can withdraw a published notice back to a draft', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Oops',
      body: 'Sent too early.',
      publish: true,
    });

    await teacher.patch(`/api/classrooms/${classroomId}/announcements/${created.body.id}`, {
      publish: false,
    });

    assert.equal((await list(student, classroomId)).body.announcements.length, 0);
  });

  it('refuses a student who tries to edit or delete', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Hello',
      body: 'Hi.',
      publish: true,
    });
    const path = `/api/classrooms/${classroomId}/announcements/${created.body.id}`;

    assert.equal((await student.patch(path, { body: 'Hacked.' })).status, 403);
    assert.equal((await student.del(path)).status, 403);
  });

  it('deletes', async () => {
    const { teacher, classroomId } = await seedClassroom();
    const created = await post(teacher, classroomId, {
      title: 'Temporary',
      body: 'Gone soon.',
      publish: true,
    });

    await teacher.del(`/api/classrooms/${classroomId}/announcements/${created.body.id}`);
    assert.equal((await list(teacher, classroomId)).body.announcements.length, 0);
  });
});

describe('ordering', () => {
  it('floats pinned notices above newer ones', async () => {
    const { teacher, classroomId } = await seedClassroom();

    const pinned = await post(teacher, classroomId, {
      title: 'Read me first',
      body: 'Course handbook.',
      publish: true,
      pinned: true,
    });
    await post(teacher, classroomId, { title: 'Newer', body: 'Later news.', publish: true });

    const { announcements } = (await list(teacher, classroomId)).body;
    assert.equal(announcements[0].id, pinned.body.id);
    assert.equal(announcements[0].pinned, true);
  });

  it('unpinning drops it back into date order', async () => {
    const { teacher, classroomId } = await seedClassroom();

    const first = await post(teacher, classroomId, {
      title: 'Older',
      body: 'a',
      publish: true,
      pinned: true,
    });
    await post(teacher, classroomId, { title: 'Newer', body: 'b', publish: true });

    await teacher.patch(`/api/classrooms/${classroomId}/announcements/${first.body.id}`, {
      pinned: false,
    });

    const { announcements } = (await list(teacher, classroomId)).body;
    assert.equal(announcements[0].title, 'Newer');
  });
});
