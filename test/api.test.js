import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { freshDatabase, truncateAll } from './helpers/database.js';

const { close } = await freshDatabase();

const { handleRequest } = await import('../src/app.js');
const { universityRepository } = await import('../src/repositories/universityRepository.js');
const { userRepository } = await import('../src/repositories/userRepository.js');
const { generateTotp } = await import('../src/lib/totp.js');

/**
 * The API over real HTTP, so routing, the signed-in gate and cookie handling
 * are exercised the way a browser would exercise them.
 */

let server;
let origin;

before(async () => {
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await close();
});

beforeEach(() => truncateAll());

/** A tiny client that remembers the one cookie this app sets. */
function createClient() {
  let cookie = '';

  return {
    get cookie() {
      return cookie;
    },
    async request(method, path, body) {
      const response = await fetch(`${origin}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];

      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, body: json, text };
    },
  };
}

const client = () => {
  const c = createClient();
  return {
    raw: c,
    get: (path) => c.request('GET', path),
    post: (path, body) => c.request('POST', path, body),
    patch: (path, body) => c.request('PATCH', path, body),
    del: (path) => c.request('DELETE', path),
  };
};

const PASSWORD = 'a-long-enough-password';

const seedUniversity = () =>
  universityRepository.insert({
    name: 'Test University',
    slug: 'test',
    emailDomain: 'test.edu',
    facultySignupCode: 'STAFF-2026',
  });

/** Signs up, completes 2FA, and returns a client holding an active session. */
async function signedInClient(uni, email, { faculty = false } = {}) {
  const c = client();
  const signUp = await c.post('/api/auth/signup', {
    name: email.split('@')[0],
    email,
    password: PASSWORD,
    ...(faculty ? { facultyCode: 'STAFF-2026' } : {}),
  });
  assert.equal(signUp.status, 201, signUp.text);

  const stored = await userRepository.findByEmail(uni.id, email);
  const activate = await c.post('/api/auth/2fa/activate', {
    code: generateTotp(stored.totpSecret),
  });
  assert.equal(activate.status, 200, activate.text);
  return c;
}

describe('the signed-in gate', () => {
  it('refuses the API without a session', async () => {
    const anonymous = client();
    const response = await anonymous.get('/api/classrooms');
    assert.equal(response.status, 401);
  });

  it('redirects a browser page to sign in', async () => {
    const anonymous = client();
    const response = await anonymous.get('/home');
    assert.equal(response.status, 302);
  });

  it('reports an anonymous visitor as not authenticated', async () => {
    const anonymous = client();
    const { body } = await anonymous.get('/api/auth/me');
    assert.equal(body.authenticated, false);
  });

  it('does not open protected routes on a pending, pre-2FA session', async () => {
    await seedUniversity();
    const c = client();
    await c.post('/api/auth/signup', {
      name: 'Ada',
      email: 'ada@test.edu',
      password: PASSWORD,
    });

    const response = await c.get('/api/classrooms');
    assert.equal(response.status, 401);
  });
});

describe('classrooms', () => {
  it('lets faculty create one and a student join with the code', async () => {
    const uni = await seedUniversity();
    const teacher = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const student = await signedInClient(uni, 'student@test.edu');

    const created = await teacher.post('/api/classrooms', { name: 'Discrete Maths' });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.role, 'teacher');
    assert.equal(created.body.visibility, 'private');
    assert.ok(created.body.joinCode);

    const joined = await student.post('/api/classrooms/join', { code: created.body.joinCode });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(joined.body.role, 'student');

    const mine = await student.get('/api/classrooms');
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].name, 'Discrete Maths');
  });

  it('refuses a student who tries to create a classroom', async () => {
    const uni = await seedUniversity();
    const student = await signedInClient(uni, 'student@test.edu');

    const response = await student.post('/api/classrooms', { name: 'Not allowed' });
    assert.equal(response.status, 403);
  });

  it('hides the join code from students but shows it to staff', async () => {
    const uni = await seedUniversity();
    const teacher = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const student = await signedInClient(uni, 'student@test.edu');

    const created = await teacher.post('/api/classrooms', { name: 'Maths' });
    await student.post('/api/classrooms/join', { code: created.body.joinCode });

    const asStudent = await student.get(`/api/classrooms/${created.body.id}`);
    assert.equal(asStudent.body.joinCode, undefined);

    const asTeacher = await teacher.get(`/api/classrooms/${created.body.id}`);
    assert.equal(asTeacher.body.joinCode, created.body.joinCode);
  });

  it('will not show a private classroom to somebody who is not in it', async () => {
    const uni = await seedUniversity();
    const teacher = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const outsider = await signedInClient(uni, 'outsider@test.edu');

    const created = await teacher.post('/api/classrooms', { name: 'Private' });

    // 404 rather than 403, so its existence is not disclosed.
    const response = await outsider.get(`/api/classrooms/${created.body.id}`);
    assert.equal(response.status, 404);
  });

  it('rotating the code stops the old one enrolling anyone', async () => {
    const uni = await seedUniversity();
    const teacher = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const student = await signedInClient(uni, 'student@test.edu');

    const created = await teacher.post('/api/classrooms', { name: 'Maths' });
    const oldCode = created.body.joinCode;

    await teacher.post(`/api/classrooms/${created.body.id}/join-code`);

    const response = await student.post('/api/classrooms/join', { code: oldCode });
    assert.equal(response.status, 404);
  });

  it('keeps a student out of another university entirely', async () => {
    const uni = await seedUniversity();
    const other = await universityRepository.insert({
      name: 'Other University',
      slug: 'other',
      emailDomain: 'other.edu',
      facultySignupCode: 'STAFF-2026',
    });

    const teacherHere = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const studentThere = await signedInClient(other, 'student@other.edu');

    const created = await teacherHere.post('/api/classrooms', { name: 'Maths' });

    const byId = await studentThere.get(`/api/classrooms/${created.body.id}`);
    assert.equal(byId.status, 404);

    const byCode = await studentThere.post('/api/classrooms/join', {
      code: created.body.joinCode,
    });
    assert.equal(byCode.status, 404);
  });

  it('shows the roster to members and withholds emails from students', async () => {
    const uni = await seedUniversity();
    const teacher = await signedInClient(uni, 'teacher@test.edu', { faculty: true });
    const student = await signedInClient(uni, 'student@test.edu');

    const created = await teacher.post('/api/classrooms', { name: 'Maths' });
    await student.post('/api/classrooms/join', { code: created.body.joinCode });

    const asTeacher = await teacher.get(`/api/classrooms/${created.body.id}/members`);
    assert.equal(asTeacher.body.length, 2);
    assert.ok(asTeacher.body.every((m) => typeof m.email === 'string'));

    const asStudent = await student.get(`/api/classrooms/${created.body.id}/members`);
    assert.ok(asStudent.body.every((m) => m.email === undefined));
  });
});
