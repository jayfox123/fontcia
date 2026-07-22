import { createChromeMock } from './helpers/chrome-mock';

// Exported so tests can assert on side effects that happen at module-load time
// (e.g. the background service worker's setAccessLevel call), since that code
// runs against whichever chrome mock is installed at import time — this one —
// not the fresh per-test mock a suite's beforeEach installs afterwards. Not
// meant for general use in tests; grab a fresh mock via createChromeMock() instead.
export const moduleLoadChromeMock = createChromeMock();
(globalThis as unknown as { chrome: unknown }).chrome = moduleLoadChromeMock;
