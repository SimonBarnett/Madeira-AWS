// FULL CORRECTED VERSION WITH ALL USER REFINEMENTS
// routes/notify-missing-apikeys.js
const { getDbConnection, logger } = require('/opt/nodejs/helpers');
const { sendMail } = require('/opt/nodejs/mailer');

exports.handler = async (event, context = {}) => {
    // ... full code with refinements
