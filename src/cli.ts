/**
 * Recovery commands, run inside the container:
 *
 *   docker compose exec lexis node dist/cli.js status
 *   docker compose exec lexis node dist/cli.js signout-all
 *   docker compose exec lexis node dist/cli.js reset-passkeys
 *
 * The password always signs in as a backup, so these are for a lost or stolen
 * device: revoke every session, or forget every passkey, from a shell on the
 * host. The running app picks up the change on its next request.
 */
import path from 'node:path';
import { AuthStore } from './auth/store.js';
import { env } from './env.js';

const store = new AuthStore(path.join(env.authDir, 'auth.json'));
const [command] = process.argv.slice(2);

function status(): void {
  console.log(`password sign-in: ${env.password ? 'on (backup)' : 'off: LEXIS_PASSWORD is not set'}`);
  console.log(`passkeys: ${store.passkeys.length}`);
  for (const p of store.passkeys) console.log(`  - ${p.name} (created ${p.createdAt}, last used ${p.lastUsedAt ?? 'never'})`);
  console.log(`signed-in browsers: ${store.sessions.length}`);
  for (const s of store.sessions) console.log(`  - ${s.method}, last seen ${s.lastSeenAt}, ${s.ip} ${s.userAgent.slice(0, 60)}`);
}

switch (command) {
  case 'status':
    status();
    break;
  case 'signout-all':
    console.log(`signed out ${store.removeSessions(() => true)} browser(s)`);
    break;
  case 'reset-passkeys':
    store.reset();
    console.log('Removed every passkey and signed every browser out.');
    console.log(env.password ? 'Sign in with the password and set up a new passkey.' : 'Set LEXIS_PASSWORD, restart, then sign in and set up a new passkey.');
    break;
  default:
    console.log('usage: node dist/cli.js status | signout-all | reset-passkeys');
    process.exit(command ? 1 : 0);
}
