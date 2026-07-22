export const themeCss = `
.fontcia-surface {
  --fontcia-bg: #14171A;
  --fontcia-surface: #1F242B;
  --fontcia-text: #E8E6E1;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #3FA796;
  --fontcia-border: #2A2F36;

  position: fixed;
  inset: 0;
  cursor: crosshair;
}

/* Light tokens are wired now so a future toggle is a class swap, not a restyle. Not applied anywhere yet. */
.fontcia-surface.theme-light {
  --fontcia-bg: #FFFFFF;
  --fontcia-surface: #F4F4F5;
  --fontcia-text: #18181B;
  --fontcia-accent: #FF6A3D;
  --fontcia-success: #16A34A;
  --fontcia-border: #E5E5E7;
}

.fontcia-draft-box,
.fontcia-box {
  position: fixed;
  border: 2px dashed var(--fontcia-accent);
  background: rgba(255, 106, 61, 0.1);
  pointer-events: none;
}

.fontcia-panel {
  position: fixed;
  min-width: 180px;
  background: var(--fontcia-surface);
  border: 1px solid var(--fontcia-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color: var(--fontcia-text);
  padding: 10px 14px;
  pointer-events: auto;
}

.fontcia-notch {
  position: absolute;
  top: -8px;
  left: 24px;
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-bottom: 8px solid var(--fontcia-surface);
}

.fontcia-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.fontcia-panel-close {
  cursor: pointer;
  opacity: 0.6;
}

.fontcia-panel-close:hover {
  opacity: 1;
}

.fontcia-panel-body {
  color: var(--fontcia-text);
  font-size: 12px;
}

.fontcia-btn {
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
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

.fontcia-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--fontcia-border);
  border-top-color: var(--fontcia-accent);
  border-radius: 50%;
  animation: fontcia-spin 0.8s linear infinite;
}

@keyframes fontcia-spin {
  to {
    transform: rotate(360deg);
  }
}

.fontcia-result-font {
  font-size: 15px;
  font-weight: 600;
}

.fontcia-confidence {
  color: var(--fontcia-success);
  font-size: 12px;
  margin-top: 2px;
}

.fontcia-sources {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 96px;
  overflow-y: auto;
}

.fontcia-source-link {
  display: block;
  color: var(--fontcia-text);
  font-size: 12px;
  text-decoration: none;
  padding: 2px 0;
}

.fontcia-source-link:hover {
  text-decoration: underline;
}

.fontcia-result-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.fontcia-no-match-message {
  font-size: 12px;
  color: var(--fontcia-text);
  margin-bottom: 10px;
}
`;
