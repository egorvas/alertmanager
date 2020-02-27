let api;

api = require('api-server');
const request = require('request-promise');
const ALERT_MANAGER_URL = process.env.ALERTMANAGER_URL || "http://0.0.0.0:9093";


const {
    ApiServer,
    initLogger, initMetric,
    utils: {
        getMetricPathREST
    }
} = api;

const routes = [{
        path: '/alerts',
        method: 'post',
        resourceList: ["logger"],
        preprocessors: [],
        validator: {},
        route: async (alerts, {logger}) => postAlert(alerts, logger)
    },
    {
        path: '/alerts',
        method: 'delete',
        resourceList: ["logger"],
        preprocessors: [],
        validator: {},
        route: async (alerts, {logger}) => finishAlert(alerts, logger)
    }];



class AlertReceiver extends ApiServer {
    constructor(...args) {
        super(...args);
        this.routes = routes;
    }

    async beforeStart() {
        try {
            await super.beforeStart();
            this.app.use(this.corsMiddleware());
            this.app.use(this.startTimeMiddleware());
            this.app.use(this.swaggerMiddlewares.metadata());
            this.app.use(this.swaggerMiddlewares.parseRequest());
            this.app.use(this.requestIdMiddleware());
            this.app.use(this.loggerWithContextMiddleware());
            this.app.use(this.writeRequestLog());
            this.app.use(this.swaggerMiddlewares.validateRequest());
            this.app.use(this.resourceCheckMiddleware());
            await this.initRoutes(this.routes);
            this.app.use(this.errorHandlingMiddleware());
            this.app.use(this.writeMetricMiddleware());
            this.app.use(this.writeErrorMetricMiddleware((req, res) => {
                const restGetPath = getMetricPathREST('api');
                if (!res.locals.path && req.url.indexOf('/sync/') === 0) {
                    return `api.${req.method.toLowerCase()}._sync_userid_timestamp`;
                }
                return `${restGetPath(req, res)}`;
            }));
        } catch (e) {
            throw e;
        }
        return Promise.resolve();
    }
}

async function finishAlert(alerts, logger) {
    const responseAlertmanager = JSON.parse(await request.get(ALERT_MANAGER_URL + "/api/v2/alerts", {qs: "active=true"}));
    let alertsData = [];
    for (let i in alerts) {
        if (alerts.hasOwnProperty(i)){
            const filteredAlert = responseAlertmanager.find(findAlert => findAlert.labels.alertname === alerts[i].name);
            if (filteredAlert === undefined) {
                logger.info(`No alerts ${alerts[i].name} to finish`);
            } else {
                filteredAlert.endsAt = new Date().toISOString();
                if (alerts[i].description !== undefined && alerts[i].description) filteredAlert.annotations.description = alerts[i].description;
                if (alerts[i].url !== undefined && alerts[i].url) filteredAlert.generatorURL = alerts[i].url;
                alertsData.push(filteredAlert);
            }
        }
    }
    await request.post(ALERT_MANAGER_URL + "/api/v2/alerts", {
        json: alertsData,
        headers: {"Content-type": "application/json"}
    });
    return {alerts:alertsData};
}


async function postAlert(alerts, logger){
    const responseAlertmanager =  JSON.parse(await request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "active=true"}));
    console.log(responseAlertmanager);
    let alertsData = [];
    for (let i in alerts){
        if (alerts.hasOwnProperty(i)){
            if (alerts[i].rules === undefined || !alerts[i].rules) alerts[i].rules = "default";
            let data = {
                labels: {alertname: alerts[i].name},
                annotations: {description: alerts[i].description, lastIncident: new Date().toISOString(), count: "1", rules: alerts[i].rules},
                generatorURL: alerts[i].url};
            const filteredAlert = responseAlertmanager.find(findAlert => findAlert.labels.alertname === alerts[i].name);
            if (filteredAlert !== undefined) {
                data.annotations.lastNotification = filteredAlert.annotations.lastNotification;
                data.annotations.count = (parseInt(filteredAlert.annotations.count) + 1).toString();
            }
            alertsData.push(data);
        }
    }
    logger.info(`Posing new alerts ${JSON.stringify(alertsData)}`);
    await request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {
        json: alertsData,
        headers: {"Content-type": "application/json"}
    });

    return {alerts:alertsData};
}

module.exports = { AlertReceiver, initLogger, initMetric };