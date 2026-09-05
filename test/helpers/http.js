import assert from 'node:assert/strict';
import http from 'node:http';

import { generateTotp } from '../../src/lib/totp.js';

/**
 * The API over real HTTP, so routing, the signed-in gate and cookie handling
 * are exercised the way a browser would exercise them.
 */

export async function startTestServer() {
  const { handleRequest } = await import('../../src/app.js');

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.writableEnded) res.writeHead(500).end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),

    /** A client that remembers the one cookie this app sets. */
    client() {
      let cookie = '';

      const request = async (method, path, body) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          redirect: 'manual',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      };

      return {
        request,
        get: (path) => request('GET', path),
        post: (path, body) => request('POST', path, body ?? {}),
        patch: (path, body) => request('PATCH', path, body ?? {}),
        put: (path, body) => request('PUT', path, body ?? {}),
        del: (path) => request('DELETE', path),
      };
    },
  };
}

const PASSWORD = 'a-long-enough-password';
export { PASSWORD };

let clientKeyCounter = 0;

/**
 * Signs up, completes two-factor, and returns a client holding an active
 * session. `facultyCode` is what makes the account teaching staff.
 */
export async function signedInClient(harness, { email, name, facultyCode } = {}) {
  const { userRepository } = await import('../../src/repositories/userRepository.js');
  const { universityRepository } = await import(
    '../../src/repositories/universityRepository.js'
  );

  const c = harness.client();
  const signUp = await c.post('/api/auth/signup', {
    name: name ?? email.split('@')[0],
    email,
    password: PASSWORD,
    ...(facultyCode ? { facultyCode } : {}),
  });
  assert.equal(signUp.status, 201, signUp.text);

  const domain = email.slice(email.lastIndexOf('@') + 1);
  const uni = await universityRepository.findByEmailDomain(domain);
  const stored = await userRepository.findByEmail(uni.id, email);

  const activate = await c.post('/api/auth/2fa/activate', {
    code: generateTotp(stored.totpSecret),
  });
  assert.equal(activate.status, 200, activate.text);

  clientKeyCounter += 1;
  return c;
}
