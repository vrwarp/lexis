import { createServer } from './app.js';
import { CREDENTIAL_LABEL, detectCredential, env } from './env.js';

const server = createServer();

server.listen(env.port, () => {
  console.log(`lexis listening on http://localhost:${env.port}`);
  console.log(
    `[lexis] models: translation ${env.models.translation} (${env.effort.translation}), ` +
      `mechanical ${env.models.mechanical} (${env.effort.mechanical}), ` +
      `orchestrator ${env.models.orchestrator} (${env.effort.orchestrator})`,
  );
  if (!env.password) console.warn('[lexis] LEXIS_PASSWORD is not set: nobody can sign in until it is.');
  const credential = detectCredential();
  console.log(
    credential === 'none'
      ? '[lexis] no Claude credential yet: sign in with your Claude subscription from the web UI.'
      : `[lexis] Claude credential: ${CREDENTIAL_LABEL[credential]}`,
  );
});
