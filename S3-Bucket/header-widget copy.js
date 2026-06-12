// header-widget.js
// Self-contained JavaScript widget for header navigation
// Compatible with AWS Lambda authentication API
// Includes FontAwesome for icons, PWA support, and SVG sprite injection

// Load Font Awesome if not already loaded
if (!document.querySelector('link[href*="font-awesome"]')) {
    const faLink = document.createElement('link');
    faLink.rel = 'stylesheet';
    faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css';
    document.head.appendChild(faLink);
}

// Utility Functions
function decodeToken(token) {
    try {
        const payload = token.split('.')[1];
        const decoded = atob(payload);
        return JSON.parse(decoded);
    } catch (e) {
        console.error('Failed to decode token:', e.message);
        return null;
    }
}

function isTokenValid(token) {
    if (!token) {
        console.log('No token provided for validation');
        return false;
    }
    const decoded = decodeToken(token);
    if (!decoded || !decoded.exp) {
        console.log('Invalid token or no expiration:', decoded);
        return false;
    }
    const currentTime = Math.floor(Date.now() / 1000);
    const isValid = decoded.exp > currentTime;
    console.log('Token validity check:', { isValid, expiresAt: decoded.exp, currentTime });
    return isValid;
}

// Overlay Management
const overlay = document.createElement('div');
overlay.id = 'loadingOverlay';
overlay.style.position = 'fixed';
overlay.style.top = '0';
overlay.style.left = '0';
overlay.style.width = '100vw';
overlay.style.height = '100vh';
overlay.style.background = 'rgba(255, 255, 255, 0.8)';
overlay.style.display = 'flex';
overlay.style.justifyContent = 'center';
overlay.style.alignItems = 'center';
overlay.style.zIndex = '9999';
overlay.innerHTML = `
    <div style="position: relative; width: 200px; height: 200px;">
        <div style="position: absolute; border-radius: 50%; border: 8px solid transparent; animation: spin 1.5s linear infinite; width: 80px; height: 80px; border-top-color: #ff6f61; top: 60px; left: 60px; animation-delay: 0s;"></div>
        <div style="position: absolute; border-radius: 50%; border: 8px solid transparent; animation: spin 1.5s linear infinite; width: 60px; height: 60px; border-top-color: #6bff61; top: 70px; left: 70px; animation-delay: 0.3s;"></div>
        <div style="position: absolute; border-radius: 50%; border: 8px solid transparent; animation: spin 1.5s linear infinite; width: 40px; height: 40px; border-top-color: #61cfff; top: 80px; left: 80px; animation-delay: 0.6s;"></div>
        <div style="position: absolute; border-radius: 50%; border: 8px solid transparent; animation: spin 1.5s linear infinite; width: 20px; height: 20px; border-top-color: #ff61ff; top: 90px; left: 90px; animation-delay: 0.9s;"></div>
    </div>
`;

if (document.body) {
    document.body.appendChild(overlay);
} else {
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
}

// Wait for Font Awesome to Load
function loadFontAwesome() {
    return new Promise((resolve, reject) => {
        const faLink = document.querySelector('link[href*="font-awesome"]');
        if (faLink && faLink.sheet) resolve();
        else if (faLink) {
            faLink.onload = resolve;
            faLink.onerror = reject;
        } else reject(new Error('Font Awesome link not found'));
    });
}

// Wait for DOM and Resources
const domReady = new Promise(resolve => {
    if (document.readyState === 'complete' || document.readyState === 'interactive') resolve();
    else document.addEventListener('DOMContentLoaded', resolve);
});

const windowLoad = new Promise(resolve => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
});

// Hide Overlay and Update Header
Promise.all([domReady, loadFontAwesome(), document.fonts.ready, windowLoad]).then(() => {
    console.log('All resources loaded, preparing to update header');
    const updateHeader = () => {
        if (window.headerElement) {
            console.log('Header element found');
            requestAnimationFrame(() => {
                setTimeout(() => {
                    overlay.style.display = 'none';
                    const computedStyle = getComputedStyle(window.headerElement);
                    console.log('Computed background-color:', computedStyle.backgroundColor);
                }, 300);
            });
        } else {
            console.log('Header element not found, retrying...');
            setTimeout(updateHeader, 100);
        }
    };
    updateHeader();
}).catch(error => {
    console.error('Error loading resources:', error);
    overlay.style.display = 'none';
    if (window.headerElement) {
        const computedStyle = getComputedStyle(window.headerElement);
        console.log('Computed background-color (error fallback):', computedStyle.backgroundColor);
    }
});

// HeaderWidget Class
class HeaderWidget {
    constructor(element) {
        this.element = element;
        this.pageName = element.dataset.pageName || 'Dashboard';
        const requireTokenAttr = element.getAttribute('data-requireToken');
        this.requireToken = requireTokenAttr && requireTokenAttr.trim().toLowerCase() === 'true';
        console.log('data-requireToken raw value:', requireTokenAttr);
        console.log('data-requireToken trimmed:', requireTokenAttr ? requireTokenAttr.trim() : null);
        console.log('requireToken parsed as:', this.requireToken);

        this.menuItems = [
            { name: 'Home', icon: 'fas fa-home', href: '/index.html', roles: [] },
            { name: 'Login', icon: 'fas fa-sign-in-alt', href: '/login.html', roles: ['notoken'] },            
            { name: 'Dashboard', icon: 'fas fa-chart-bar', href: '/dashboard.html', roles: ['self'] },
            { name: 'Account', icon: 'fas fa-user-gear', href: '/delegate.html', roles: ['community'] },
            { name: 'Affiliate AI', icon: 'fas fa-robot', href: '/category.html', roles: ['community'] },
            { name: 'Catalog', icon: 'fas fa-layer-group', href: '/catalog.html', roles: ['community'] },
            { name: 'API Keys', icon: 'fas fa-key', href: '/apikey.html', roles: ['self'] },
            { name: 'My Parts', icon: 'fas fa-box-open', href: '/parts.html', roles: ['merchant'] },                        
            { name: 'Partner', icon: 'fas fa-handshake', href: '/partner.html', roles: ['partner','admin'] },            
            { name: 'Install App', icon: 'fas fa-mobile-alt', action: 'install', roles: [] },
            { name: 'Logout', icon: 'fas fa-sign-out-alt', href: '/login.html', roles: ['self'] }
        ];
        const currentPath = window.location.pathname;
        const currentPage = currentPath.split('/').pop();
        this.currentMenuItem = this.menuItems.find(item => item.href && item.href.split('/').pop() === currentPage);
        this.logoIcon = element.dataset.icon || (this.currentMenuItem ? this.currentMenuItem.icon : 'fas fa-home');
        this.installPromptEvent = null;

        this.addPwaMetaTags();
        this.registerServiceWorker();
        this.setupInstallPrompt();
        this.injectStyles();
        this.init();
    }

    injectStyles() {
        if (!document.getElementById('header-widget-styles')) {
            const style = document.createElement('style');
            style.id = 'header-widget-styles';
            style.innerHTML = `
/* Define spin animation for overlay */
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

/* Basic styles */
* {
    box-sizing: border-box; /* Ensure padding/margins don’t inflate elements */
}

body {
    font-family: Arial, sans-serif;
    margin: 0;
    padding: 0;
    line-height: 1.5; /* Default line-height for consistency */
}

/* Header styles */
header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background-color: #333; /* Dark background */
    color: white;
    padding: 0.5rem 1rem; /* Minimal padding */
    display: flex;
    align-items: center;
    justify-content: space-between;
}

/* Navigation container */
nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
}

/* Logo styling */
.logo {
    display: flex;
    align-items: center;
    font-size: 1.5rem;
    margin: 0;
}

.logo i {
    font-size: 2em;
    margin-right: 10px;
    color: white; /* White to match dark background */
}

.logo-text {
    display: inline-block;
    color: white; /* White to match dark background */
}

/* Menu group */
.menu-group {
    display: flex;
    align-items: center;
    justify-content: flex-end; /* Right-align menu items */
}

/* Menu list */
.menu-list {
    list-style: none;
    display: flex;
    margin: 0;
    padding: 0;
}

/* Menu items */
.menu-item {
    margin-left: 20px;
}

.menu-link {
    color: white; /* White to match dark background */
    text-decoration: none;
    display: flex;
    align-items: center;
}

.menu-link:hover {
    color: #66b3ff; /* Light blue on hover for consistency with selected state */
}

.menu-link:hover .menu-icon {
    transform: scale(1.1); /* 10% size increase on hover */
    transition: transform 0.2s ease-in-out;
}

.menu-icon {
    font-size: 1.5em;
    margin-left: 10px;
}

.menu-text {
    display: none;
}

/* Hamburger */
.hamburger {
    display: none;
    font-size: 2em;
    cursor: pointer;
    color: white; /* White to match dark background */
}

.hamburger:hover {
    color: #66b3ff; /* Match menu-link hover color */
}

/* Hint styling */
.menu-hint {
    position: absolute;
    display: flex;
    align-items: center;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 5px 10px;
    border-radius: 3px;
    visibility: hidden;
    top: 100%; /* Position below the menu item */
    z-index: 1001; /* Above other elements */
}

.menu-hint.visible {
    visibility: visible;
}

.menu-hint .click-icon {
    margin-right: 5px;
    order: -1;
    font-size: 1.2em; /* Adjust size if needed */
}

.menu-hint .menu-name {
    white-space: nowrap;
}

/* Styling for selected menu item */
.menu-item.selected .menu-link {
    color: #66b3ff; /* Quite a bit lighter than #007bff */
}

/* Responsive design for smaller screens */
@media (max-width: 768px) {
    .menu-list {
        display: none;
        flex-direction: column;
        position: absolute;
        top: 100%;
        right: 0;
        width: 200px;
        background-color: #333;
        padding-right: 10px; /* Ensures content is inset 10px from screen's right edge */
    }
    .menu-list.show {
        display: flex;
    }
    .menu-item {
        margin: 5px 0; /* Reduced from 10px to 5px to decrease vertical gap by 50% */
    }
    .menu-link {
        justify-content: flex-end;
        width: 100%;
        color: white; /* White for visibility on dark background */
        padding: 10px; /* Updated for larger touch area */
    }
    .menu-text {
        display: inline;
        color: white; /* White for visibility */
        font-size: 1.25em; /* Increased by 0.25em for fat fingers */
    }
    .menu-icon {
        font-size: 1.75em; /* Increased by 0.25em from 1.5em for fat fingers */
        margin-left: 10px;
        margin-right: 10px; /* Added to create a 10px gap from the right edge */
    }
    .hamburger {
        display: block;
        margin-left: 10px;
        margin-right: 10px; /* 10px margin to the right */
    }
}

@media (min-width: 769px) {
    .menu-list {
        margin-right: 20px;
    }
    .hamburger {
        display: none;
        margin-left: 0;
        margin-right: 0;
    }
}

/* Welcome section styles for image and text wrapping */
.welcome {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
}

.welcome h1 {
    font-size: 2em;
    margin-bottom: 1em;
}

.welcome img {
    float: left;
    width: 192px;
    height: 192px;
    margin: 0 20px 20px 0;
    border-radius: 8px; /* Optional: softens image corners */
}

.welcome p {
    line-height: 1.6;
    margin-bottom: 1em;
}

/* Clearfix to prevent layout issues from floating image */
.welcome::after {
    content: "";
    display: table;
    clear: both;
}

/* Responsive adjustment for welcome section */
@media (max-width: 600px) {
    .welcome img {
        float: none;
        display: block;
        margin: 0 auto 20px;
        width: 150px;
        height: 150px;
    }
}

/* Additional styles */
main {
    padding: 2rem;
    padding-bottom: 100px; /* Ensures content isn’t hidden by the fixed footer */
    margin-top: 60px; /* Keeps space for the fixed header */
}

footer {
    background-color: #333;
    color: white;
    text-align: left; /* Align content to the left edge */
    padding: 0.25rem 0; /* Vertical padding only, no horizontal padding */
    position: fixed;
    bottom: 0;
    width: 100%;
    font-size: 0.75rem; /* ~12px for text and icon sizing */
    line-height: 1.2; /* Tight line-height to minimize height */
}

footer p {
    margin: 0; /* Remove default paragraph margins */
    display: flex;
    align-items: center;
    gap: 0.5rem; /* Space between links */
    padding-left: 1rem; /* Optional: slight indent for content, adjust as needed */
}

footer a {
    color: white; /* Ensure links are white */
    text-decoration: none; /* Remove underline */
}

footer a:hover {
    color: #66b3ff; /* Match header’s hover/selected color */
}

footer i, footer img.custom-icon {
    width: 1em; /* ~12px based on footer’s font-size */
    height: 1em;
    vertical-align: middle; /* Align with text */
    max-width: 1em; /* Prevent scaling beyond 12px */
    max-height: 1em;
    object-fit: contain; /* Ensure SVG fits within bounds */
    display: inline-block; /* Ensure proper inline behavior */
}

/* Ensure no external styles affect images */
footer img.custom-icon {
    image-rendering: auto; /* Prevent pixelation */
}

/* Styles for provider icons in the API keys widget */
#api-keys-wrapper .provider-icon {
    font-size: 48px;
    color: #007bff;
    margin-right: 5px;
    display: inline-block;
    vertical-align: middle;
}

#api-keys-wrapper .provider-icon svg {
    width: 1em;
    height: 1em;
    fill: currentColor;
}

/* Styles for provider radio icons */
#settings-methods .provider-radio-icon {
    font-size: 48px;
    color: #6c757d;
    cursor: pointer;
    transition: color 0.2s ease;
    display: inline-block;
    vertical-align: middle;
}

#settings-methods .provider-radio-icon svg {
    width: 1em;
    height: 1em;
    fill: currentColor;
}

#settings-methods input[type="radio"]:checked + .provider-radio-icon {
    color: #007bff;
}

#settings-methods .provider-radio-icon:hover {
    color: #007bff;
}

/* Custom icon adjustments (if needed) */
.custom-icon {
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: middle;
}

.custom-icon svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
}

/* Ensure custom icons in footer are styled correctly */
footer .custom-icon {
    width: 1em;
    height: 1em;
    vertical-align: middle;
}

footer .custom-icon svg {
    width: 100%;
    height: 100%;
    fill: currentColor;
}
            `;
            document.head.appendChild(style);
            console.log('Header widget styles injected');
        } else {
            console.log('Header widget styles already exist');
        }
    }

    addPwaMetaTags() {
        console.log('Adding PWA meta tags');
        if (!document.querySelector('link[rel="manifest"]')) {
            const manifestLink = document.createElement('link');
            manifestLink.rel = 'manifest';
            manifestLink.href = '/manifest.json';
            document.head.appendChild(manifestLink);
        }
        if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
            const metaAppleCapable = document.createElement('meta');
            metaAppleCapable.name = 'mobile-web-app-capable';
            metaAppleCapable.content = 'yes';
            document.head.appendChild(metaAppleCapable);
        }
        if (!document.querySelector('meta[name="mobile-web-app-status-bar-style"]')) {
            const metaAppleStatus = document.createElement('meta');
            metaAppleStatus.name = 'apple-mobile-web-app-status-bar-style';
            metaAppleStatus.content = 'black';
            document.head.appendChild(metaAppleStatus);
        }
        if (!document.querySelector('link[rel="apple-touch-icon"]')) {
            const appleIconLink = document.createElement('link');
            appleIconLink.rel = 'apple-touch-icon';
            appleIconLink.href = 'https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/icon-192.png';
            document.head.appendChild(appleIconLink);
        }
        if (!document.querySelector('meta[name="theme-color"]')) {
            const metaTheme = document.createElement('meta');
            metaTheme.name = 'theme-color';
            metaTheme.content = '#000000';
            document.head.appendChild(metaTheme);
        }
    }

    registerServiceWorker() {
        console.log('Registering service worker');
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js')
                .then(reg => console.log('Service Worker registered:', reg))
                .catch(err => console.error('Service Worker registration failed:', err));
        } else {
            console.warn('Service Worker not supported in this browser');
        }
    }

    setupInstallPrompt() {
        console.log('Setting up install prompt listeners');
        window.addEventListener('beforeinstallprompt', (e) => {
            console.log('beforeinstallprompt event fired');
            e.preventDefault();
            this.installPromptEvent = e;
        });

        window.addEventListener('appinstalled', () => {
            console.log('App was installed');
            this.installPromptEvent = null;
            const installItem = this.element.querySelector('.install-item');
            if (installItem) {
                installItem.style.display = 'none';
            }
        });
    }

    injectSvgSprite() {
        if (!document.getElementById('custom-icons-sprite')) {
            const sprite = document.createElement('svg');
            sprite.id = 'custom-icons-sprite';
            sprite.style.display = 'none';
            sprite.setAttribute('aria-hidden', 'true');
            sprite.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            sprite.innerHTML = `
                <symbol id="magento-icon" viewBox="-2 0 24 24">
                    <path fill="currentColor" d="m17.7 19.368v-11.568l-7.5-4.632-7.5 4.632v11.568l-2.7-1.668v-11.4l10.2-6.3 10.2 6.3v11.4zm-9 1.306 1.5.926 1.5-.926v-13.412l3.3 2.038v11.735l-4.8 2.965-4.8-2.965v-11.735l3.3-2.038z"/>
                    <path fill="currentColor" d="m17.7 7.8-7.5-4.632-7.5 4.632v.009l-2.7-1.509 10.2-6.3 10.2 6.3-2.7 1.509zm-2.7 1.52-3.3 1.844v-3.902l3.3 2.038zm-6.3 1.844-3.3-1.846v-.018l3.3-2.038z"/>
                </symbol>
                <symbol id="bigcommerce-icon" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M12.645 13.663h3.027c.861 0 1.406-.474 1.406-1.235 0-.717-.545-1.234-1.406-1.234h-3.027c-.1 0-.187.086-.187.172v2.125c.015.1.086.172.187.172zm0 4.896h3.128c.961 0 1.535-.488 1.535-1.35 0-.746-.545-1.35-1.535-1.35h-3.128c-.1 0-.187.087-.187.173v2.34c.015.115.086.187.187.187zM23.72.053l-8.953 8.93h1.464c2.281 0 3.63 1.435 3.63 3 0 1.235-.832 2.14-1.722 2.541-.143.058-.143.259.014.316 1.033.402 1.765 1.48 1.765 2.742 0 1.78-1.19 3.202-3.5 3.202h-6.342c-.1 0-.187-.086-.187-.172V13.85L.062 23.64c-.13.13-.043.359.143.359h23.631a.16.16 0 0 0 .158-.158V.182c.043-.158-.158-.244-.273-.13z"/>
                </symbol>
                <!-- Add more symbols as needed -->
            `;
            document.body.appendChild(sprite);
            console.log('SVG sprite injected');
        } else {
            console.log('SVG sprite already exists');
        }
    }

    async init() {
        console.log('Initializing HeaderWidget');
        console.log('requireToken:', this.requireToken);

        // Inject the SVG sprite
        this.injectSvgSprite();

        // Fetch configuration from index.json
        let config = {
            loginUrl: '/login.html', // Default fallback
            affiliateCode: '' // Default fallback
        };
        try {
            console.log('Fetching config from /index.json');
            const configResponse = await fetch('/index.json');
            if (!configResponse.ok) {
                throw new Error(`Failed to fetch index.json: ${configResponse.status} ${configResponse.statusText}`);
            }
            config = await configResponse.json();
            console.log('Config loaded:', config);
        } catch (error) {
            console.error('Error fetching index.json, using defaults:', error.message);
        }

        this.loginUrl = config.loginUrl || '/login.html';
        this.affiliateCode = config.affiliateCode || '';
        console.log('Login URL:', this.loginUrl);
        console.log('Affiliate Code:', this.affiliateCode);

        // Retrieve token from localStorage
        const token = localStorage.getItem('authToken');
        console.log('Auth token:', token ? 'Present' : 'Absent');

        if (token && isTokenValid(token)) {
            this.isAuthenticated = true;
            console.log('Valid token found, fetching user roles');
            try {
                console.log('Fetching authenticated claims from https://ytepcnwske.execute-api.eu-west-2.amazonaws.com/prod/login/claims');
                const response = await fetch('https://ytepcnwske.execute-api.eu-west-2.amazonaws.com/prod/login/claims', {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Failed to fetch claims: ${response.status} ${response.statusText} - ${errorText}`);
                }
                const rolesData = await response.json();
                this.userRoles = rolesData.roles || [];
                console.log('User roles:', this.userRoles);
            } catch (error) {
                console.error('Error fetching claims:', error.message, error.stack);
                this.userRoles = [];
                if (this.requireToken) {
                    console.log('requireToken is true and claims fetch failed, redirecting to login');
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('user_id');
                    localStorage.removeItem('contact_name');
                    window.location.href = this.loginUrl;
                    return;
                }
            }
        } else {
            this.isAuthenticated = false;
            this.userRoles = ['notoken'];
            if (this.requireToken) {
                console.log('requireToken is true and no valid token, redirecting to login');
                localStorage.removeItem('authToken');
                localStorage.removeItem('user_id');
                localStorage.removeItem('contact_name');
                window.location.href = this.loginUrl;
                return;
            }
        }

        // Update Affiliate AI menu item with affiliateCode
        this.menuItems = this.menuItems.map(item => {
            if (item.name === 'Affiliate AI') {
                return {
                    ...item,
                    href: `/category.html`
                };
            }
            return item;
        });

        this.render();
    }

    render() {
        console.log('Rendering header');
        const currentPath = window.location.pathname;
        const menuHTML = this.menuItems
            .filter(item => {
                if (item.roles.length === 0) return true;
                if (item.roles.includes('notoken')) return !this.isAuthenticated;
                if (item.roles.includes('self')) return this.isAuthenticated;
                return this.isAuthenticated && item.roles.some(role => this.userRoles.includes(role));
            })
            .map(item => {
                if (item.action === 'install') {
                    return `<li class="menu-item install-item"><a href="#" class="menu-link" data-name="${item.name}"><span class="menu-text">${item.name}</span><i class="${item.icon} menu-icon"></i></a></li>`;
                }
                const isSelected = item.href.split('?')[0] === currentPath;
                return `<li class="menu-item${isSelected ? ' selected' : ''}"><a href="${item.href}" class="menu-link" data-name="${item.name}"><span class="menu-text">${item.name}</span><i class="${item.icon} menu-icon"></i></a></li>`;
            })
            .join('');

        const headerHTML = `
            <header>
                <nav>
                    <div class="logo">
                        <i class="${this.logoIcon}"></i>
                        <span class="logo-text">${this.pageName}</span>
                    </div>
                    <div class="menu-group">
                        <ul class="menu-list">${menuHTML}</ul>
                        <i class="fas fa-bars hamburger"></i>
                    </div>
                    <div class="menu-hint">
                        <i class="fas fa-hand-pointer click-icon"></i>
                        <span class="menu-name"></span>
                    </div>
                </nav>
            </header>
        `;

        this.element.innerHTML = headerHTML;
        this.header = this.element.querySelector('header');
        window.headerElement = this.header;

        const menuHint = this.element.querySelector('.menu-hint');
        const menuItems = this.element.querySelectorAll('.menu-item');
        const hamburger = this.element.querySelector('.hamburger');
        const menuList = this.element.querySelector('.menu-list');
        const nav = this.element.querySelector('nav');

        if (!nav) {
            console.error('Nav element not found');
            return;
        }

        hamburger.addEventListener('click', () => {
            menuList.classList.toggle('show');
        });

        menuItems.forEach(item => {
            const link = item.querySelector('.menu-link');
            const name = link.dataset.name;

            if (name === 'Install App') {
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    console.log('Install App clicked, installPromptEvent:', this.installPromptEvent);
                    if (this.installPromptEvent) {
                        console.log('Triggering install prompt');
                        this.installPromptEvent.prompt();
                        this.installPromptEvent.userChoice.then((choiceResult) => {
                            console.log('User choice:', choiceResult.outcome);
                            if (choiceResult.outcome === 'accepted') {
                                console.log('User accepted the install prompt');
                            } else {
                                console.log('User dismissed the install prompt');
                            }
                            this.installPromptEvent = null;
                        });
                    } else {
                        console.log('Install prompt not available');
                        if (navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad')) {
                            alert('To install this app, tap the Share icon in your browser and select "Add to Home Screen".');
                        } else {
                            alert('Installation is not supported on this browser or the app is already installed.');
                        }
                    }
                });
            } else if (link.href && link.href !== '#') {
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    console.log(`Navigating to ${link.href}`);
                    overlay.style.display = 'flex';
                    requestAnimationFrame(() => {
                        window.location.href = link.href;
                    });
                });
            }

            link.addEventListener('mouseenter', (event) => {
                menuHint.querySelector('.menu-name').textContent = name;
                menuHint.classList.add('visible');
                const menuRect = menuList.getBoundingClientRect();
                const navRect = nav.getBoundingClientRect();
                const topOffset = menuRect.bottom - navRect.top + 5;
                menuHint.style.top = `${topOffset}px`;
                const mouseX = event.pageX;
                const navLeft = navRect.left;
                const hintWidth = menuHint.offsetWidth;
                menuHint.style.left = `${mouseX - navLeft - hintWidth}px`;
            });

            link.addEventListener('mousemove', (moveEvent) => {
                const navRect = nav.getBoundingClientRect();
                const mouseX = moveEvent.pageX;
                const navLeft = navRect.left;
                const hintWidth = menuHint.offsetWidth;
                menuHint.style.left = `${mouseX - navLeft - hintWidth}px`;
            });

            link.addEventListener('mouseleave', () => {
                menuHint.querySelector('.menu-name').textContent = '';
                menuHint.classList.remove('visible');
            });
        });

        const logoutLink = this.element.querySelector('a[data-name="Logout"]');
        if (logoutLink) {
            logoutLink.addEventListener('click', (event) => {
                event.preventDefault();
                console.log('Logout clicked');
                localStorage.removeItem('authToken');
                localStorage.removeItem('user_id');
                localStorage.removeItem('contact_name');
                overlay.style.display = 'flex';
                requestAnimationFrame(() => {
                    window.location.href = this.loginUrl;
                });
            });
        }
    }
}

// Initialize Widgets on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM content loaded, initializing widgets');
    document.querySelectorAll('[data-header-widget]').forEach(element => {
        new HeaderWidget(element);
    });
});