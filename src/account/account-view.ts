import type { ApiMessage, ApiResponse } from '../shared/api-messages';

type Mode = 'login' | 'signup';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderAccountView(container: HTMLElement, isStale: () => boolean): Promise<void> {
  container.replaceChildren();
  let mode: Mode = 'login';

  const loggedInView = document.createElement('div');
  loggedInView.hidden = true;
  const loggedInMessage = document.createElement('p');
  loggedInView.appendChild(loggedInMessage);
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'fontcia-btn fontcia-btn-secondary';
  logoutBtn.textContent = 'Log out';
  loggedInView.appendChild(logoutBtn);

  const formView = document.createElement('div');

  const modeRow = document.createElement('div');
  const modeLoginBtn = document.createElement('button');
  modeLoginBtn.type = 'button';
  modeLoginBtn.className = 'fontcia-btn fontcia-btn-secondary';
  modeLoginBtn.textContent = 'Log in';
  const modeSignupBtn = document.createElement('button');
  modeSignupBtn.type = 'button';
  modeSignupBtn.className = 'fontcia-btn fontcia-btn-secondary';
  modeSignupBtn.textContent = 'Sign up';
  modeRow.appendChild(modeLoginBtn);
  modeRow.appendChild(modeSignupBtn);
  formView.appendChild(modeRow);

  const form = document.createElement('form');
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.className = 'fontcia-input';
  emailInput.placeholder = 'Email';
  emailInput.required = true;
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.className = 'fontcia-input';
  passwordInput.placeholder = 'Password';
  passwordInput.required = true;
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'fontcia-btn fontcia-btn-primary';
  submitBtn.textContent = 'Log in';
  form.appendChild(emailInput);
  form.appendChild(passwordInput);
  form.appendChild(submitBtn);
  formView.appendChild(form);

  const errorMessage = document.createElement('p');
  errorMessage.className = 'fontcia-error-message';
  errorMessage.hidden = true;
  formView.appendChild(errorMessage);

  container.appendChild(loggedInView);
  container.appendChild(formView);

  function setMode(newMode: Mode): void {
    mode = newMode;
    submitBtn.textContent = mode === 'login' ? 'Log in' : 'Sign up';
  }

  function showError(message: string): void {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
  }

  function showLoggedInView(email: string): void {
    formView.hidden = true;
    loggedInView.hidden = false;
    loggedInMessage.textContent = `Logged in as ${email}`;
  }

  function showFormView(): void {
    loggedInView.hidden = true;
    formView.hidden = false;
  }

  modeLoginBtn.addEventListener('click', () => setMode('login'));
  modeSignupBtn.addEventListener('click', () => setMode('signup'));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = emailInput.value;
    const password = passwordInput.value;

    const message: ApiMessage =
      mode === 'login' ? { type: 'LOGIN', email, password } : { type: 'SIGNUP', email, password };

    sendMessage<{ user: { id: string; email: string } }>(message)
      .then((response) => {
        if (isStale()) return;
        if (response.ok) {
          errorMessage.hidden = true;
          showLoggedInView(response.data.user.email);
        } else {
          showError(response.error);
        }
      })
      .catch((error: unknown) => {
        if (isStale()) return;
        console.error('fontCIA: login request failed', error);
        showError('Something went wrong. Please try again.');
      });
  });

  logoutBtn.addEventListener('click', () => {
    sendMessage<null>({ type: 'LOGOUT' })
      .then(() => {
        if (isStale()) return;
        showFormView();
      })
      .catch((error: unknown) => console.error('fontCIA: logout failed', error));
  });

  try {
    const authState = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
    if (isStale()) return;
    if (authState.ok && authState.data.loggedIn && authState.data.email) {
      showLoggedInView(authState.data.email);
    }
  } catch (error) {
    if (isStale()) return;
    console.error('fontCIA: failed to check auth state on load', error);
  }
}
