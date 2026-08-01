/**
 * index.js — Cloud Functions export registry.
 *
 * Every deployed function is re-exported from here, one line per function,
 * so `firebase deploy --only functions:getUsage` (etc.) has something to
 * target and the deployed surface is visible in one place rather than
 * scattered across require() calls.
 *
 * firebase-admin is initialized once, here, before any module that touches
 * Firestore/Storage/Tasks (getFunctions(), getStorage()) can safely call
 * them — every other file assumes this has already run.
 */
const { initializeApp } = require('firebase-admin/app');
initializeApp();

const { getUsage } = require('./http/getUsage');
const { createReportJob } = require('./http/createReportJob');
const { getReportStatus } = require('./http/getReportStatus');
const { chat } = require('./http/chat');
const { reportWorker } = require('./tasks/reportWorker');

module.exports = { getUsage, createReportJob, getReportStatus, chat, reportWorker };
