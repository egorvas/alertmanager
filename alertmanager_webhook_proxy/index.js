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
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://0.0.0.0:8040";
const PORT = process.env.PORT || 3000;

const defaultRules = {"initialSilence": "10m",
    "daySilenceInterval": "2h",
    "nightSilenceInterval": "6h",
    "useNightSilenceIntervalAtWeekend": true,
    "daySilenceIntervalStart": "10:00:00",
    "daySilenceIntervalFinish": "23:00:00",
    "autoResolve": {"enabled": true, "interval": "10h"},
    "hardAutoResolve": {"enabled": false, "interval": "24h"},
    "sendResolved": true};


function forwardWebhook(req){
    logger.info("Forwarding webhook %s", req.body.commonLabels.alertname);
    req.body.alerts[0].endsAt = new Date().toISOString();
    request.post(WEBHOOK_URL, {json: req.body, headers:  {"Content-type": "application/json"}}, function (error, response) {
        if (error) logger.log('error', error);
        logger.log('info', 'statusCode: %s', response && response.statusCode);
    });
}

function postAlert(req, isFinish){
    request.get(ALERT_MANAGER_URL+"/api/v2/alerts", {qs: "filter={alertname=\""+req.body.name+"\",severity=\""+req.body.severity+"\",instance=\""+req.body.severity+"\"}"}, function (error, response) {
        if (error) logger.log('error', error);
        const responseAlertmanager = JSON.parse(response.body);
        let data = [{
                labels: {alertname: req.body.name, severity: req.body.severity, instance: req.body.instance},
                annotations: {message: req.body.message},
                generatorURL: req.body.url}];
        if (isFinish){
            logger.info("Finishing alert %s", req.body.name);
            data[0].endsAt=new Date().toISOString();
        }else{
            if (responseAlertmanager.length>0){
                data[0].annotations.lastNotification = responseAlertmanager[0].annotations.lastNotification;
            }
            data[0].annotations.lastIncident = new Date().toISOString();
            logger.info("Posting new alert %s", req.body.name);
        }
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

function finishAlert(req){
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

function getRules(alertName) {
    const rules = config.find(o => o.alertname === alertName);
    return (typeof rules !== "undefined" && rules) ? rules.ruleSet : defaultRules;
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
    const rules = getRules(alertName);
    const notificationInterval = hmsToMilliSeconds(isDayTime(now,
        rules.daySilenceIntervalStart, rules.daySilenceIntervalFinish, rules.useNightSilenceIntervalAtWeekend) ?
        rules.daySilenceInterval : rules.nightSilenceInterval);


    if (isFiring){
        if ((rules.hardAutoResolve.enabled && (startAtInMills + hmsToMilliSeconds(rules.hardAutoResolve.interval)) < now) ||
            (rules.autoResolve.enabled && (lastIncidentInMills + hmsToMilliSeconds(rules.autoResolve.interval)) < now)){
            finishAlert(req);
        }else{
            if (isLastNotificationExists){
                if (lastNotification + notificationInterval < now){
                    forwardWebhook(req); updateAlertLastNotification(req);
                }else{
                    logger.info("Notification isn't sent because of default notification interval");
                }
            }else{
                if (startAtInMills + hmsToMilliSeconds(rules.initialSilence) < now){
                    forwardWebhook(req); updateAlertLastNotification(req);
                }else{
                    logger.info("Notification isn't sent because of initial notification interval");
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
    postAlert(req, true);
    res.sendStatus(200);
});

app.post('/alertFail', (req, res) => {
    logger.info("Request to create new alert with data %s", JSON.stringify(req.body));
    postAlert(req, false);
    res.sendStatus(200);
});

app.listen(PORT, () =>  logger.info("Starting server") );