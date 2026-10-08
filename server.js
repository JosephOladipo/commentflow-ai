const { loadConfig } = require('./src/config');
const { createProviders } = require('./src/services/providers');
const { createDiscovery } = require('./src/services/discovery');
const { createCommentService } = require('./src/services/comments');
const { createAccountStore } = require('./src/services/account-store');
const { createApp } = require('./src/routes/app');
// FEATURE/FUNCTION: Local startup. PURPOSE: Initialize persistence and HTTP without calling the provider.
async function start() {
  const config = loadConfig();
  const discovery = await createDiscovery({ provider: createProviders(config), cacheFile: config.cacheFile });
  const accountStore = await createAccountStore({ file: config.accountStoreFile });
  const comments = await createCommentService({ apiKey: config.openaiKey, model: config.openaiModel, cacheFile: config.commentCacheFile, discovery });
  const app = createApp({ discovery, comments, accountStore, apifyConfigured: Boolean(config.token), openaiConfigured: Boolean(config.openaiKey), auth: config });
  const server = app.listen(config.port, config.host, () => console.log('CommentFlow AI is listening on port ' + config.port));
  server.requestTimeout = 160000;
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port is already in use. Stop the other instance or set PORT in .env.' : 'Unable to start the local server.');
    process.exitCode = 1;
  });
  return server;
}
if (require.main === module) start().catch(error => { console.error(error.code === 'CONFIGURATION_ERROR' ? error.message : 'Startup failed. Check the configured data directory and local permissions.'); process.exitCode = 1; });
module.exports = { start };
