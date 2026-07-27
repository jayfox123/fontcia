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

function switchTab(tab: Tab): void {
  activeTab = tab;
  renderActiveTab();
}

function applyThemeToOwnPage(theme: Theme): void {
  document.documentElement.classList.toggle('theme-light', theme === 'light');
}

function renderActiveTab(): void {
  const thisTab = activeTab;
  const isStale = (): boolean => activeTab !== thisTab;

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

  document.getElementById('tabAccount')?.addEventListener('click', () => switchTab('account'));
  document.getElementById('tabSavedFonts')?.addEventListener('click', () => switchTab('saved-fonts'));
  document.getElementById('tabHistory')?.addEventListener('click', () => switchTab('history'));
  document.getElementById('tabSettings')?.addEventListener('click', () => switchTab('settings'));

  renderActiveTab();
}

initAccountPage();
