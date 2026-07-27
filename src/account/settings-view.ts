import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import { getStoredTheme, setStoredTheme, type Theme } from '../shared/theme-storage';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderSettingsView(
  container: HTMLElement,
  isStale: () => boolean,
  onThemeChange: (theme: Theme) => void,
): Promise<void> {
  container.replaceChildren();

  const emailLine = document.createElement('p');
  emailLine.className = 'fontcia-list-row-meta';
  container.appendChild(emailLine);

  const themeLabel = document.createElement('p');
  themeLabel.className = 'fontcia-list-row-title';
  themeLabel.textContent = 'Theme';
  container.appendChild(themeLabel);

  const themeRow = document.createElement('div');
  const darkBtn = document.createElement('button');
  darkBtn.type = 'button';
  darkBtn.textContent = 'Dark theme';
  const lightBtn = document.createElement('button');
  lightBtn.type = 'button';
  lightBtn.textContent = 'Light theme';
  themeRow.appendChild(darkBtn);
  themeRow.appendChild(lightBtn);
  container.appendChild(themeRow);

  function renderThemeButtons(current: Theme): void {
    darkBtn.className = current === 'dark' ? 'fontcia-btn fontcia-btn-primary' : 'fontcia-btn fontcia-btn-secondary';
    lightBtn.className = current === 'light' ? 'fontcia-btn fontcia-btn-primary' : 'fontcia-btn fontcia-btn-secondary';
  }

  function handleThemeClick(theme: Theme): void {
    setStoredTheme(theme)
      .then(() => {
        if (isStale()) return;
        onThemeChange(theme);
        renderThemeButtons(theme);
      })
      .catch((error: unknown) => console.error('fontCIA: failed to save theme preference', error));
  }

  darkBtn.addEventListener('click', () => handleThemeClick('dark'));
  lightBtn.addEventListener('click', () => handleThemeClick('light'));

  const currentTheme = await getStoredTheme();
  if (isStale()) return;
  renderThemeButtons(currentTheme);

  try {
    const authRes = await sendMessage<{ loggedIn: boolean; email?: string }>({ type: 'GET_AUTH_STATE' });
    if (isStale()) return;
    emailLine.textContent =
      authRes.ok && authRes.data.loggedIn && authRes.data.email
        ? `Logged in as ${authRes.data.email}`
        : 'Not logged in';
  } catch (error: unknown) {
    if (isStale()) return;
    console.error('fontCIA: failed to check auth state', error);
    emailLine.textContent = '';
  }
}
