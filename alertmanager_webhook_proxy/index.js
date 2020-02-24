const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const moment = require('moment');
const { body, validationResult } = require('express-validator');
const { createLogger, format, transports,  } = require('winston');

const config = require('./config/config.json');
const logger = createLogger({
    format: format.combine(
        format.timestamp(),
        format.prettyPrint(),
        format.splat(),
        format.simple()
    ),
    transports: [
        new transports.Console()
    ]
});
const app = express().use(bodyParser.json());

const ALERT_MANAGER_URL = process.env.ALERTMANAGER_URL || "http://0.0.0.0:9093";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://0.0.0.0:8080";
const PORT = process.env.PORT || 3000;

const defaultAlertRules = {
    "initialSilence": {
        "enabled": false,
        "interval": "10m"
    },
    "repeat": {
        "enabled": true,
        "daySilenceInterval": "2h",
        "nightSilenceInterval": "8h",
        "useNightSilenceIntervalAtWeekend": true,
        "daySilenceIntervalStart": "10:00:00",
        "daySilenceIntervalFinish": "23:00:00"
    },
    "autoResolve": {
        "enabled": true,
        "interval": "1m"
    },
    "hardAutoResolve": {
        "enabled": false,
        "interval": "24h"
    },
    "sendResolved": false,
    "routes": [WEBHOOK_URL]};


const requestOkRules = [
    body('name').isString().isLength({ min: 3 }).withMessage('Must be a string with minimum 3 symbols'),
    body('instance').isString().isLength({ min: 1 }).withMessage('Must be a string with minimum 1 symbol')
];

const requestFailRules = [
    body('name').isString().isLength({ min: 3 }).withMessage('Must be a string with minimum 3 symbols'),
    body('instance').isString().isLength({ min: 1 }).withMessage('Must be a string with minimum 1 symbol'),
    body('message').isString().isLength({ min: 3 }).withMessage('Must be a string with minimum 3 symbols'),
    body("url").if(body("url").exists()).isURL().withMessage('Must be valid url'),
    body("rules").if(body("rules").not().isIn(['default', null])).isIn(config.map(x => x.name)).withMessage('Rule not found')
];

function forwardWebhook(req, routes){
    logger.info("Forwarding webhook %s", req.body.commonLabels.alertname);
    routes.forEach(route => {
        request.post(route, {json: req.body, headers:  {"Content-type": "application/json"}}, function (error) {
            if (error) logger.log('error', error);
        });
    });
}

function finishAlert(req){
    if (typeof req.body.rules === 'undefined' || !req.body.rules) req.body.rules = "default";
    request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "active=true"}, function (error, response) {
        if (error) logger.log('error', error);
        const responseObject = JSON.parse(response.body);
        if (responseObject.find(alert =>
            alert.labels.alertname === req.body.name &&
            alert.labels.instance === req.body.instance)===undefined){
            logger.info("No alerts %s to finish", req.body.name);
        }else {
            logger.info("Finishing alert %s", req.body.name);
            let data = [{
                labels: responseObject[0].labels,
                annotations: responseObject[0].annotations,
                generatorURL: responseObject[0].generatorURL,
                endsAt: new Date().toISOString()}];
            request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error) {
                if (error) logger.log('error', error);
            });
        }
    });
}

function postAlert(req){
    logger.info("Posting new alert %s", req.body.name);
    if (typeof req.body.rules === 'undefined' || !req.body.rules) req.body.rules = "default";
    request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "active=true"}, function (error, response) {
        if (error) logger.log('error', error);
        const responseAlertmanager = JSON.parse(response.body);
        let data = [{
                labels: {alertname: req.body.name, instance: req.body.instance},
                annotations: {message: req.body.message, lastIncident: new Date().toISOString(), count: "1", rules: req.body.rules},
                generatorURL: req.body.url}];

        const filteredAlert = responseAlertmanager.find(alert => alert.labels.alertname === req.body.name && alert.labels.instance === req.body.instance);
        if (filteredAlert !== undefined) {
                data[0].annotations.lastNotification = filteredAlert.annotations.lastNotification;
                data[0].annotations.count = (parseInt(filteredAlert.annotations.count) + 1).toString();
        }

        request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error, response) {
            if (error) logger.log('error', error);
        });

    });
}

function updateAlertLastNotification(req){
    const timeNow = new Date().toISOString();
    logger.info("Updating lastNotification label for alert %s with value %s", req.body.commonLabels.alertname, timeNow);
    let data = [{
        labels: req.body.alerts[0].labels,
        annotations: req.body.alerts[0].annotations,
        startsAt: req.body.alerts[0].startsAt,
        generatorURL: req.body.alerts[0].generatorURL
    }];
    data[0].annotations.lastNotification =  timeNow;
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error) {
        if (error) logger.log('error', error);
    });
}

function forceFinishAlert(req){
    logger.info("Finishing alert %s", req.body.commonLabels.alertname);
    let data = [{
        labels: req.body.alerts[0].labels,
        annotations: req.body.alerts[0].annotations,
        startsAt: req.body.alerts[0].startsAt,
        endsAt: new Date().toISOString(),
        generatorURL: req.body.alerts[0].generatorURL
    }];
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error) {
        if (error) logger.log('error', error);
    });
}

function hmsToMilliSeconds(hms){
    let seconds = 0;
    let hmsSplit;
    if (hms.includes('h')){
        hmsSplit = hms.split('h');
        seconds += +hmsSplit[0] * 3600;
        hms = hmsSplit[1];
    }
    if (hms.includes('m')){
        hmsSplit = hms.split('m');
        seconds += +hmsSplit[0] * 60;
        hms = hmsSplit[1];
    }
    if (hms.includes('s')){
        hmsSplit = hms.split('s');
        seconds += +hmsSplit[0];
    }
    return seconds * 1000;
}

function isDayTime(now, daySilenceIntervalStart, daySilenceIntervalFinish, useNightSilenceIntervalAtWeekend){
    const day = new Date(now).getDay();
    const isWeekend = (day === 6) || (day === 0);
    if (useNightSilenceIntervalAtWeekend && isWeekend){
        return false;
    }else{
        const start = (+moment(daySilenceIntervalStart, 'HH:mm:ss').toDate());
        const finish =(moment(daySilenceIntervalFinish, 'HH:mm:ss').toDate());
        return (start < now && now < finish);
    }
}

function getRules(rulesName) {
    let rules = JSON.parse(JSON.stringify(defaultAlertRules));
    const ruleFromConfig = config.find(o => o.name === rulesName);
    if (ruleFromConfig !== undefined && ruleFromConfig){
        Object.keys(ruleFromConfig.rules).forEach(function(key) {
            rules[key] = ruleFromConfig.rules[key];
        });
    }
    return rules;
}


app.use(function(err, req, res, next) {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({ result: "error", errors: [{msg: "Invalid JSON", location: "body"}] });
    } else next();
});

app.post('/webhook', (req, res) => {
    logger.info("Get new webhook with data %s", JSON.stringify(req.body));
    const now = +Date.now();
    const alertName = req.body.commonLabels.alertname;
    const lastNotification = req.body.commonAnnotations.lastNotification;
    const lastIncidentInMills = +Date.parse(req.body.commonAnnotations.lastIncident);
    const startAtInMills = +Date.parse(req.body.alerts[0].startsAt);
    const isLastNotificationExists = lastNotification !== undefined && lastNotification;
    const isFiring = req.body.status==="firing";
    const rules = getRules(req.body.commonAnnotations.rules);
    if ((isFiring && rules.hardAutoResolve.enabled && (startAtInMills + hmsToMilliSeconds(rules.hardAutoResolve.interval)) < now) ||
        (isFiring && rules.autoResolve.enabled && (lastIncidentInMills + hmsToMilliSeconds(rules.autoResolve.interval)) < now)){
        forceFinishAlert(req);
    }else{
        if (rules.initialSilence.enabled && startAtInMills + hmsToMilliSeconds(rules.initialSilence.interval) > now){
            logger.info("Notification for alert %s didn't send because of initial notification interval", alertName);
        }else{
            if (isFiring){
                if (isLastNotificationExists){
                    if (rules.repeat.enabled){
                        const notificationInterval = hmsToMilliSeconds(isDayTime(now,
                            rules.repeat.daySilenceIntervalStart, rules.repeat.daySilenceIntervalFinish, rules.repeat.useNightSilenceIntervalAtWeekend) ?
                            rules.repeat.daySilenceInterval : rules.repeat.nightSilenceInterval);
                        if (+Date.parse(lastNotification) + notificationInterval < now){
                            req.body.alerts[0].endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                            forwardWebhook(req, rules.routes); updateAlertLastNotification(req);
                        }else{
                            logger.info("Notification for alert %s didn't send because of default notification interval", alertName);
                        }
                    }
                }else{
                    req.body.alerts[0].endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                    forwardWebhook(req, rules.routes); updateAlertLastNotification(req);
                }
            }else{
                if (rules.sendResolved) forwardWebhook(req, rules.routes);
            }
        }
    }

    res.status(200).json({ result: 'ok' });
});

app.post('/alertOk',requestOkRules, (req, res) => {
    logger.info("Request to finish alert with data %s", JSON.stringify(req.body));
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ result: "error", errors: errors.array() });
    }else{
        finishAlert(req);
        res.status(200).json({ result: 'ok' });
    }
});

app.post('/alertFail',requestFailRules, (req, res) => {
    logger.info("Request to post alert with data %s", JSON.stringify(req.body));
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ result: "error", errors: errors.array() });
    }else{
        postAlert(req);
        res.status(200).json({ result: 'ok' });
    }
});

app.listen(PORT, () =>  logger.info("Starting server") );