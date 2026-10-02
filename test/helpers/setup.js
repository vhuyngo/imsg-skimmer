import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBackup } from './fixtures.js';

const PREFIX = path.join(os.tmpdir(), 'imsg-skimmer-test-');

// Creates a temp root with one unencrypted and one encrypted synthetic backup.
export function makeFixtures() {
  const tmp = fs.mkdtempSync(PREFIX);
  const backupRoot = path.join(tmp, 'Backup');
  const plain = buildBackup(path.join(backupRoot, '00000000-PLAINFIXTURE0001'), { udid: '00000000plainfixture0001' });
  const encrypted = buildBackup(path.join(backupRoot, 'ffffffffencryptedfixture0000000000000002'), { encrypted: true, udid: 'ffffffffencryptedfixture0000000000000002' });
  return {
    tmp,
    backupRoot,
    plain,
    encrypted,
    cacheDir: path.join(tmp, 'cache'),
    cleanup() {
      if (tmp.startsWith(PREFIX)) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
