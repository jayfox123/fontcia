import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { SavedFontRecord } from '../background/api-client';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderSavedFontsView(
  container: HTMLElement,
  isStale: () => boolean,
  onNavigateToAccount: () => void,
): Promise<void> {
  container.replaceChildren();

  let isLoggedIn = false;
  try {
    const authRes = await sendMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    isLoggedIn = authRes.ok && authRes.data.loggedIn;
  } catch (error: unknown) {
    console.error('fontCIA: failed to check auth state', error);
  }
  if (isStale()) return;

  if (!isLoggedIn) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = 'Log in to see your saved fonts.';
    container.appendChild(message);

    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Go to Account';
    loginBtn.addEventListener('click', onNavigateToAccount);
    container.appendChild(loginBtn);
    return;
  }

  let savedFonts: SavedFontRecord[] = [];
  try {
    const res = await sendMessage<SavedFontRecord[]>({ type: 'GET_SAVED_FONTS' });
    if (res.ok) savedFonts = res.data;
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch saved fonts', error);
  }
  if (isStale()) return;

  if (savedFonts.length === 0) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = "You haven't saved any fonts yet.";
    container.appendChild(message);
    return;
  }

  const list = document.createElement('div');
  for (const font of savedFonts) {
    const row = document.createElement('div');
    row.className = 'fontcia-list-row';

    const title = document.createElement('div');
    title.className = 'fontcia-list-row-title';
    title.textContent = font.fontName;
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'fontcia-list-row-meta';
    meta.textContent = `${font.confidence}% confidence · saved ${new Date(font.savedAt).toLocaleDateString()}`;
    row.appendChild(meta);

    if (font.sources.length > 0) {
      const sourcesList = document.createElement('ul');
      sourcesList.className = 'fontcia-sources';
      for (const source of font.sources) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.label;
        item.appendChild(link);
        sourcesList.appendChild(item);
      }
      row.appendChild(sourcesList);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'fontcia-btn fontcia-btn-secondary';
    deleteBtn.textContent = 'Remove';
    deleteBtn.addEventListener('click', () => {
      deleteBtn.disabled = true;
      sendMessage<null>({ type: 'DELETE_SAVED_FONT', id: font.id })
        .then((res) => {
          if (isStale()) return;
          if (res.ok) {
            row.remove();
          } else {
            console.error('fontCIA: failed to remove saved font', res.error);
            deleteBtn.disabled = false;
          }
        })
        .catch((error: unknown) => {
          if (isStale()) return;
          console.error('fontCIA: failed to remove saved font', error);
          deleteBtn.disabled = false;
        });
    });
    row.appendChild(deleteBtn);

    list.appendChild(row);
  }
  container.appendChild(list);
}
