const { createProvider: createLinkedInProvider } = require('../apify');
const { createFacebookProvider } = require('./facebook');
const { createInstagramProvider } = require('./instagram');
function createProviders(config) { return { linkedin: createLinkedInProvider({ token: config.token, actor: config.linkedinActor }), facebook: createFacebookProvider({ token: config.token, actor: config.facebookActor }), instagram: createInstagramProvider({ token: config.token, actor: config.instagramActor }) }; }
module.exports = { createProviders };
