import { DARK_THEME_VARS, LIGHT_THEME_VARS } from '../shared/theme-colors';

export const accountCss = `
:root {
  ${DARK_THEME_VARS}
}

:root.theme-light {
  ${LIGHT_THEME_VARS}
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--fontcia-bg);
  color: var(--fontcia-text);
  min-width: 360px;
}

#tabNav {
  display: flex;
  border-bottom: 1px solid var(--fontcia-border);
}

.fontcia-tab-btn {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--fontcia-text);
  padding: 12px 8px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.fontcia-tab-btn.tab-active {
  border-bottom-color: var(--fontcia-accent);
  font-weight: 600;
}

#viewContainer {
  padding: 20px;
  max-width: 480px;
}

.fontcia-btn {
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

.fontcia-btn-primary {
  background: var(--fontcia-accent);
  color: #ffffff;
}

.fontcia-btn-secondary {
  background: transparent;
  border: 1px solid var(--fontcia-border);
  color: var(--fontcia-text);
}

.fontcia-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.fontcia-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--fontcia-border);
  border-radius: 6px;
  background: var(--fontcia-surface);
  color: var(--fontcia-text);
  font-size: 13px;
  font-family: inherit;
}

.fontcia-sources {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

.fontcia-sources a {
  color: var(--fontcia-text);
  font-size: 12px;
  text-decoration: none;
}

.fontcia-sources a:hover {
  text-decoration: underline;
}

.fontcia-list-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 0;
  border-bottom: 1px solid var(--fontcia-border);
}

.fontcia-list-row:last-child {
  border-bottom: none;
}

.fontcia-list-row-title {
  font-size: 14px;
  font-weight: 600;
}

.fontcia-list-row-meta {
  font-size: 12px;
  color: var(--fontcia-text);
  opacity: 0.8;
}

.fontcia-error-message {
  color: var(--fontcia-accent);
  font-size: 12px;
}

.fontcia-empty-message {
  font-size: 13px;
  opacity: 0.8;
  margin-bottom: 12px;
}
`;
