const config = require('config');

const { AlertReceiver, initLogger, initMetric } = require('../src/alert_receiver');

const logger = initLogger(config.logger);
const metric = initMetric(config.metric || {});

const server = new AlertReceiver(config, logger, metric, []);

(async () => {
    try {
        await server.start(config.app.port, config.app.host);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();