const path = require('node:path');
const { readConfig } = require('./runtime');
// FEATURE/FUNCTION: Environment loading. PURPOSE: Keep keys server-side and never overwrite an existing .env.
function loadConfig() {
  require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
  return readConfig();
}
module.exports = { loadConfig };
