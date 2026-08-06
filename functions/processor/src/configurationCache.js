const { ConfigurationCache } = require('@xtract/common');
const { getClient } = require('./documentProcessingCommon');

const configurationCache = new ConfigurationCache({
  loader: async () => {
    const client = await getClient();
    return await client.db().collection('configuration').findOne({}) || {};
  },
});

module.exports = {
  getConfiguration: configurationCache.get.bind(configurationCache),
};
