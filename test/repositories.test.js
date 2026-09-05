import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { freshDatabase, truncateAll } from './helpers/database.js';

const { close } = await freshDatabase();

const { universityRepository } = await import('../src/repositories/universityRepository.js');
const { userRepository } = await import('../src/repositories/userRepository.js');
const {
  classroomRepository,
  membershipRepository,
} = await import('../src/repositories/classroomRepository.js');

after(() => close());
beforeEach(() => truncateAll());

const makeUniversity = (overrides = {}) =>
  universityRepository.insert({
    name: 'Test University',
    slug: 'test',
    emailDomain: 'test.edu',
    ...overrides,
  });

const makeUser = (universityId, overrides = {}) =>
  userRepository.insert({
    universityId,
    name: 'Ada Lovelace',
    email: 'ada@test.edu',
    passwordSalt: 'salt',
    passwordHash: 'hash',
    totpSecret: 'SECRET',
    ...overrides,
  });

describe('universityRepository', () => {
  it('finds a university by the email domain that gates signup', async () => {
    await makeUniversity({ emailDomain: 'cam.ac.uk' });
    const found = await universityRepository.findByEmailDomain('cam.ac.uk');
    assert.equal(found.name, 'Test University');
  });

  it('matches an email domain case-insensitively', async () => {
    await makeUniversity({ emailDomain: 'cam.ac.uk' });
    assert.ok(await universityRepository.findByEmailDomain('CAM.AC.UK'));
  });

  it('returns null for a domain with no university', async () => {
    assert.equal(await universityRepository.findByEmailDomain('nowhere.edu'), null);
  });
});

describe('userRepository', () => {
  it('reads the domain out of an address', () => {
    assert.equal(userRepository.domainOf('Ada@Test.EDU'), 'test.edu');
    assert.equal(userRepository.domainOf('nonsense'), '');
  });

  it('lets the same email exist at two universities', async () => {
    const a = await makeUniversity({ slug: 'a', emailDomain: 'a.edu' });
    const b = await makeUniversity({ slug: 'b', emailDomain: 'b.edu' });

    await makeUser(a.id, { email: 'ada@a.edu' });
    await makeUser(b.id, { email: 'ada@a.edu' });

    const fromA = await userRepository.findByEmail(a.id, 'ada@a.edu');
    const fromB = await userRepository.findByEmail(b.id, 'ada@a.edu');
    assert.notEqual(fromA.id, fromB.id);
  });

  it('refuses the same email twice inside one university', async () => {
    const uni = await makeUniversity();
    await makeUser(uni.id);
    await assert.rejects(() => makeUser(uni.id), /duplicate key|unique/i);
  });

  it('finds an account whatever case the email is typed in', async () => {
    const uni = await makeUniversity();
    await makeUser(uni.id, { email: 'ada@test.edu' });
    assert.ok(await userRepository.findByEmail(uni.id, 'ADA@TEST.EDU'));
  });

  it('defaults a new account to student', async () => {
    const uni = await makeUniversity();
    const user = await makeUser(uni.id);
    assert.equal(user.platformRole, 'student');
  });

  it('spends a recovery code once and refuses it the second time', async () => {
    const uni = await makeUniversity();
    const user = await makeUser(uni.id);
    await userRepository.confirmTwoFactor(user.id, [
      { hash: 'aaa', usedAt: null },
      { hash: 'bbb', usedAt: null },
    ]);

    assert.ok(await userRepository.useRecoveryCode(user.id, 'aaa'));
    assert.equal(await userRepository.useRecoveryCode(user.id, 'aaa'), null);
    assert.ok(await userRepository.useRecoveryCode(user.id, 'bbb'));
  });

  it('bumps token_version on a password reset, invalidating old cookies', async () => {
    const uni = await makeUniversity();
    const user = await makeUser(uni.id);
    assert.equal(user.tokenVersion, 1);

    const updated = await userRepository.resetPassword(user.id, {
      salt: 'new-salt',
      hash: 'new-hash',
    });
    assert.equal(updated.tokenVersion, 2);
    assert.equal(updated.passwordHash, 'new-hash');
  });
});

describe('classroomRepository', () => {
  it('lets two universities hold the same join code', async () => {
    const a = await makeUniversity({ slug: 'a', emailDomain: 'a.edu' });
    const b = await makeUniversity({ slug: 'b', emailDomain: 'b.edu' });
    const teacherA = await makeUser(a.id, { email: 't@a.edu' });
    const teacherB = await makeUser(b.id, { email: 't@b.edu' });

    await classroomRepository.insert({
      universityId: a.id,
      ownerId: teacherA.id,
      name: 'Maths',
      joinCode: 'ABC123',
    });
    await classroomRepository.insert({
      universityId: b.id,
      ownerId: teacherB.id,
      name: 'Physics',
      joinCode: 'ABC123',
    });

    const foundInA = await classroomRepository.findByJoinCode(a.id, 'ABC123');
    assert.equal(foundInA.name, 'Maths');
  });

  it('refuses the same join code twice inside one university', async () => {
    const uni = await makeUniversity();
    const teacher = await makeUser(uni.id);
    const base = { universityId: uni.id, ownerId: teacher.id, joinCode: 'DUP123' };

    await classroomRepository.insert({ ...base, name: 'One' });
    await assert.rejects(
      () => classroomRepository.insert({ ...base, name: 'Two' }),
      /duplicate key|unique/i,
    );
  });

  it('is private by default', async () => {
    const uni = await makeUniversity();
    const teacher = await makeUser(uni.id);
    const room = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: teacher.id,
      name: 'Maths',
      joinCode: 'AAA111',
    });
    assert.equal(room.visibility, 'private');
  });

  it('will not read a classroom through the wrong university', async () => {
    const a = await makeUniversity({ slug: 'a', emailDomain: 'a.edu' });
    const b = await makeUniversity({ slug: 'b', emailDomain: 'b.edu' });
    const teacher = await makeUser(a.id, { email: 't@a.edu' });

    const room = await classroomRepository.insert({
      universityId: a.id,
      ownerId: teacher.id,
      name: 'Maths',
      joinCode: 'AAA111',
    });

    assert.ok(await classroomRepository.findById(a.id, room.id));
    assert.equal(await classroomRepository.findById(b.id, room.id), null);
  });

  it('rotating the join code stops the old one working', async () => {
    const uni = await makeUniversity();
    const teacher = await makeUser(uni.id);
    const room = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: teacher.id,
      name: 'Maths',
      joinCode: 'OLD111',
    });

    await classroomRepository.rotateJoinCode(uni.id, room.id, 'NEW222');
    assert.equal(await classroomRepository.findByJoinCode(uni.id, 'OLD111'), null);
    assert.ok(await classroomRepository.findByJoinCode(uni.id, 'NEW222'));
  });
});

describe('membershipRepository', () => {
  it('carries a different role per classroom for one person', async () => {
    const uni = await makeUniversity();
    const person = await makeUser(uni.id);
    const owner = await makeUser(uni.id, { email: 'owner@test.edu' });

    const teaches = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: owner.id,
      name: 'Teaches this',
      joinCode: 'AAA111',
    });
    const takes = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: owner.id,
      name: 'Takes this',
      joinCode: 'BBB222',
    });

    await membershipRepository.add(teaches.id, person.id, 'teacher');
    await membershipRepository.add(takes.id, person.id, 'student');

    const rooms = await classroomRepository.listForUser(uni.id, person.id);
    const byName = Object.fromEntries(rooms.map((r) => [r.name, r.role]));
    assert.deepEqual(byName, { 'Teaches this': 'teacher', 'Takes this': 'student' });
  });

  it('joining twice is not an error and does not change the role', async () => {
    const uni = await makeUniversity();
    const teacher = await makeUser(uni.id);
    const room = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: teacher.id,
      name: 'Maths',
      joinCode: 'AAA111',
    });

    await membershipRepository.add(room.id, teacher.id, 'teacher');
    const again = await membershipRepository.add(room.id, teacher.id, 'student');
    assert.equal(again.role, 'teacher');
  });

  it('deleting a classroom takes its memberships with it', async () => {
    const uni = await makeUniversity();
    const teacher = await makeUser(uni.id);
    const room = await classroomRepository.insert({
      universityId: uni.id,
      ownerId: teacher.id,
      name: 'Maths',
      joinCode: 'AAA111',
    });
    await membershipRepository.add(room.id, teacher.id, 'teacher');

    await classroomRepository.remove(uni.id, room.id);
    assert.equal(await membershipRepository.find(room.id, teacher.id), null);
  });
});
