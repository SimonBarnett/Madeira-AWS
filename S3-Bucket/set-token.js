// Self-contained JavaScript widget for setting token in localStorage and redirecting for signup process

// Log storage for debugging
const logs = [];

// Utility function to add log and update log area, also outputs to console
function addLog(message, data = {}) {
    const logEntry = `[SetTokenWidget] ${new Date().toISOString()} - ${message} ${JSON.stringify(data, null, 2)}`;
    logs.push(logEntry);
    if (logs.length > 100) logs.shift(); // Limit to 100 logs
    const logArea = document.getElementById('logArea');
    if (logArea) {
        logArea.textContent = logs.join('\n');
        logArea.scrollTop = logArea.scrollHeight; // Scroll to the bottom
    }
    console.log(logEntry);
}

// Utility function to get query parameter
function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    const value = urlParams.get(param);
    addLog('getQueryParam', { param, value });
    return value;
}

// Main widget class
class SetTokenWidget {
    constructor() {
        this.origin = null;
        this.redirectUrl = null;

        // Bind methods
        this.init = this.init.bind(this);
        this.log = this.log.bind(this);
        this.errorLog = this.errorLog.bind(this);
        this.showRedirectMessage = this.showRedirectMessage.bind(this);
    }

    log(message, data = {}) { addLog(message, data); }
    errorLog(message, data = {}) { addLog(`ERROR: ${message}`, data); }

    // New method to show redirect message and update fallback link
    showRedirectMessage(fullRedirectUrl) {
        const redirectMessage = document.getElementById('redirectMessage');
        const fallbackLink = document.getElementById('fallbackLink');
        if (redirectMessage && fallbackLink) {
            fallbackLink.href = fullRedirectUrl.toString();
            redirectMessage.style.display = 'block';
            this.log('Redirect message displayed', { url: fullRedirectUrl.toString() });
        } else {
            this.errorLog('Redirect message or fallback link element not found');
        }
    }

    async init() {
        this.log('init started', { currentUrl: window.location.href });
        try {
            // Get query parameters
            const token = getQueryParam('authToken');
            const userId = getQueryParam('user_id');
            const contactName = getQueryParam('contact_name');
            const sandbox = getQueryParam('sandbox');
            const lastlogin = getQueryParam('lastlogin');

            this.log('Query parameters retrieved', { token, userId, contactName, sandbox, lastlogin });

            // Validate required parameters
            if (!token || !userId || !contactName) {
                this.errorLog('Missing required query parameters', { token, userId, contactName });
                return;
            }

            // Store in localStorage
            localStorage.setItem('authToken', token);
            localStorage.setItem('user_id', userId);
            localStorage.setItem('contact_name', contactName);
            if (sandbox) {
                localStorage.setItem('sandbox', sandbox);
            }
            if (lastlogin) {
                localStorage.setItem('lastlogin', lastlogin);
            }

            this.log('Stored in localStorage', { token, userId, contactName, sandbox, lastlogin });

            // Determine the origin
            const signupUrl = getQueryParam('signup_url');
            this.origin = signupUrl ? new URL(signupUrl).origin : window.location.origin;
            this.log('Origin determined', { signupUrl, origin: this.origin });

            // Set redirect URL for signup (hardcoded path since invite-only and no config.signupLinkUrl)
            this.redirectUrl = `${this.origin}/signup.html`;
            this.log('Redirect URL set', { redirectUrl: this.redirectUrl });

            // Construct full redirect URL
            const fullRedirectUrl = new URL(this.redirectUrl);
            fullRedirectUrl.searchParams.set('signup', 'ok');
            this.log('Full redirect URL constructed', { 
                url: fullRedirectUrl.toString(),
                protocol: fullRedirectUrl.protocol,
                host: fullRedirectUrl.host,
                pathname: fullRedirectUrl.pathname,
                search: fullRedirectUrl.search
            });

            // Show redirect message with fallback link
            this.showRedirectMessage(fullRedirectUrl);

            // Perform redirect with timeout to allow message visibility
            this.log('Attempting redirect', { url: fullRedirectUrl.toString() });
            setTimeout(() => {
                window.location.href = fullRedirectUrl.toString();
                this.log('Redirect command executed');
            }, 2000); // 2-second delay to show message
        } catch (error) {
            this.errorLog('Error in init', { error: error.message, stack: error.stack });
            const redirectMessage = document.getElementById('redirectMessage');
            if (redirectMessage) {
                redirectMessage.innerHTML = '<p>Error occurred. Please try again or contact support.</p>';
                redirectMessage.style.display = 'block';
            }
        }
    }
}

// Auto-initialize on script load
(async function() {
    addLog('Script initializing');
    const widget = new SetTokenWidget();
    await widget.init();
    addLog('Script initialization complete');
})();