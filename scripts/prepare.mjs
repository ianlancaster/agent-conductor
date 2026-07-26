import { existsSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

// Consumer installs have neither .git nor the dev-only husky dependency. A contributor checkout has
// both, so it still receives repository hooks without making prepare a packaging footgun.
if (existsSync(new URL('../.git', import.meta.url))) {
  try {
    const { default: husky } = await import('husky');
    const message = husky();
    if (message) process.stderr.write(`${message}\n`);
  } catch (error) {
    if ((error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') === false) throw error;
  }
}
