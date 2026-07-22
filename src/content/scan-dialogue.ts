export function renderReadyState(body: HTMLElement, onScan: () => void): void {
  body.replaceChildren();

  const scanBtn = document.createElement('button');
  scanBtn.type = 'button';
  scanBtn.className = 'fontcia-btn fontcia-btn-primary';
  scanBtn.textContent = 'Scan';
  scanBtn.addEventListener('click', onScan);

  body.appendChild(scanBtn);
}

export function renderLoadingState(body: HTMLElement): void {
  body.replaceChildren();

  const spinner = document.createElement('div');
  spinner.className = 'fontcia-spinner';

  body.appendChild(spinner);
}
