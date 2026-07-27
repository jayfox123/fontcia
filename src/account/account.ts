import { getStoredTheme, type Theme } from '../shared/theme-storage';
import { accountCss } from './account-theme';
import { renderAccountView } from './account-view';
import { renderSavedFontsView } from './saved-fonts-view';
import { renderHistoryView } from './history-view';
import { renderSettingsView } from './settings-view';

type Tab = 'account' | 'saved-fonts' | 'history' | 'settings';

const TAB_BUTTON_IDS: Record<Tab, string> = {
  account: 'tabAccount',
  'saved-fonts': 'tabSavedFonts',
  history: 'tabHistory',
  settings: 'tabSettings',
};

let activeTab: Tab = 'account';
let renderGeneration = 0;

function switchTab(tab: Tab): void {
  if (tab === activeTab) return;
  activeTab = tab;
  renderActiveTab();
}

function applyThemeToOwnPage(theme: Theme): void {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
}

function renderActiveTab(): void {
  renderGeneration += 1;
  const thisGeneration = renderGeneration;
  const isStale = (): boolean => renderGeneration !== thisGeneration;

  const thisTab = activeTab;
  for (const [tab, id] of Object.entries(TAB_BUTTON_IDS) as [Tab, string][]) {
    document.getElementById(id)?.classList.toggle('tab-active', tab === thisTab);
  }

  const container = document.getElementById('viewContainer') as HTMLElement;
  container.replaceChildren();

  if (thisTab === 'account') {
    void renderAccountView(container, isStale);
  } else if (thisTab === 'saved-fonts') {
    void renderSavedFontsView(container, isStale, () => switchTab('account'));
  } else if (thisTab === 'history') {
    void renderHistoryView(container, isStale, () => switchTab('account'));
  } else {
    void renderSettingsView(container, isStale, applyThemeToOwnPage);
  }
}

export async function initAccountPage(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = accountCss;
  document.head.appendChild(style);
  applyThemeToOwnPage(await getStoredTheme());

  for (const [tab, id] of Object.entries(TAB_BUTTON_IDS) as [Tab, string][]) {
    const btn = document.getElementById(id);
    if (!btn) {
      console.error(`fontCIA: missing tab button #${id}`);
      continue;
    }
    btn.addEventListener('click', () => switchTab(tab));
  }

  renderActiveTab();
}

initAccountPage();
