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

const threads = (client, classroomId) =>
  client.get(`/api/classrooms/${classroomId}/discussions`);

const open = (client, classroomId, payload) =>
  client.post(`/api/classrooms/${classroomId}/discussions`, payload);

const reply = (client, classroomId, threadId, payload) =>
  client.post(`/api/classrooms/${classroomId}/discussions/${threadId}/posts`, payload);

describe('starting a discussion', () => {
  it('lets a student open one — this is not announcements', async () => {
    const { student, classroomId } = await seedClassroom();
    const created = await open(student, classroomId, {
      title: 'Stuck on question 3',
      body: 'Is the induction step meant to use n+1?',
    });

    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.author, 'Ada');
    assert.equal(created.body.opening.body, 'Is the induction step meant to use n+1?');
    assert.equal(created.body.postCount, 1);
  });

  it('will not let a student open a thread already pinned', async () => {
    const { student, classroomId } = await seedClassroom();
    const created = await open(student, classroomId, {
      title: 'Mine first',
      body: 'Please.',
      pinned: true,
    });
    assert.equal(created.body.pinned, false);
  });

  it('refuses an empty body', async () => {
    const { student, classroomId } = await seedClassroom();
    const response = await open(student, classroomId, { title: 'Hello', body: '  ' });
    assert.equal(response.status, 400);
  });

  it('keeps discussions away from somebody not in the classroom', async () => {
    const { student, classroomId } = await seedClassroom();
    await open(student, classroomId, { title: 'Members only', body: 'Hi.' });

    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });
    assert.equal((await threads(outsider, classroomId)).status, 404);
  });
});

describe('replying', () => {
  it('nests a reply under the post it answers', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const threadId = thread.body.id;

    const answered = await reply(teacher, classroomId, threadId, { body: 'Use n+1.' });
    assert.equal(answered.status, 201);
    assert.equal(answered.body.replies.length, 1);
    assert.equal(answered.body.replies[0].author, 'Grace Hopper');

    const nested = await reply(student, classroomId, threadId, {
      body: 'That worked, thanks.',
      parentId: answered.body.replies[0].id,
    });

    assert.equal(nested.body.replies.length, 1);
    assert.equal(nested.body.replies[0].replies.length, 1);
    assert.equal(nested.body.replies[0].replies[0].body, 'That worked, thanks.');
  });

  it('folds a third level up rather than nesting forever', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const threadId = thread.body.id;

    const first = await reply(teacher, classroomId, threadId, { body: 'Level one.' });
    const second = await reply(student, classroomId, threadId, {
      body: 'Level two.',
      parentId: first.body.replies[0].id,
    });

    // Replying to a depth-2 post lands beside it, not below it.
    const third = await reply(teacher, classroomId, threadId, {
      body: 'Level three, folded.',
      parentId: second.body.replies[0].replies[0].id,
    });

    assert.equal(third.body.replies.length, 1);
    assert.equal(third.body.replies[0].replies.length, 2);
    assert.equal(third.body.replies[0].replies[1].body, 'Level three, folded.');
    // Nothing sits three deep.
    assert.equal(third.body.replies[0].replies[0].replies.length, 0);
  });

  it('counts posts and reports the last activity', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    await reply(teacher, classroomId, thread.body.id, { body: 'Answer.' });

    const list = await threads(student, classroomId);
    assert.equal(list.body.threads[0].postCount, 2);
    assert.ok(list.body.threads[0].lastActivityAt);
  });
});

describe('locking', () => {
  it('stops students posting but lets staff close with a word', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const threadId = thread.body.id;

    await teacher.patch(`/api/classrooms/${classroomId}/discussions/${threadId}`, {
      locked: true,
    });

    const refused = await reply(student, classroomId, threadId, { body: 'One more thing.' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /closed/i);

    const allowed = await reply(teacher, classroomId, threadId, {
      body: 'Closing this — see the announcement.',
    });
    assert.equal(allowed.status, 201);
  });

  it('refuses a student who tries to lock or pin', async () => {
    const { student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });

    const response = await student.patch(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
      { locked: true },
    );
    assert.equal(response.status, 403);
  });

  it('floats a pinned thread above newer ones', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const first = await open(student, classroomId, { title: 'Older', body: 'a' });
    await open(student, classroomId, { title: 'Newer', body: 'b' });

    await teacher.patch(`/api/classrooms/${classroomId}/discussions/${first.body.id}`, {
      pinned: true,
    });

    const list = await threads(student, classroomId);
    assert.equal(list.body.threads[0].title, 'Older');
  });
});

describe('editing and removing', () => {
  it('lets the author edit their own post and marks it edited', async () => {
    const { student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stcuk.' });
    const postId = thread.body.opening.id;

    const edited = await student.patch(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}/posts/${postId}`,
      { body: 'Stuck.' },
    );

    assert.equal(edited.body.opening.body, 'Stuck.');
    assert.equal(edited.body.opening.edited, true);
  });

  it('will not let staff edit somebody else\'s words', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Mine.' });

    // Staff may remove a post, but never put words in somebody's mouth.
    const response = await teacher.patch(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}/posts/${thread.body.opening.id}`,
      { body: 'Rewritten by a teacher.' },
    );
    assert.equal(response.status, 403);
  });

  it('soft-deletes a post so its replies still make sense', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const threadId = thread.body.id;

    const parent = await reply(student, classroomId, threadId, { body: 'A claim.' });
    const parentId = parent.body.replies[0].id;
    await reply(teacher, classroomId, threadId, { body: 'A response to it.', parentId });

    const removed = await teacher.del(
      `/api/classrooms/${classroomId}/discussions/${threadId}/posts/${parentId}`,
    );

    const gone = removed.body.replies[0];
    assert.equal(gone.deleted, true);
    assert.equal(gone.body, null);
    assert.equal(gone.author, null);
    // The reply beneath it survives, and still reads as a reply to something.
    assert.equal(gone.replies.length, 1);
    assert.equal(gone.replies[0].body, 'A response to it.');
  });

  it('does not serve a removed post\'s text at all', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const posted = await reply(student, classroomId, thread.body.id, {
      body: 'Something regrettable.',
    });

    await teacher.del(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}/posts/${posted.body.replies[0].id}`,
    );

    const read = await student.get(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.doesNotMatch(read.text, /regrettable/);
  });

  it('refuses to remove the opening post on its own', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });

    const response = await teacher.del(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}/posts/${thread.body.opening.id}`,
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /delete the discussion instead/i);
  });

  it('lets a student remove their own post but not a classmate\'s', async () => {
    const { teacher, student, classroomId, joinCode } = await seedClassroom();
    const classmate = await signedInClient(harness, { email: 'mate@test.edu', name: 'Alan' });
    await classmate.post('/api/classrooms/join', { code: joinCode });

    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    const mine = await reply(classmate, classroomId, thread.body.id, { body: 'My reply.' });
    const postId = mine.body.replies[0].id;
    const path = `/api/classrooms/${classroomId}/discussions/${thread.body.id}/posts/${postId}`;

    assert.equal((await student.del(path)).status, 403);
    assert.equal((await classmate.del(path)).status, 200);
    void teacher;
  });

  it('lets staff delete anybody\'s thread and the author their own', async () => {
    const { teacher, student, classroomId } = await seedClassroom();

    const mine = await open(student, classroomId, { title: 'Mine', body: 'a' });
    assert.equal(
      (await student.del(`/api/classrooms/${classroomId}/discussions/${mine.body.id}`)).status,
      200,
    );

    const theirs = await open(student, classroomId, { title: 'Theirs', body: 'b' });
    assert.equal(
      (await teacher.del(`/api/classrooms/${classroomId}/discussions/${theirs.body.id}`)).status,
      200,
    );
  });

  it('stops the author deleting a thread once somebody else has replied', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });

    // Deletable while it is still hers alone.
    assert.equal(
      (await student.get(`/api/classrooms/${classroomId}/discussions/${thread.body.id}`)).body
        .canRemove,
      true,
    );

    await reply(teacher, classroomId, thread.body.id, { body: 'Here is the answer.' });

    // Deleting now would destroy somebody else's words too.
    const refused = await student.del(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /others have replied/i);

    const read = await student.get(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.equal(read.body.canRemove, false);

    // Staff are not bound by it.
    assert.equal(
      (await teacher.del(`/api/classrooms/${classroomId}/discussions/${thread.body.id}`)).status,
      200,
    );
  });

  it('stops the author deleting a thread staff have closed', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });

    await teacher.patch(`/api/classrooms/${classroomId}/discussions/${thread.body.id}`, {
      locked: true,
    });

    // Deleting it would undo the moderation, which is not the author's call.
    const refused = await student.del(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /closed this discussion/i);
  });

  it('deleting a thread takes its posts with it', async () => {
    const { student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });
    await reply(student, classroomId, thread.body.id, { body: 'More.' });

    await student.del(`/api/classrooms/${classroomId}/discussions/${thread.body.id}`);

    const read = await student.get(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.equal(read.status, 404);
  });
});

describe('permission flags', () => {
  it('tells each person what they may do, rather than letting the page guess', async () => {
    const { teacher, student, classroomId } = await seedClassroom();
    const thread = await open(student, classroomId, { title: 'Q3', body: 'Stuck.' });

    const asAuthor = await student.get(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    assert.equal(asAuthor.body.opening.canEdit, true);
    assert.equal(asAuthor.body.canModerate, false);

    const asStaff = await teacher.get(
      `/api/classrooms/${classroomId}/discussions/${thread.body.id}`,
    );
    // Staff may remove it but not edit it.
    assert.equal(asStaff.body.opening.canEdit, false);
    assert.equal(asStaff.body.opening.canRemove, true);
    assert.equal(asStaff.body.canModerate, true);
  });
});
