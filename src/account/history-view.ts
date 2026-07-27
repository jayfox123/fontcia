import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { ScanRecord } from '../background/api-client';

function sendMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

export async function renderHistoryView(
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
    message.textContent = 'Log in to see your scan history.';
    container.appendChild(message);

    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-primary';
    loginBtn.textContent = 'Go to Account';
    loginBtn.addEventListener('click', onNavigateToAccount);
    container.appendChild(loginBtn);
    return;
  }

  let scans: ScanRecord[] = [];
  try {
    const res = await sendMessage<ScanRecord[]>({ type: 'GET_SCANS' });
    if (res.ok) scans = res.data;
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch scan history', error);
  }
  if (isStale()) return;

  if (scans.length === 0) {
    const message = document.createElement('p');
    message.className = 'fontcia-empty-message';
    message.textContent = "You haven't scanned anything yet.";
    container.appendChild(message);
    return;
  }

  const list = document.createElement('div');
  for (const scan of scans) {
    const row = document.createElement('div');
    row.className = 'fontcia-list-row';

    const title = document.createElement('div');
    title.className = 'fontcia-list-row-title';
    title.textContent = scan.status === 'match' && scan.fontName ? scan.fontName : 'No match';
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'fontcia-list-row-meta';
    const confidencePart =
      scan.status === 'match' && scan.confidence !== null ? `${scan.confidence}% confidence · ` : '';
    meta.textContent = `${confidencePart}${new Date(scan.createdAt).toLocaleString()}`;
    row.appendChild(meta);

    list.appendChild(row);
  }
  container.appendChild(list);
}
