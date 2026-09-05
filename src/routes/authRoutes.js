import { send, sendJson } from '../lib/http.js';
import { renderQrSvg } from '../lib/qrcode.js';
import { Router } from '../lib/router.js';
import { buildOtpauthUri } from '../lib/totp.js';
import { accountService } from '../services/accountService.js';

export const authRoutes = new Router();

const clientKey = (req) => req.socket?.remoteAddress ?? 'unknown';

/** Lets any page ask who is viewing it. */
authRoutes.get('/api/auth/me', ({ req }) => accountService.describe(req));

authRoutes.post('/api/auth/signup', async ({ req, res, body }) => {
  const result = await accountService.signUp(body, clientKey(req));
  res.setHeader('Set-Cookie', result.cookie);
  sendJson(res, 201, { user: result.user, enrolment: result.enrolment });
});

authRoutes.post('/api/auth/signin', async ({ req, res, body }) => {
  const result = await accountService.signIn(body, clientKey(req));
  res.setHeader('Set-Cookie', result.cookie);
  sendJson(res, 200, {
    requiresSecondFactor: true,
    needsEnrolment: result.needsEnrolment,
    enrolment: result.enrolment,
  });
});

/** The QR an authenticator app scans, for whoever holds the pending session. */
authRoutes.get('/api/auth/2fa/qr.svg', async ({ req, res }) => {
  const { user } = await accountService.requirePending(req);
  const uri = buildOtpauthUri({
    secret: user.totpSecret,
    account: user.email,
    issuer: 'EduPlatform',
  });

  send(res, 200, renderQrSvg(uri, { size: 260, ecLevel: 'M' }), {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});

authRoutes.get('/api/auth/2fa/setup', async ({ req }) => {
  const { user } = await accountService.requirePending(req);
  return { email: user.email, ...accountService.enrolmentFor(user) };
});

authRoutes.post('/api/auth/2fa/activate', async ({ req, res, body }) => {
  const result = await accountService.activateTwoFactor(req, body?.code, clientKey(req));
  res.setHeader('Set-Cookie', result.cookie);
  sendJson(res, 200, { user: result.user, recoveryCodes: result.recoveryCodes });
});

authRoutes.post('/api/auth/2fa/verify', async ({ req, res, body }) => {
  const result = await accountService.verifySecondFactor(req, body?.code, clientKey(req));
  res.setHeader('Set-Cookie', result.cookie);
  sendJson(res, 200, {
    user: result.user,
    usedRecoveryCode: result.usedRecoveryCode,
    remainingRecoveryCodes: result.remaining,
  });
});

/** Forgotten password, authorised by the second factor rather than by email. */
authRoutes.post('/api/auth/reset-password', async ({ req, res, body }) => {
  const result = await accountService.resetPassword(body, clientKey(req));
  // Every prior session is gone, including any this browser held.
  res.setHeader('Set-Cookie', accountService.signOutCookie());
  sendJson(res, 200, result);
});

authRoutes.post('/api/auth/signout', ({ res }) => {
  res.setHeader('Set-Cookie', accountService.signOutCookie());
  sendJson(res, 200, { authenticated: false });
});
