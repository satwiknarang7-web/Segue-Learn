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

const dashboard = (client) => client.get('/api/dashboard');

async function seedStaff(email = 'teacher@test.edu', name = 'Grace Hopper') {
  return signedInClient(harness, { email, name, facultyCode: 'STAFF' });
}

async function makeClassroom(owner, name) {
  const created = await owner.post('/api/classrooms', { name });
  assert.equal(created.status, 201, created.text);
  return created.body;
}

describe('shape', () => {
  it('shows only the studying half to somebody who only studies', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu', name: 'Ada Lovelace' });

    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    const seen = await dashboard(student);
    assert.equal(seen.status, 200, seen.text);
    assert.equal(seen.body.studies, true);
    assert.equal(seen.body.teaches, false);
    assert.equal(seen.body.studying.length, 1);
    assert.equal(seen.body.teaching, undefined);
    assert.equal(seen.body.name, 'Ada Lovelace');
  });

  it('shows only the teaching half to somebody who only teaches', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    await makeClassroom(teacher, 'Discrete Maths');

    const seen = await dashboard(teacher);
    assert.equal(seen.body.teaches, true);
    assert.equal(seen.body.studies, false);
    assert.equal(seen.body.teaching.length, 1);
    assert.equal(seen.body.studying, undefined);
  });

  /**
   * The case the whole model exists for: role lives on the enrolment, so one
   * person can be staff in one course and a student in another.
   */
  it('shows both halves to a graduate student who teaches and studies', async () => {
    await seedUniversity();
    const professor = await seedStaff('prof@test.edu', 'Professor Knuth');
    const grad = await seedStaff('grad@test.edu', 'Alan Turing');

    // They run their own seminar...
    await makeClassroom(grad, 'Seminar they run');
    // ...and sit somebody else's course.
    const taught = await makeClassroom(professor, 'Course they take');
    await grad.post('/api/classrooms/join', { code: taught.joinCode });

    const seen = await dashboard(grad);
    assert.equal(seen.body.teaches, true);
    assert.equal(seen.body.studies, true);
    assert.deepEqual(seen.body.teaching.map((c) => c.name), ['Seminar they run']);
    assert.deepEqual(seen.body.studying.map((c) => c.name), ['Course they take']);
  });

  it('gives somebody in no courses neither half', async () => {
    await seedUniversity();
    const nobody = await signedInClient(harness, { email: 'nobody@test.edu' });

    const seen = await dashboard(nobody);
    assert.equal(seen.body.teaches, false);
    assert.equal(seen.body.studies, false);
    assert.equal(seen.body.upcoming.length, 0);
    assert.equal(seen.body.announcements.length, 0);
  });

  it('leaves archived courses out of both halves, and counts them', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const room = await makeClassroom(teacher, 'Finished course');
    await teacher.post(`/api/classrooms/${room.id}/archive`, { archived: true });

    const seen = await dashboard(teacher);
    assert.equal(seen.body.teaches, false);
    assert.equal(seen.body.archivedCount, 1);
  });
});

describe('what a teacher is shown', () => {
  it('counts the things waiting on them, per course', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu', name: 'Ada' });

    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    // A draft quiz, a draft notice, an unmarked column, and a question nobody
    // has answered.
    await teacher.post(`/api/classrooms/${room.id}/quizzes`, {
      title: 'Draft',
      timeLimitSeconds: 600,
    });
    await teacher.post(`/api/classrooms/${room.id}/announcements`, {
      title: 'Half written',
      body: 'Not yet.',
    });
    await teacher.post(`/api/classrooms/${room.id}/gradebook/columns`, {
      title: 'Essay 1',
      pointsPossible: 40,
    });
    await student.post(`/api/classrooms/${room.id}/discussions`, {
      title: 'Stuck on question 3',
      body: 'Help?',
    });

    const [course] = (await dashboard(teacher)).body.teaching;

    assert.equal(course.studentCount, 1);
    assert.equal(course.draftQuizzes, 1);
    assert.equal(course.draftAnnouncements, 1);
    assert.equal(course.ungradedCells, 1);
    assert.equal(course.unansweredThreads, 1);
    assert.equal(course.outstanding, 4);
  });

  it('stops counting a question once somebody has answered it', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu' });
    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    const thread = await student.post(`/api/classrooms/${room.id}/discussions`, {
      title: 'Stuck',
      body: 'Help?',
    });
    assert.equal((await dashboard(teacher)).body.teaching[0].unansweredThreads, 1);

    await teacher.post(`/api/classrooms/${room.id}/discussions/${thread.body.id}/posts`, {
      body: 'Here you go.',
    });
    assert.equal((await dashboard(teacher)).body.teaching[0].unansweredThreads, 0);
  });

  it('does not count a quiz column as needing a mark', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu' });
    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    const quiz = await teacher.post(`/api/classrooms/${room.id}/quizzes`, {
      title: 'Week 1',
      timeLimitSeconds: 600,
    });
    await teacher.post(`/api/classrooms/${room.id}/quizzes/${quiz.body.id}/questions`, {
      text: '2 + 2?',
      options: ['3', '4'],
      correctIndex: 1,
    });
    await teacher.patch(`/api/classrooms/${room.id}/quizzes/${quiz.body.id}`, {
      isPublished: true,
    });
    await teacher.post(`/api/classrooms/${room.id}/gradebook/columns`, { quizId: quiz.body.id });

    // A quiz column marks itself, so nobody is waiting on a hand.
    assert.equal((await dashboard(teacher)).body.teaching[0].ungradedCells, 0);
  });
});

describe('what a student is shown', () => {
  /** A published quiz worth 2 marks. */
  async function publishQuiz(teacher, classroomId, title) {
    const quiz = await teacher.post(`/api/classrooms/${classroomId}/quizzes`, {
      title,
      timeLimitSeconds: 600,
    });
    await teacher.post(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}/questions`, {
      text: '2 + 2?',
      options: ['3', '4'],
      correctIndex: 1,
      points: 2,
    });
    await teacher.patch(`/api/classrooms/${classroomId}/quizzes/${quiz.body.id}`, {
      isPublished: true,
    });
    return quiz.body.id;
  }

  it('lists quizzes still to sit, and drops them once submitted', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu' });
    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    const quizId = await publishQuiz(teacher, room.id, 'Week 1');

    assert.deepEqual(
      (await dashboard(student)).body.openQuizzes.map((q) => q.title),
      ['Week 1'],
    );

    const started = await student.post(`/api/classrooms/${room.id}/quizzes/${quizId}/attempts`);
    const choice = started.body.quiz.questions[0];
    await student.post(`/api/attempts/${started.body.attempt.attemptId}/submit`, {
      answers: { [choice.id]: choice.options.indexOf('4') },
    });

    // Something already done is not outstanding work.
    assert.equal((await dashboard(student)).body.openQuizzes.length, 0);
  });

  it('never lists an unpublished quiz', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu' });
    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    await teacher.post(`/api/classrooms/${room.id}/quizzes`, {
      title: 'Draft',
      timeLimitSeconds: 600,
    });

    assert.equal((await dashboard(student)).body.openQuizzes.length, 0);
  });

  it('reports quiz standing per course', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const student = await signedInClient(harness, { email: 'ada@test.edu' });
    const room = await makeClassroom(teacher, 'Discrete Maths');
    await student.post('/api/classrooms/join', { code: room.joinCode });

    const quizId = await publishQuiz(teacher, room.id, 'Week 1');
    const started = await student.post(`/api/classrooms/${room.id}/quizzes/${quizId}/attempts`);
    const choice = started.body.quiz.questions[0];
    await student.post(`/api/attempts/${started.body.attempt.attemptId}/submit`, {
      answers: { [choice.id]: choice.options.indexOf('4') },
    });

    const [course] = (await dashboard(student)).body.studying;
    assert.equal(course.quizzesTaken, 1);
    assert.equal(course.quizScore, 100);
  });
});

describe('scoping', () => {
  it('never reaches across a university boundary', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    await makeClassroom(teacher, 'Here');

    await universityRepository.insert({
      name: 'Other University',
      slug: 'other',
      emailDomain: 'other.edu',
      facultySignupCode: 'STAFF',
    });
    const elsewhere = await signedInClient(harness, {
      email: 'someone@other.edu',
      facultyCode: 'STAFF',
    });

    const seen = await dashboard(elsewhere);
    assert.equal(seen.body.teaches, false);
    assert.equal(seen.body.announcements.length, 0);
  });

  it('never shows a course the person is not in', async () => {
    await seedUniversity();
    const teacher = await seedStaff();
    const outsider = await signedInClient(harness, { email: 'outsider@test.edu' });

    const room = await makeClassroom(teacher, 'Not theirs');
    await teacher.post(`/api/classrooms/${room.id}/announcements`, {
      title: 'Members only',
      body: 'Secret.',
      publish: true,
    });

    const seen = await dashboard(outsider);
    assert.equal(seen.body.announcements.length, 0);
    assert.doesNotMatch(seen.text, /Members only/);
  });

  it('refuses without a session', async () => {
    const anonymous = harness.client();
    assert.equal((await anonymous.get('/api/dashboard')).status, 401);
  });
});
