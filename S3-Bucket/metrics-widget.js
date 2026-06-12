(function() {
    document.addEventListener('DOMContentLoaded', () => {
        // Define CSS styles for the widget and server-provided classes
        const styles = `
            #metrics-widget {
                position: relative;
                width: 100%;
                max-width: 1200px;
                margin: 20px auto;
                padding: 0;
                box-sizing: border-box;
            }
            .metrics-container {
                display: flex;
                overflow-x: auto;
                padding: 10px 0;
                gap: 20px;
                scroll-behavior: smooth;
            }
            .metric-card {
                flex: 0 0 auto;
                width: 250px;
                padding: 10px; /* Reduced from 20px to halve height */
                background: #f9f9f9;
                border: 1px solid #ddd;
                border-radius: 8px;
                text-align: center;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            /* Background colors cycling through 61cfff, ff61ff, fe6f61, 6bff61 */
            .metric-card:nth-child(4n+1) { background-color: #61cfff; }
            .metric-card:nth-child(4n+2) { background-color: #ff61ff; }
            .metric-card:nth-child(4n+3) { background-color: #fe6f61; }
            .metric-card:nth-child(4n+4) { background-color: #6bff61; }
            .metric-card i {
                font-size: 1.5em; /* Reduced from 2em for half height */
                margin-bottom: 5px; /* Reduced from 10px */
                /* Adjust icon color for visibility */
                color: #fff; /* White icons for contrast against colored backgrounds */
            }
            .metric-card h3 {
                font-size: 0.9em; /* Reduced from 1.2em */
                margin: 5px 0; /* Reduced from 10px */
                color: #333; /* Dark text for readability */
            }
            .metric-card p {
                font-size: 1em; /* Reduced from 1.5em */
                font-weight: bold;
                color: #333; /* Dark text for readability */
            }
            .metric-card .warning {
                color: #ff4500; /* Adjusted warning color for visibility */
            }
            .error-message {
                text-align: center;
                color: red;
                font-size: 1.2em;
                margin-top: 20px;
            }
            /* Loading Overlay Styles */
            .loading-overlay {
                display: none;
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(255, 255, 255, 0.8);
                justify-content: center;
                align-items: center;
                z-index: 10;
            }
            .loading-overlay .spinner-container {
                position: relative;
                width: 100px; /* Reduced from 200px */
                height: 100px; /* Reduced from 200px */
            }
            .loading-overlay .spinner {
                position: absolute;
                border-radius: 50%;
                border: 4px solid transparent; /* Reduced from 8px */
                animation: spin 1.5s linear infinite;
            }
            .loading-overlay .spinner-1 {
                width: 40px; /* Reduced from 80px */
                height: 40px; /* Reduced from 80px */
                border-top-color: #ff6f61;
                top: 30px; /* Reduced from 60px */
                left: 30px; /* Reduced from 60px */
                animation-delay: 0s;
            }
            .loading-overlay .spinner-2 {
                width: 30px; /* Reduced from 60px */
                height: 30px; /* Reduced from 60px */
                border-top-color: #6bff61;
                top: 35px; /* Reduced from 70px */
                left: 35px; /* Reduced from 70px */
                animation-delay: 0.3s;
            }
            .loading-overlay .spinner-3 {
                width: 20px; /* Reduced from 40px */
                height: 20px; /* Reduced from 40px */
                border-top-color: #61cfff;
                top: 40px; /* Reduced from 80px */
                left: 40px; /* Reduced from 80px */
                animation-delay: 0.6s;
            }
            .loading-overlay .spinner-4 {
                width: 10px; /* Reduced from 20px */
                height: 10px; /* Reduced from 20px */
                border-top-color: #ff61ff;
                top: 45px; /* Reduced from 90px */
                left: 45px; /* Reduced from 90px */
                animation-delay: 0.9s;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;

        // Inject styles into the document head
        const styleElement = document.createElement('style');
        styleElement.innerHTML = styles;
        document.head.appendChild(styleElement);

        // Load Font Awesome if not already present
        if (!document.querySelector('link[href*="font-awesome"]')) {
            const faLink = document.createElement('link');
            faLink.rel = 'stylesheet';
            faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css';
            document.head.appendChild(faLink);
        }

        // Use existing #metrics-widget if available, else create a new one
        let widget = document.getElementById('metrics-widget');
        if (!widget) {
            widget = document.createElement('div');
            widget.id = 'metrics-widget';
            document.body.appendChild(widget);
        }

        // Create loading overlay
        const loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'loading-overlay';
        loadingOverlay.innerHTML = `
            <div class="spinner-container">
                <div class="spinner spinner-1"></div>
                <div class="spinner spinner-2"></div>
                <div class="spinner spinner-3"></div>
                <div class="spinner spinner-4"></div>
            </div>
        `;
        widget.appendChild(loadingOverlay);

        // Function to fetch metrics HTML from the endpoint with token
        async function fetchMetricsHtml() {
            loadingOverlay.style.display = 'flex'; // Show loading overlay

            try {
                // Prepare headers object
                let headers = {};

                // Retrieve the token from localStorage
                const token = localStorage.getItem('authToken');

                // If token exists, include it in the Authorization header
                if (token) {
                    headers['Authorization'] = `Bearer ${token}`;
                }

                // Fetch data from the endpoint with headers
                const response = await fetch('https://ytepcnwske.execute-api.eu-west-2.amazonaws.com/prod/ui/metrics', {
                    headers: headers
                });

                // Check if the response is successful
                if (!response.ok) {
                    throw new Error('Failed to fetch metrics');
                }

                // Parse the JSON response
                const data = await response.json();

                // Check if HTML content is present and update the widget
                if (data.html) {
                    widget.innerHTML = data.html; // Replace content, including loading overlay
                } else {
                    throw new Error('No HTML content in response');
                }
            } catch (error) {
                // Display error message in the widget
                widget.innerHTML = `<div class="error-message">${error.message}</div>`;
            } finally {
                loadingOverlay.style.display = 'none'; // Hide loading overlay
            }
        }

        // Initialize the widget by fetching and setting the metrics HTML
        fetchMetricsHtml();
    });
})();