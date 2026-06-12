// dashboard-widget.js
// Self-contained JavaScript widget for dashboard with navigation and dynamic content
// Compatible with AWS Lambda authentication API
// Includes FontAwesome for icons and shadow DOM for encapsulation

(function () {
  // Utility function to decode JWT token
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

  // Utility function to validate token expiration
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

  // Widget initialization function
  function initDashboardWidget() {
    // Find the container based on data-container-id
    const scriptTag = document.querySelector('script[data-dashboard-widget]');
    if (!scriptTag) {
      console.error('Dashboard Widget: No script tag with data-dashboard-widget found');
      return;
    }

    const containerId = scriptTag.getAttribute('data-container-id');
    const container = document.getElementById(containerId);
    if (!container) {
      console.error(`Dashboard Widget: No container found with ID "${containerId}"`);
      return;
    }

    // Check for authentication token
    const token = localStorage.getItem('authToken');
    console.log('Auth token:', token ? 'Present' : 'Absent');
    let userRoles = [];

    if (!token || !isTokenValid(token)) {
      console.log('No valid token found, redirecting to /login.html');
      window.location.href = '/login.html';
      return;
    }

    // Fetch user claims to get roles
    fetch('https://ytepcnwske.execute-api.eu-west-2.amazonaws.com/prod/login/claims', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch claims: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then(data => {
        userRoles = data.roles || [];
        console.log('User roles fetched:', userRoles);
        renderDashboard();
      })
      .catch(error => {
        console.error('Error fetching claims:', error.message);
        localStorage.removeItem('authToken');
        localStorage.removeItem('user_id');
        localStorage.removeItem('contact_name');
        window.location.href = '/login.html';
      });

    // Function to render the dashboard
    function renderDashboard() {
      // Clear container to prevent duplicate content
      container.innerHTML = '';

      // Create shadow DOM to encapsulate styles and content
      const shadow = container.attachShadow({ mode: 'open' });

      // Get contact_name and lastlogin from localStorage
      const contactName = localStorage.getItem('contact_name') || 'User';
      const lastLogin = localStorage.getItem('lastlogin');
      
      // Determine welcome message and additional text based on lastlogin
      const welcomeMessage = lastLogin ? `Welcome back, ${contactName}!` : `Welcome to your new dashboard, ${contactName}!`;
      const additionalText = lastLogin ? lastLogin : "This is your first login.";

      // Create a wrapper div for the dashboard content
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
        <!-- Header with navigation -->
        <header>
          <nav>
            <div class="logo">Dashboard</div>
            <ul>
              <li><a href="#Home"><i class="fas fa-chart-bar"></i>Home</a></li>
              <li><a href="#ApiKeys"><i class="fas fa-key"></i>API Keys</a></li>
              <li><a href="#categoryAi"><i class="fas fa-robot"></i>AI Categories</a></li>
              <li><a href="#" class="logout"><i class="fas fa-sign-out-alt"></i>Logout</a></li>
            </ul>
          </nav>
        </header>

        <!-- Main content area -->
        <main>
          <div id="Login" style="display: none;">
            <section class="login">
              <div id="login-widget"></div>
            </section>
          </div>
          <div id="Home">
            <section class="welcome">
              <h1>${welcomeMessage}</h1>
              <p>${additionalText}</p>
              <p>Here's an overview of your account.</p>
            </section>
            <section class="stats">
              <div class="card">Stat 1: 100</div>
              <div class="card">Stat 2: 200</div>
              <div class="card">Stat 3: 300</div>
            </section>
            <section class="chart">
              <h2>Performance Charts</h2>
              <!-- Placeholder for a chart -->
              <div id="madeira-charts"></div>
            </section>
          </div>
          <div id="ApiKeys">
            <section class="api-keys">
              <!-- Container for the widget -->
              <div id="api-keys-container"></div>
            </section>
          </div>
          <div id="categoryAi">
            <section class="ai-categories">
              <div id="categories-widget"></div>
            </section>
          </div>
        </main>

        <!-- Footer -->
        <footer>
          <p>© 2025 Dashboard Widget. All rights reserved.</p>
        </footer>
      `;

      // Inject styles into shadow DOM
      const style = document.createElement('style');
      style.textContent = `
        :host {
          display: block;
          position: relative;
          min-height: 100vh;
        }

        /* Basic styles for the dashboard */
        :host {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 0;
        }

        /* Header styles */
        header {
          background-color: #333;
          color: white;
          padding: 1rem;
        }

        nav {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        nav .logo {
          font-size: 1.5rem;
        }

        nav ul {
          list-style: none;
          display: flex;
          gap: 1rem;
          margin: 0;
          padding: 0;
        }

        nav a {
          color: white;
          text-decoration: none;
          display: flex;
          align-items: center;
        }

        nav a i {
          margin-right: 0.5rem;
        }

        /* Main content styles */
        main {
          padding: 2rem;
        }

        .welcome h1 {
          margin-bottom: 0.5rem;
        }

        .stats {
          display: flex;
          gap: 1rem;
          margin-top: 2rem;
        }

        .card {
          background-color: #f4f4f4;
          padding: 1rem;
          border-radius: 5px;
          flex: 1;
          text-align: center;
        }

        .chart {
          margin-top: 2rem;
        }

        .chart h2 {
          margin-bottom: 1rem;
        }

        /* Footer styles */
        footer {
          background-color: #333;
          color: white;
          text-align: center;
          padding: 1rem;
          position: fixed;
          bottom: 0;
          width: 100%;
          box-sizing: border-box;
        }
      `;

      // Append styles and content to shadow DOM
      shadow.appendChild(style);
      shadow.appendChild(wrapper);

      // Load Font Awesome dynamically
      const fontAwesome = document.createElement('link');
      fontAwesome.rel = 'stylesheet';
      fontAwesome.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css';
      shadow.appendChild(fontAwesome);

      // Load external widget scripts dynamically
      const scripts = [
        {
          src: 'https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/login-widget.js',
          attrs: {
            'data-login-widget': '',
            'data-signup-link': '/signup.html',
            'data-container-id': 'login-widget',
          },
        },
        {
          src: 'https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/chart-widget.js',
        },
        {
          src: 'https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/api-widget.js',
        },
        {
          src: 'https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/category-widget.js',
          attrs: {
            'data-categories-widget': '',
            'data-api-endpoint': 'https://ytepcnwske.execute-api.eu-west-2.amazonaws.com',
            'data-container-id': 'categories-widget',
          },
        },
      ];

      scripts.forEach((scriptInfo) => {
        const script = document.createElement('script');
        script.src = scriptInfo.src;
        if (scriptInfo.attrs) {
          Object.keys(scriptInfo.attrs).forEach((key) => {
            script.setAttribute(key, scriptInfo.attrs[key]);
          });
        }
        script.onerror = () => console.error(`Failed to load script: ${scriptInfo.src}`);
        shadow.appendChild(script);
      });

      // Add logout event listener
      const logoutLink = shadow.querySelector('.logout');
      if (logoutLink) {
        logoutLink.addEventListener('click', (event) => {
          event.preventDefault();
          console.log('Logout clicked');
          localStorage.removeItem('authToken');
          localStorage.removeItem('user_id');
          localStorage.removeItem('contact_name');
          window.location.href = '/login.html';
        });
      }
    }
  }

  // Initialize widget when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDashboardWidget);
  } else {
    initDashboardWidget();
  }
})();