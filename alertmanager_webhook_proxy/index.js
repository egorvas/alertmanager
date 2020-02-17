const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const moment = require('moment');
const app = express().use(bodyParser.json());
const config = require('./config/config.json');
const { createLogger, format, transports,  } = require('winston');
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

const ALERT_MANAGER_URL = process.env.ALERTMANAGER_URL || "http://0.0.0.0:9093";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://0.0.0.0:8080";
const PORT = process.env.PORT || 3000;
const defaultRules = {"initialSilence": "0",
    "daySilenceInterval": "2h",
    "nightSilenceInterval": "8h",
    "useNightSilenceIntervalAtWeekend": true,
    "daySilenceIntervalStart": "10:00:00",
    "daySilenceIntervalFinish": "23:00:00",
    "autoResolve": {"enabled": true, "interval": "1m"},
    "hardAutoResolve": {"enabled": false, "interval": "24h"},
    "sendResolved": false,
    "routes": [WEBHOOK_URL]};


function forwardWebhook(req, routes){
    logger.info("Forwarding webhook %s", req.body.commonLabels.alertname);
    routes.forEach(route => {
        request.post(route, {json: req.body, headers:  {"Content-type": "application/json"}}, function (error, response) {
            if (error) logger.log('error', error);
            logger.log('info', 'statusCode: %s', response && response.statusCode);
        });
    });
}

function finishAlert(req){
    logger.info("Finishing alert %s", req.body.name);
    if (typeof req.body.rules === 'undefined' || req.body.rules) req.body.rules = "default";
    request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "active=true&filter={alertname=\""+req.body.name+"\",rules=\""+req.body.rules+"\",instance=\""+req.body.instance+"\"}"}, function (error, response) {
        if (error) logger.log('error', error);

        if (JSON.parse(response.body).length===0){
            logger.info("No alerts %s to finish", req.body.name);
        }else {
            let data = [{
                labels: {alertname: req.body.name, rules: req.body.rules, instance: req.body.instance},
                annotations: {message: req.body.message},
                generatorURL: req.body.url,
                endsAt: new Date().toISOString()}];
            request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error, response) {
                if (error) logger.log('error', error);
                logger.info('statusCode: %s', response && response.statusCode);
            });
        }
    });
}

function postAlert(req){
    logger.info("Posting new alert %s", req.body.name);
    if (typeof req.body.rules === 'undefined' || !req.body.rules) req.body.rules = "default";
    request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "active=true&filter={alertname=\""+req.body.name+"\",rules=\""+req.body.rules+"\",instance=\""+req.body.instance+"\"}"}, function (error, response) {
        if (error) logger.log('error', error);
        const responseAlertmanager = JSON.parse(response.body);

        let data = [{
                labels: {alertname: req.body.name, rules: req.body.rules, instance: req.body.instance},
                annotations: {message: req.body.message, lastIncident: new Date().toISOString()},
                generatorURL: req.body.url}];

        if (responseAlertmanager.length>0)
            data[0].annotations.lastNotification = responseAlertmanager[0].annotations.lastNotification;

        request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error, response) {
            if (error) logger.log('error', error);
            logger.info('statusCode: %s', response && response.statusCode);
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
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error, response) {
        if (error) logger.log('error', error);
        logger.info('statusCode: %s', response && response.statusCode);
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
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: data, headers: {"Content-type": "application/json"}}, function (error, response) {
        if (error) logger.log('error', error);
        logger.info('statusCode: %s', response && response.statusCode);
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
    let rules = defaultRules;
    const ruleFromConfig = config.find(o => o.name === rulesName);
    if (typeof ruleFromConfig !== "undefined" && ruleFromConfig){
        Object.keys(ruleFromConfig.rules).forEach(function(key) {
            rules[key] = ruleFromConfig.rules[key];
        });
    }
    return rules;
}

app.post('/webhook', (req, res) => {
    logger.info("Get new webhook with data %s", JSON.stringify(req.body));
    const now = +Date.now();
    const alertName = req.body.commonLabels.alertname;
    const lastNotification = req.body.commonAnnotations.lastNotification;
    const lastIncidentInMills = +Date.parse(req.body.commonAnnotations.lastIncident);
    const startAtInMills = +Date.parse(req.body.alerts[0].startsAt);
    const isLastNotificationExists = typeof lastNotification !== 'undefined' && lastNotification;
    const isFiring = req.body.status==="firing";
    const rules = getRules(req.body.commonLabels.rules);
    const notificationInterval = hmsToMilliSeconds(isDayTime(now,
        rules.daySilenceIntervalStart, rules.daySilenceIntervalFinish, rules.useNightSilenceIntervalAtWeekend) ?
        rules.daySilenceInterval : rules.nightSilenceInterval);

    if (isFiring){
        if ((rules.hardAutoResolve.enabled && (startAtInMills + hmsToMilliSeconds(rules.hardAutoResolve.interval)) < now) ||
            (rules.autoResolve.enabled && (lastIncidentInMills + hmsToMilliSeconds(rules.autoResolve.interval)) < now)){
            forceFinishAlert(req);
        }else{
            if (isLastNotificationExists){
                if (+Date.parse(lastNotification) + notificationInterval < now){
                    req.body.alerts[0].endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                    forwardWebhook(req, rules.routes); updateAlertLastNotification(req);
                }else{
                    logger.info("Notification for alert %s isn't sent because of default notification interval", alertName);
                }
            }else{
                if (startAtInMills + hmsToMilliSeconds(rules.initialSilence) < now){
                    req.body.alerts[0].endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                    forwardWebhook(req, rules.routes); updateAlertLastNotification(req);
                }else{
                    logger.info("Notification for alert %s isn't sent because of initial notification interval", alertName);
                }
            }
        }

    }else{
        if (rules.sendResolved) forwardWebhook(req);
    }


    res.sendStatus(200);
});

app.post('/alertOk', (req, res) => {
    logger.info("Request to finish alert with data %s", JSON.stringify(req.body));
    finishAlert(req);
    res.sendStatus(200);
});

app.post('/alertFail', (req, res) => {
    logger.info("Request to create new alert with data %s", JSON.stringify(req.body));
    postAlert(req);
    res.sendStatus(200);
});

app.listen(PORT, () =>  logger.info("Starting server") );