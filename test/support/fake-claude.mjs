#!/usr/bin/env node
// A stand-in for the Claude Code binary, covering what lexis spawns it for:
// `--version`, `auth status`, and the interactive `auth login --claudeai`.
// The code "good-code" is accepted; anything else fails like the real CLI.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? '.';
const creds = path.join(dir, '.credentials.json');

if (args[0] === '--version') {
  console.log('0.0.0 (Fake Claude Code)');
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(fs.existsSync(creds) ? 0 : 1);
} else if (args[0] === 'auth' && args[1] === 'login') {
  console.log('Browser didn\'t open? Use the url below to sign in (c to copy)\n');
  console.log('https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=xyz\n');
  process.stdout.write('Paste code here if prompted > ');
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', (line) => {
    if (line.trim() === 'good-code') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
      console.log('Login successful.');
      process.exit(0);
    }
    process.stderr.write('Login failed: Invalid code\n');
    process.exit(1);
  });
} else {
  process.stderr.write(`fake claude: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}
