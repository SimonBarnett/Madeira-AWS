// helpers.js
const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");
const sql = require('mssql');
const axios = require('axios');
const winston = require('winston');

// ====================== Logger ======================
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [new winston.transports.Console()],
    defaultMeta: { service: 'posthog-events-lambda' }
});

// ====================== SSM PARAMETER STORE DB CONFIG (NEW) ======================
let dbConfigCache = null;
let dbConfigCacheTime = 0;

async function getDbConfig() {
    const now = Date.now();

    // Use cache if still fresh (30 minutes)
    if (dbConfigCache && (now - dbConfigCacheTime < 1800000)) {
        logger.debug('✅ Using cached DB config from SSM');
        return dbConfigCache;
    }

    logger.info('🔄 Fetching DB config from SSM Parameter Store');

    try {
        const client = new SSMClient({ region: "eu-west-2" });

        const command = new GetParametersCommand({
            Names: [
                '/madeira/db/user',
                '/madeira/db/password',
                '/madeira/db/server',
                '/madeira/db/name'
            ],
            WithDecryption: true
        });

        const response = await client.send(command);

        const config = {};
        response.Parameters.forEach(param => {
            const key = param.Name.split('/').pop(); // user, password, server, name
            config[key] = param.Value;
        });

        // Cache it
        dbConfigCache = config;
        dbConfigCacheTime = now;

        logger.info('✅ DB config successfully loaded from SSM Parameter Store');
        return config;

    } catch (error) {
        logger.error('Failed to fetch DB config from SSM', { error: error.message });
        throw new Error(`SSM Parameter Store failed: ${error.message}`);
    }
}

async function getDbConnection() {
    try {
        const config = await getDbConfig();
        const pool = await sql.connect({
            user: config.user,
            password: config.password,
            server: config.server,
            database: config.name,
            options: {
                encrypt: true,
                trustServerCertificate: true,
                requestTimeout: 300000 // 5 minutes timeout
            }
        });
        logger.debug('Database connection established');
        return pool;
    } catch (error) {
        logger.error('Database connection failed', { error: error.message, stack: error.stack });
        throw new Error(`Database connection failed: ${error.message}`);
    }
}

exports.handler = async (event) => {
    let pool;
    try {
        // Establish database connection using new SSM config
        pool = await getDbConnection();

        // Determine the last run time
        let lastRun;
        const eventsExistResult = await pool.request().query("SELECT TOP 1 1 FROM PostHogEvents");
        if (eventsExistResult.recordset.length === 0) {
            lastRun = '1900-01-01T00:00:00Z'; // Default to 1900 if table is empty
        } else {
            const lastsResult = await pool.request()
                .input('operationName', sql.VarChar, 'FetchPostHogEvents')
                .query("SELECT LastRun FROM LASTS WHERE OperationName = @operationName");
            if (lastsResult.recordset.length === 0) {
                const maxTimestampResult = await pool.request()
                    .query("SELECT MAX(timestamp) as maxTimestamp FROM PostHogEvents");
                lastRun = maxTimestampResult.recordset[0].maxTimestamp.toISOString();
            } else {
                lastRun = lastsResult.recordset[0].LastRun.toISOString();
            }
        }
        logger.info('Determined last run time', { lastRun });

        // Fetch all events from PostHog with pagination
        const postHogEvents = await fetchAllPostHogEvents(lastRun);        
        const filteredEvents = postHogEvents.filter(event => event.properties && event.properties.source);
        logger.info('Fetched events from PostHog', filteredEvents);
        logger.info('Filtered events from PostHog', { count: filteredEvents.length });

        // Collect unique user IDs from source and destination
        const userIds = new Set();
        filteredEvents.forEach(event => {
            if (event.properties?.source) userIds.add(event.properties.source); // Source (referrerTag)
            if (event.properties?.destination) userIds.add(event.properties.destination); // Destination (merchantId)
        });

        // Fetch referrers for the collected user IDs from the Users table
        let referrerMap = {};
        if (userIds.size > 0) {
            const userIdArray = Array.from(userIds);
            const placeholders = userIdArray.map((_, index) => `@userId${index}`).join(',');
            const query = `SELECT user_id, referrer FROM Users WHERE user_id IN (${placeholders})`;
            const request = pool.request();
            userIdArray.forEach((userId, index) => {
                request.input(`userId${index}`, sql.VarChar, userId);
            });
            const result = await request.query(query);
            result.recordset.forEach(row => {
                referrerMap[row.user_id] = row.referrer;
            });
            logger.info('Fetched referrers for user IDs', { userIdCount: userIdArray.length });
        } else {
            logger.info('No user IDs to fetch referrers for');
        }

        // Define the PostHogEvents table structure for bulk insert
        const table = new sql.Table('PostHogEvents');
        table.create = false;
        table.columns.add('eventtype', sql.VarChar(50), { nullable: false });
        table.columns.add('source', sql.VarChar, { nullable: true });
        table.columns.add('source_url', sql.VarChar(255), { nullable: true });
        table.columns.add('destination', sql.VarChar, { nullable: true });
        table.columns.add('destination_url', sql.VarChar(255), { nullable: true });
        table.columns.add('IP', sql.VarChar(45), { nullable: true });
        table.columns.add('source_referrer', sql.VarChar(255), { nullable: true });
        table.columns.add('destination_referrer', sql.VarChar(255), { nullable: true });
        table.columns.add('timestamp', sql.DateTime, { nullable: false });
        table.columns.add('order_id', sql.VarChar(50), { nullable: true });
        table.columns.add('sale_value', sql.Decimal(18, 2), { nullable: true });

        // Populate the table with event data, including referrers and order details
        filteredEvents.forEach(event => {
            const sourceReferrer = event.properties?.source ? referrerMap[event.properties.source] || null : null;
            const destinationReferrer = event.properties?.destination ? referrerMap[event.properties.destination] || null : null;
            const isOrderEvent = event.event === 'order';
            table.rows.add(
                event.event || 'unknown', // eventtype
                event.properties?.source || null, // source (referrerTag)
                event.properties?.source_url || null, // source_url (referrerUrl)
                event.properties?.destination || null, // destination (merchantId)
                event.properties?.destination_url || null, // destination_url (page URL or landing URL)
                event.properties?.ip || event.properties?.$ip || null, // IP
                sourceReferrer, // source_referrer from Users table
                destinationReferrer, // destination_referrer from Users table
                new Date(event.timestamp || new Date()), // timestamp
                isOrderEvent ? event.properties?.order_id || null : null, // order_id
                isOrderEvent ? event.properties?.sale_value || null : null // sale_value
            );
            if (isOrderEvent) {
                logger.debug('Processing order event', {
                    order_id: event.properties?.order_id,
                    sale_value: event.properties?.sale_value
                });
            }
        });

        // Perform bulk insert into PostHogEvents
        if (table.rows.length > 0) {
            await pool.request().bulk(table);
            logger.info('Inserted events into PostHogEvents', { count: table.rows.length });
        } else {
            logger.info('No events to insert');
        }

        // Update the LASTS table with the current time on successful insert
        const currentTime = new Date().toISOString();
        await pool.request()
            .input('currentTime', sql.DateTime, new Date(currentTime))
            .input('operationName', sql.VarChar, 'FetchPostHogEvents')
            .query("MERGE LASTS AS target " +
                   "USING (SELECT @operationName AS OperationName, @currentTime AS LastRun) AS source " +
                   "ON (target.OperationName = source.OperationName) " +
                   "WHEN MATCHED THEN UPDATE SET LastRun = source.LastRun " +
                   "WHEN NOT MATCHED THEN INSERT (OperationName, LastRun) VALUES (source.OperationName, source.LastRun);");
        logger.info('Updated LASTS table', { currentTime });

        return { statusCode: 200, body: 'Events successfully processed' };
    } catch (error) {
        logger.error('Error processing events', { error: error.message, stack: error.stack });
        return { statusCode: 500, body: 'Failed to process events' };
    } finally {
        if (pool) {
            await pool.close();
            logger.info('Database connection closed');
        }
    }
};

/**
 * Fetches all events from PostHog since the last run, handling pagination to retrieve all rows.
 * @param {string} lastRun - ISO timestamp of the last run to fetch events after.
 * @returns {Promise<Array>} - Array of all events fetched from PostHog.
 */
async function fetchAllPostHogEvents(lastRun) {
    try {
        const projectId = process.env.POSTHOG_PROJECT_ID;
        if (!projectId) {
            throw new Error('POSTHOG_PROJECT_ID environment variable is not set');
        }
        let url = `${process.env.POSTHOG_HOST}/api/projects/${projectId}/events?after=${lastRun}`;
        let allEvents = [];
        let pageCount = 0;

        // Loop through all pages until no more 'next' URL is provided
        while (url) {
            logger.info('Fetching page of events', { url });
            const response = await axios.get(url, {
                headers: { 'Authorization': `Bearer ${process.env.POSTHOG_API_KEY}` }
            });
            const events = response.data.results || [];
            allEvents = allEvents.concat(events);
            url = response.data.next; // Update URL to next page or null if no more pages
            pageCount++;
        }

        logger.info('Completed fetching all events', { totalEvents: allEvents.length, pagesFetched: pageCount });
        return allEvents;
    } catch (error) {
        logger.error('PostHog API request failed', { status: error.response?.status, message: error.message });
        throw error;
    }
}