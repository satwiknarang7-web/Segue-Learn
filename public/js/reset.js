import { showError } from './api.js';

const form = document.querySelector('#reset-form');
const errorNode = document.querySelector('#reset-error');
const button = document.querySelector('#reset-submit');

document.querySelector('#email').focus();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorNode.hidden = true;
  button.disabled = true;

  try {
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value,
        code: document.querySelector('#code').value,
        newPassword: document.querySelector('#new-password').value,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? 'Could not reset the password.');

    document.querySelector('#done-detail').textContent = payload.usedRecoveryCode
      ? `That recovery code has been spent — ${payload.remainingRecoveryCodes} left.`
      : 'Sign in with your new password and your usual authenticator code.';

    document.querySelector('#reset-step').hidden = true;
    document.querySelector('#done-step').hidden = false;
  } catch (error) {
    showError(errorNode, error.message);
    button.disabled = false;
    document.querySelector('#code').select();
  }
});
