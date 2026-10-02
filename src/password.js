// Reads the backup password from the terminal without echoing it.
import fs from 'node:fs';
import tty from 'node:tty';

export const TEST_PASSWORD_ENV = 'IMSG_SKIMMER_TEST_PASSWORD';

export function readPassword(prompt = 'Backup password: ') {
  return new Promise((resolve, reject) => {
    let input = process.stdin;
    let output = process.stderr;
    const fds = [];
    if (!process.stdin.isTTY) {
      try {
        fds.push(fs.openSync('/dev/tty', 'r'), fs.openSync('/dev/tty', 'w'));
      } catch {
        fds.forEach((fd) => fs.closeSync(fd));
        reject(new Error('A terminal is required to type the backup password.'));
        return;
      }
      input = new tty.ReadStream(fds[0]);
      output = new tty.WriteStream(fds[1]);
    }
    let value = '';
    let escape = false;
    const finish = (err) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (fds.length) {
        input.destroy();
        output.destroy();
      }
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape) {
          // Skip terminal escape sequences (arrow keys, bracketed-paste markers).
          if (/[A-Za-z~]/.test(ch)) escape = false;
          continue;
        }
        if (ch === '\u001b') escape = true;
        else if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        else if (ch === '\u0003') return finish(new Error('Cancelled.'));
        else if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

// Password callback for Backup.open(): the terminal, or the test-only environment variable.
export function passwordSource(log) {
  if (process.env[TEST_PASSWORD_ENV] !== undefined) {
    const password = process.env[TEST_PASSWORD_ENV];
    delete process.env[TEST_PASSWORD_ENV];
    const fromEnv = async () => {
      log(`Using the password from ${TEST_PASSWORD_ENV} (meant for tests only).`);
      return password;
    };
    fromEnv.interactive = false;
    return fromEnv;
  }
  const fromTty = (attempt) => readPassword(attempt > 1 ? 'Backup password (try again): ' : 'Backup password: ');
  fromTty.interactive = true;
  return fromTty;
}
