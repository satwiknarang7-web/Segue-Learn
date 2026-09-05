import { showError } from './api.js';

const credentialsStep = document.querySelector('#credentials-step');
const codeStep = document.querySelector('#code-step');
const credentialsError = document.querySelector('#credentials-error');
const codeError = document.querySelector('#code-error');

/** Only ever redirect within this site, never to a URL someone put in the query string. */
function safeNextPath() {
  const requested = new URLSearchParams(window.location.search).get('next');
  if (!requested || !requested.startsWith('/') || requested.startsWith('//')) return '/home';
  return requested;
}

async function post(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

document.querySelector('#credentials-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  credentialsError.hidden = true;

  const button = document.querySelector('#credentials-submit');
  button.disabled = true;

  try {
    const result = await post('/api/auth/signin', {
      email: document.querySelector('#email').value,
      password: document.querySelector('#password').value,
    });

    // Somebody who never finished enrolling is sent back to complete it.
    if (result.needsEnrolment) {
      window.location.href = '/signup?resume=1';
      return;
    }

    credentialsStep.hidden = true;
    codeStep.hidden = false;
    document.querySelector('#totp-code').focus();
  } catch (error) {
    showError(credentialsError, error.message);
    button.disabled = false;
  }
});

document.querySelector('#code-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  codeError.hidden = true;

  const button = document.querySelector('#code-submit');
  const input = document.querySelector('#totp-code');
  button.disabled = true;

  try {
    const result = await post('/api/auth/2fa/verify', { code: input.value });

    if (result.usedRecoveryCode) {
      // Worth knowing before they are all gone.
      window.sessionStorage.setItem(
        'eduplatform:recovery-notice',
        String(result.remainingRecoveryCodes ?? 0),
      );
    }
    window.location.href = safeNextPath();
  } catch (error) {
    showError(codeError, error.message);
    button.disabled = false;
    input.select();
  }
});
