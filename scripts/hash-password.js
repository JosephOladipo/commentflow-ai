const { randomBytes, scryptSync } = require('node:crypto');
// FEATURE/FUNCTION: Password setup. PURPOSE: Create a salted hash from hidden terminal input, never command-line arguments.
if (!process.stdin.isTTY || !process.stdin.setRawMode) {
  console.error('Run npm run password-hash in an interactive terminal. Passwords are not accepted as command-line arguments.');
  process.exitCode = 1;
} else {
  let password = '';
  process.stdout.write('New owner password (at least 14 characters; hidden): ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    for (const char of chunk) {
      if (char === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\nCancelled.\n'); process.exit(1); }
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
        if (password.length < 14 || password.length > 1024) { console.error('Use a password between 14 and 1,024 characters.'); process.exit(1); }
        const salt = randomBytes(16).toString('hex');
        process.stdout.write('scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('hex') + '\n');
        password = ''; process.exit(0);
      }
      if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
      else if (char >= ' ' && password.length <= 1024) password += char;
    }
  });
}
