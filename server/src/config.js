/**
 * Server configuration loaded from environment variables.
 */
module.exports = {
  port: parseInt(process.env.PORT || '3001', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || '*',
};
