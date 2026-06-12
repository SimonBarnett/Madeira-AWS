// ====================== routes/ui/chartData.js ======================
const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');

// Define permitted views by role with user-friendly names and clicks-first order
const permittedViews = {
    admin: [
        'Total Clicks for the Network',
        'Referral Clicks for the Network',
        'New User Signups for the Network',
        'Unique Visitors for the Network',
        'User Logins for the Network'
    ],
    merchant: [
        'Product Clicks on my Store',
        'Referral Clicks on my Store',
        'Product Views on my Store'
    ],
    community: [
        'Total Clicks on my Catalog',
        'Referral Clicks on my Catalog',
        'Unique Visitors on my Catalog'
    ],
    partner: [
        'Total Clicks by my Signups',
        'Referral Clicks by my Signups',
        'New User Signups by my Signups',
        'Unique Visitors by my Signups'
    ]
};

module.exports = async (event) => {
    let pool;
    try {
        // Log the entire event object
        logger.debug('Received event', { event });

        const decoded = event.decoded;
        const userId = decoded.user_id;
        const permissions = decoded.permissions || [];
        logger.debug('User details from token', { userId, permissions });

        // Determine user roles
        const roles = permissions.filter(role => ['admin', 'merchant', 'community', 'partner'].includes(role));
        logger.debug('Filtered roles', { roles });
        if (roles.length === 0) {
            logger.warn('No valid roles found for user', { userId, permissions });
            return {
                statusCode: 403,
                body: { message: 'Forbidden: No valid roles' }
            };
        }

        // Get permitted views (cumulative for multiple roles)
        const views = [...new Set(roles.flatMap(role => permittedViews[role] || []))];
        logger.debug('Permitted views for roles', { views });

        // Extract and decode query parameters
        const queryParams = event.queryStringParameters || {};
        const granularity = decodeURIComponent(queryParams.granularity || '').trim().toLowerCase();
        let report_type = decodeURIComponent(queryParams.report_type || '').trim();

        // Default to first permitted view if report_type is blank or invalid
        if (!report_type || !views.includes(report_type)) {
            if (views.length > 0) {
                report_type = views[0];
                logger.info(`report_type invalid or blank, defaulting to first permitted view: ${report_type}`);
            } else {
                logger.warn('No permitted views available', { userId });
                return {
                    statusCode: 403,
                    body: { message: 'Forbidden: No permitted reports available' }
                };
            }
        }

        logger.debug('Decoded query parameters', { granularity, report_type });

        // Validate required parameters
        if (!granularity) {
            logger.warn('Missing required query parameter: granularity', { queryParams });
            return {
                statusCode: 400,
                body: { message: 'Missing required parameter: granularity' }
            };
        }

        // Validate granularity
        const validGranularities = ['day', 'week', 'month'];
        if (!validGranularities.includes(granularity)) {
            logger.warn('Invalid granularity provided', { granularity });
            return {
                statusCode: 400,
                body: { message: `Invalid granularity: ${granularity}. Supported: ${validGranularities.join(', ')}` }
            };
        }

        // Determine date ranges based on granularity
        const today = new Date();
        // Adjust for BST (UTC+1) if database stores timestamps in BST
        const bstOffset = 1 * 60 * 60 * 1000; // 1 hour in milliseconds
        today.setTime(today.getTime() + bstOffset);
        today.setHours(0, 0, 0, 0);

        let periods = {};
        let labels = [];

        if (granularity === 'day') {
            // Current week: Sat (DAY-6) to Today (e.g., Sat)
            const currentWeek = [];
            for (let i = 6; i >= 0; i--) {
                const dayStart = new Date(today);
                dayStart.setDate(today.getDate() - i);
                const dayEnd = new Date(dayStart);
                dayEnd.setHours(23, 59, 59, 999);
                currentWeek.push({ start: dayStart, end: dayEnd });
                labels.push(dayStart.toLocaleDateString('en-US', { weekday: 'short' }));
            }

            // Current-1 week: Sat (DAY-13) to Fri (DAY-7)
            const lastWeek = [];
            for (let i = 13; i >= 7; i--) {
                const dayStart = new Date(today);
                dayStart.setDate(today.getDate() - i);
                const dayEnd = new Date(dayStart);
                dayEnd.setHours(23, 59, 59, 999);
                lastWeek.push({ start: dayStart, end: dayEnd });
            }

            // Current-2 week: Sat (DAY-20) to Fri (DAY-14)
            const twoWeeksAgo = [];
            for (let i = 20; i >= 14; i--) {
                const dayStart = new Date(today);
                dayStart.setDate(today.getDate() - i);
                const dayEnd = new Date(dayStart);
                dayEnd.setHours(23, 59, 59, 999);
                twoWeeksAgo.push({ start: dayStart, end: dayEnd });
            }

            periods = { current: currentWeek, currentMinus1: lastWeek, currentMinus2: twoWeeksAgo };
        } else if (granularity === 'week') {
            // Current 12 weeks
            const currentWeeks = [];
            for (let i = 11; i >= 0; i--) {
                const weekStart = new Date(today);
                weekStart.setDate(today.getDate() - today.getDay() - i * 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekStart.getDate() + 6);
                weekEnd.setHours(23, 59, 59, 999);
                currentWeeks.push({ start: weekStart, end: weekEnd });
                labels.push(`Week ${getWeekNumber(weekStart)}`);
            }

            // Current-1: Previous 12 weeks
            const last12Weeks = [];
            for (let i = 23; i >= 12; i--) {
                const weekStart = new Date(today);
                weekStart.setDate(today.getDate() - today.getDay() - i * 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekStart.getDate() + 6);
                weekEnd.setHours(23, 59, 59, 999);
                last12Weeks.push({ start: weekStart, end: weekEnd });
            }

            // Current-2: 12 weeks before that
            const twoBefore12Weeks = [];
            for (let i = 35; i >= 24; i--) {
                const weekStart = new Date(today);
                weekStart.setDate(today.getDate() - today.getDay() - i * 7);
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekStart.getDate() + 6);
                weekEnd.setHours(23, 59, 59, 999);
                twoBefore12Weeks.push({ start: weekStart, end: weekEnd });
            }

            periods = { current: currentWeeks, currentMinus1: last12Weeks, currentMinus2: twoBefore12Weeks };
        } else if (granularity === 'month') {
            // Current 12 months
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const currentMonths = [];
            for (let i = 11; i >= 0; i--) {
                const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
                monthEnd.setHours(23, 59, 59, 999);
                currentMonths.push({ start: monthStart, end: monthEnd });
                labels.push(monthNames[monthStart.getMonth()]);
            }

            // Current-1: Same months, previous year
            const lastYear = [];
            for (let i = 11; i >= 0; i--) {
                const monthStart = new Date(today.getFullYear() - 1, today.getMonth() - i, 1);
                const monthEnd = new Date(today.getFullYear() - 1, today.getMonth() - i + 1, 0);
                monthEnd.setHours(23, 59, 59, 999);
                lastYear.push({ start: monthStart, end: monthEnd });
            }

            // Current-2: Same months, two years prior
            const twoYearsAgo = [];
            for (let i = 11; i >= 0; i--) {
                const monthStart = new Date(today.getFullYear() - 2, today.getMonth() - i, 1);
                const monthEnd = new Date(today.getFullYear() - 2, today.getMonth() - i + 1, 0);
                monthEnd.setHours(23, 59, 59, 999);
                twoYearsAgo.push({ start: monthStart, end: monthEnd });
            }

            periods = { current: currentMonths, currentMinus1: lastYear, currentMinus2: twoYearsAgo };
        }

        // Connect to the database
        try {
            pool = await getDbConnection();
            logger.info('Database connection established');
        } catch (dbError) {
            logger.error('Database connection failed', { error: dbError.message, stack: dbError.stack });
            throw new Error('Failed to connect to database');
        }

        // Query data for each period
        const queryStart = Date.now();
        const currentData = await Promise.all(periods.current.map(async (period, index) => {
            const start = Date.now();
            const result = await queryDatabase(pool, report_type, userId, period.start, period.end, granularity);
            logger.debug('Current period query', { index, start: period.start.toISOString(), end: period.end.toISOString(), userId, duration: Date.now() - start, result });
            return result;
        }));
        const currentMinus1Data = await Promise.all(periods.currentMinus1.map(async (period, index) => {
            const start = Date.now();
            const result = await queryDatabase(pool, report_type, userId, period.start, period.end, granularity);
            logger.debug('Current-1 period query', { index, start: period.start.toISOString(), end: period.end.toISOString(), userId, duration: Date.now() - start, result });
            return result;
        }));
        const currentMinus2Data = await Promise.all(periods.currentMinus2.map(async (period, index) => {
            const start = Date.now();
            const result = await queryDatabase(pool, report_type, userId, period.start, period.end, granularity);
            logger.debug('Current-2 period query', { index, start: period.start.toISOString(), end: period.end.toISOString(), userId, duration: Date.now() - start, result });
            return result;
        }));
        logger.debug('Database query results', { currentData, currentMinus1Data, currentMinus2Data, totalDuration: Date.now() - queryStart });

        // Aggregate data
        const currentCounts = currentData.map(result => result[0]?.count || 0);
        const currentMinus1Counts = currentMinus1Data.map(result => result[0]?.count || 0);
        const currentMinus2Counts = currentMinus2Data.map(result => result[0]?.count || 0);

        // Construct response
        const response = {
            permittedViews: views,
            chartData: {
                labels,
                datasets: [
                    {
                        label: 'Current',
                        data: currentCounts,
                        backgroundColor: '#007bff',
                        borderColor: '#007bff',
                        borderWidth: 1
                    },
                    {
                        label: 'Current-1',
                        data: currentMinus1Counts,
                        backgroundColor: '#c0c0c0',
                        borderColor: '#c0c0c0',
                        borderWidth: 1
                    },
                    {
                        label: 'Current-2',
                        data: currentMinus2Counts,
                        backgroundColor: '#d3d3d3',
                        borderWidth: 1
                    }
                ]
            }
        };

        logger.info('Response generated successfully', { response });
        return {
            statusCode: 200,
            body: response
        };
    } catch (error) {
        logger.error('Error retrieving chart data', { error: error.message, stack: error.stack });
        return {
            statusCode: error.message.includes('Unauthorized') ? 401 : 
                error.message.includes('Forbidden') ? 403 : 500,
            body: { message: error.message || 'Internal server error' }
        };
    } finally {
        if (pool) {
            try {
                await pool.close();
                logger.debug('Database connection closed');
            } catch (closeError) {
                logger.error('Error closing database connection', { error: closeError.message });
            }
        }
    }
};

// ====================== HELPER FUNCTIONS ======================

/** Query the database based on report type for a specific period */
async function queryDatabase(pool, reportType, userId, start, end, granularity) {
    let query;
    switch (reportType) {
        case 'Total Clicks on my Catalog':
            query = `SELECT COUNT(*) as count FROM DatabaseCallLog WHERE UserId = @userId AND Timestamp BETWEEN @start AND @end`;
            break;
        case 'Referral Clicks on my Catalog':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'click' AND source = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Unique Visitors on my Catalog':
            query = `SELECT COUNT(DISTINCT RemoteIP) as count FROM DatabaseCallLog WHERE UserId = @userId AND Timestamp BETWEEN @start AND @end`;
            break;
        case 'Product Clicks on my Store':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'click' AND destination = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Referral Clicks on my Store':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'click' AND destination = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Product Views on my Store':
            query = `SELECT COUNT(DISTINCT IP) as count FROM PostHogEvents WHERE eventtype = 'view' AND destination = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Total Clicks by my Signups':
            query = `SELECT COUNT(*) as count FROM DatabaseCallLog WHERE UserId IN (SELECT user_id FROM Users WHERE referrer = @userId) AND Timestamp BETWEEN @start AND @end`;
            break;
        case 'Referral Clicks by my Signups':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'click' AND source_referrer = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'New User Signups by my Signups':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'signup' AND source_referrer = @userId AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Unique Visitors by my Signups':
            query = `SELECT COUNT(DISTINCT RemoteIP) as count FROM DatabaseCallLog WHERE UserId IN (SELECT user_id FROM Users WHERE referrer = @userId) AND Timestamp BETWEEN @start AND @end`;
            break;
        case 'Total Clicks for the Network':
            query = `SELECT COUNT(*) as count FROM DatabaseCallLog WHERE Timestamp BETWEEN @start AND @end`;
            break;
        case 'Referral Clicks for the Network':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'click' AND timestamp BETWEEN @start AND @end`;
            break;
        case 'New User Signups for the Network':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'signup' AND timestamp BETWEEN @start AND @end`;
            break;
        case 'Unique Visitors for the Network':
            query = `SELECT COUNT(DISTINCT RemoteIP) as count FROM DatabaseCallLog WHERE Timestamp BETWEEN @start AND @end`;
            break;
        case 'User Logins for the Network':
            query = `SELECT COUNT(*) as count FROM PostHogEvents WHERE eventtype = 'login' AND timestamp BETWEEN @start AND @end`;
            break;
        default:
            throw new Error('Invalid report type');
    }

    try {
        const result = await pool.request()
            .input('start', sql.DateTime, start)
            .input('end', sql.DateTime, end)
            .input('userId', sql.VarChar, userId)
            .query(query);
        logger.debug('Query executed', { query, start: start.toISOString(), end: end.toISOString(), userId, count: result.recordset[0]?.count || 0 });
        return result.recordset;
    } catch (queryError) {
        logger.error('Database query error', { query, error: queryError.message, start: start.toISOString(), end: end.toISOString(), userId });
        throw new Error(`Database query failed: ${queryError.message}`);
    }
}

/** Get ISO week number (1-53) for a date, handling year transitions */
function getWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return weekNum;
}