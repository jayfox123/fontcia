import type { ApiMessage, ApiResponse } from '../shared/api-messages';

type Mode = 'login' | 'signup';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fontCIA login page: missing #${id}`);
  return el;
}

async function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return (await chrome.runtime.sendMessage(message)) as ApiResponse<T>;
}

let mode: Mode = 'login';

function setMode(newMode: Mode): void {
  mode = newMode;
  ($('submitBtn') as HTMLButtonElement).textContent = mode === 'login' ? 'Log in' : 'Sign up';
}

function showError(message: string): void {
  const errorEl = $('errorMessage');
  errorEl.textContent = message;
  errorEl.hidden = false;
  $('successMessage').hidden = true;
}

function showLoggedInView(email: string): void {
  $('formView').hidden = true;
  $('loggedInView').hidden = false;
  $('loggedInMessage').textContent = `Logged in as ${email}`;
}

function showFormView(): void {
  $('loggedInView').hidden = true;
  $('formView').hidden = false;
}

export async function initLoginPage(): Promise<void> {
  $('modeLoginBtn').addEventListener('click', () => setMode('login'));
  $('modeSignupBtn').addEventListener('click', () => setMode('signup'));

  $('authForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = ($('emailInput') as HTMLInputElement).value;
    const password = ($('passwordInput') as HTMLInputElement).value;

    const message: ApiMessage =
      mode === 'login' ? { type: 'LOGIN', email, password } : { type: 'SIGNUP', email, password };

    sendMessage<{ user: { id: string; email: string } }>(message)
      .then((response) => {
        if (response.ok) {
          $('errorMessage').hidden = true;
          showLoggedInView(response.data.user.email);
        } else {
          showError(response.error);
        }
      })
      .catch((error: unknown) => {
        console.error('fontCIA: login request failed', error);
        showError('Something went wrong. Please try again.');
      });
  });

  $('logoutBtn').addEventListener('click', () => {
    sendMessage<null>({ type: 'LOGOUT' })
      .then(() => showFormView())
      .catch((error: unknown) => console.error('fontCIA: logout failed', error));
  });

  try {
    const authState = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
    if (authState.ok && authState.data.loggedIn && authState.data.email) {
      showLoggedInView(authState.data.email);
    }
  } catch (error) {
    console.error('fontCIA: failed to check auth state on load', error);
  }
}

initLoginPage();
