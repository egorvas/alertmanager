const express = require('express');
const bodyParser = require('body-parser');
const request = require('request');
const moment = require('moment');
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


function forwardWebhook(req, routes){
    logger.info("Forwarding webhook %s", req.body.commonLabels.alertname);
    routes.forEach(route => {
        request.post(route, {json: req.body, headers:  {"Content-type": "application/json"}}, function (error) {
            if (error) logger.log('error', error);
        });
    });
}


function updateAlertLastNotification(alert){
    const timeNow = new Date().toISOString();
    logger.info("Updating lastNotification label for alert %s with value %s", alert.labels.alertname, timeNow);
    alert.annotations.lastNotification =  timeNow;
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: [alert], headers: {"Content-type": "application/json"}}, function (error) {
        if (error) logger.log('error', error);
    });
}

function forceFinishAlert(alert){
    logger.info("Finishing alert %s", alert.labels.alertname);
    alert.endsAt=new Date().toISOString();
    request.post(ALERT_MANAGER_URL+"/api/v2/alerts", {json: [alert], headers: {"Content-type": "application/json"}}, function (error) {
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
    if (ruleFromConfig!==undefined){
        rules.initialSilence = Object.assign(rules.initialSilence, ruleFromConfig.rules.initialSilence);
        rules.repeat = Object.assign(rules.repeat, ruleFromConfig.rules.repeat);
        rules.autoResolve = Object.assign(rules.autoResolve, ruleFromConfig.rules.autoResolve);
        rules.hardAutoResolve = Object.assign(rules.hardAutoResolve, ruleFromConfig.rules.hardAutoResolve);
        rules.routes = Object.assign(rules.routes, ruleFromConfig.rules.routes);
        if (ruleFromConfig.rules.sendResolved !== undefined) rules.sendResolved = ruleFromConfig.rules.sendResolved;
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
    for (let i in req.body.alerts) {
        if (req.body.alerts.hasOwnProperty(i)) {
            const alert = req.body.alerts[i];
            const alertName = alert.labels.alertname;
            const lastNotification = alert.annotations.lastNotification;
            const lastIncidentInMills = +Date.parse(alert.annotations.lastIncident);
            const startAtInMills = +Date.parse(alert.startsAt);
            const isLastNotificationExists = lastNotification !== undefined && lastNotification;
            const isFiring = alert.status === "firing";
            const rules = getRules(alert.annotations.rules);

            if ((isFiring && rules.hardAutoResolve.enabled && (startAtInMills + hmsToMilliSeconds(rules.hardAutoResolve.interval)) < now) ||
                (isFiring && rules.autoResolve.enabled && (lastIncidentInMills + hmsToMilliSeconds(rules.autoResolve.interval)) < now)) {
                forceFinishAlert(alert);
            } else {
                if (rules.initialSilence.enabled && startAtInMills + hmsToMilliSeconds(rules.initialSilence.interval) > now) {
                } else {
                    if (isFiring) {
                        if (isLastNotificationExists) {
                            if (rules.repeat.enabled) {
                                const notificationInterval = hmsToMilliSeconds(isDayTime(now,
                                    rules.repeat.daySilenceIntervalStart, rules.repeat.daySilenceIntervalFinish, rules.repeat.useNightSilenceIntervalAtWeekend) ?
                                    rules.repeat.daySilenceInterval : rules.repeat.nightSilenceInterval);
                                if (+Date.parse(lastNotification) + notificationInterval < now) {
                                    updateAlertLastNotification(alert);
                                    alert.endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                                    req.body.alerts = [alert];
                                    forwardWebhook(req, rules.routes);
                                } else {
                                    logger.info("Notification for alert %s didn't send because of default notification interval", alertName);
                                }
                            }
                        } else {
                            updateAlertLastNotification(alert);
                            alert.endsAt = new Date().toISOString(); //needs for correct duration value at the telegram
                            req.body.alerts = [alert];
                            forwardWebhook(req, rules.routes);
                        }
                    } else {
                        if (rules.sendResolved) forwardWebhook(req, rules.routes);
                    }
                }
            }
        }
    }
    res.status(200).json({ result: 'ok' });
});



app.listen(PORT, () =>  logger.info("Starting server") );