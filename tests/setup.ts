import { createChromeMock } from './helpers/chrome-mock';

(globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
