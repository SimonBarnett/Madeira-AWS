![ClubMadeira.io Icon](https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/icon-192.png)
# ClubMadeira.io Partner Integration Guide

Welcome to the ClubMadeira.io Affiliate Program! This guide is designed to help you, our valued partner, seamlessly integrate our widgets into your website to sign up merchants and communities for our affiliate program, earning commissions on sales. Our widgets are lightweight, easy to implement, and can be hosted on simple static hosting platforms like Amazon S3. This README provides step-by-step instructions for webmasters to set up and deploy the provided HTML templates and scripts.

## Overview

Our affiliate program widgets enable your website to:
- Display a public home page to attract visitors.
- Provide login and signup functionality for merchants and communities.
- Offer authenticated users access to a dashboard, API keys management, and discount category management.
- Track affiliate referrals using your unique affiliate code.

The provided templates (`index.html`, `login.html`, `signup.html`, `dashboard.html`, `api-keys.html`, `category.html`) demonstrate how to integrate our widgets. These can be hosted on any static web hosting service, making setup straightforward and cost-effective.

## Prerequisites

Before you begin, ensure you have:
- Your unique **affiliate code** (e.g., `PARTNER123`), provided by ClubMadeira.io.
- A static hosting platform (see Hosting Options below).
- Basic knowledge of HTML, CSS, and JavaScript.
- Access to your website’s file structure to upload files.

## Hosting Options

Our widgets are designed for static hosting, meaning no server-side processing is required. You can host your site on platforms like:

- **Amazon S3**: A cost-effective, scalable option for static websites. Create a bucket, enable static website hosting, and upload your files. Ideal for low-maintenance setups.
- **Netlify**: A user-friendly platform with free tiers, automatic HTTPS, and easy deployment via drag-and-drop or Git integration. Popular for static sites.
- **Vercel**: Offers a free plan, simple deployment, and built-in domain management. Great for developers familiar with Git workflows.
- **IONOS**: A UK-based provider offering affordable static hosting with domain registration and 24/7 support.
- **Fasthosts**: Another UK option with reliable static hosting, domain services, and beginner-friendly tools.

For UK partners, **IONOS** and **Fasthosts** are excellent choices due to local support and GDPR compliance. Alternatively, **Amazon S3** is ideal for simplicity and global scalability. Choose a platform that suits your budget and technical expertise.

## Setup Instructions

Follow these steps to integrate the ClubMadeira.io widgets into your website:

### 1. Clone or Download the Repository

Clone this Git repository or download the provided HTML templates and associated files. The key files are:
- `index.html`: Public home page.
- `login.html`: Login page for users.
- `signup.html`: Signup page for new merchants and communities.
- `dashboard.html`: Authenticated dashboard with performance charts.
- `api-keys.html`: Authenticated page for managing API keys.
- `category.html`: Authenticated page for managing discount categories.
- `css/page.css`: Your custom CSS file (create or customize as needed).
- `footer.html`: Your footer content (create with contact info, links, etc.).
- `index.json`: Configuration file (create as described below).
- `manifest.json`: PWA configuration (create as described below).
- `sw.js`: Service worker for offline support (optional, see widget documentation).

### 2. Configure `index.json`

Create a file named `index.json` at your site’s root (e.g., `https://your-site.com/index.json`) with the following structure:

```json
{
  "loginUrl": "/login.html",
  "affiliateCode": "YOUR_AFFILIATE_CODE",
  "signupLinkUrl": "/signup.html"
}
```

- **`loginUrl`**: The relative or absolute URL to your login page (e.g., `/login.html` or `https://your-site.com/login.html`).
- **`affiliateCode`**: Your unique affiliate identifier (e.g., `PARTNER123`). This is appended to the Affiliate AI menu URL (e.g., `/category.html?affiliate=PARTNER123`) and is required for the login and signup widgets.
- **`signupLinkUrl`**: The relative or absolute URL to your signup page (e.g., `/signup.html`).

Ensure `index.json` is publicly accessible and correctly formatted. If missing or invalid, widgets fall back to defaults (`/login.html`, empty affiliate code, `/signup.html`), which may cause errors.

### 3. Set Up Progressive Web App (PWA) Support

To enable PWA features (e.g., installation prompts, offline access), create a `manifest.json` file at your site’s root:

```json
{
  "name": "Your App Name",
  "icons": [
    {
      "src": "https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ],
  "start_url": "/index.html",
  "display": "standalone",
  "theme_color": "#000000",
  "background_color": "#ffffff"
}
```

Optionally, host a service worker file (`sw.js`) for offline support. Refer to the widget documentation for a basic example.

### 4. Integrate Widgets

Each HTML template includes widgets for specific functionality. Below is a summary of how to integrate them:

#### Header Widget (All Pages)
- **Purpose**: Provides navigation, authentication, and PWA features.
- **Integration**:
  - Add a `<header>` element with attributes:
    ```html
    <header data-header-widget data-page-name="Page Name" data-requireToken="true|false" [data-icon="fas fa-cog"]></header>
    ```
    - `data-page-name`: Display name (e.g., "Dashboard").
    - `data-requireToken`: Set to `true` for authenticated pages (e.g., dashboard), `false` for public pages (e.g., login).
    - `data-icon`: Optional Font Awesome icon class (defaults to menu icon or `fas fa-home`).
  - Include the script:
    ```html
    <script src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/header-widget.js"></script>
    ```

#### Login Widget (`login.html`)
- **Purpose**: Handles user login, forgot password, and OTP verification.
- **Integration**:
  - Add a container: `<div id="login-widget"></div>`.
  - Include the script:
    ```html
    <script data-login-widget data-container-id="login-widget" src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/login-widget.js"></script>
    ```
  - Ensure `index.json` includes a valid `affiliateCode`, or the widget will display an error.

#### Signup Widget (`signup.html`)
- **Purpose**: Manages user registration for merchants and communities.
- **Integration**:
  - Add a container: `<div id="signup-widget"></div>`.
  - Include the script:
    ```html
    <script data-signup-widget data-container-id="signup-widget" src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/signup-widget.js"></script>
    ```

#### API Keys Widget (`api-keys.html`)
- **Purpose**: Allows authenticated users to manage API keys.
- **Integration**:
  - Add a container: `<div id="api-keys-container"></div>`.
  - Include the script:
    ```html
    <script src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/api-widget.js"></script>
    ```

#### Categories Widget (`category.html`)
- **Purpose**: Enables authenticated users to manage discount categories.
- **Integration**:
  - Add a container: `<div id="categories-widget"></div>`.
  - Include the script:
    ```html
    <script 
      src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/category-widget.js"
      data-categories-widget
      data-api-endpoint="https://ytepcnwske.execute-api.eu-west-2.amazonaws.com"
      data-container-id="categories-widget"
    ></script>
    ```

#### Chart Widget (`dashboard.html`)
- **Purpose**: Displays performance charts for authenticated users.
- **Integration**:
  - Add a container: `<div id="madeira-charts"></div>`.
  - Include the script:
    ```html
    <script src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/chart-widget.js"></script>
    ```

#### Footer (All Pages)
- **Purpose**: Displays dynamic or static footer content.
- **Integration**:
  - Add a `<footer id="footer"></footer>` element.
  - Include the script to load `footer.html`:
    ```html
    <script>
      fetch('footer.html')
        .then(response => {
          if (!response.ok) throw new Error('Failed to load footer.html');
          return response.text();
        })
        .then(data => {
          document.getElementById('footer').innerHTML = data;
        })
        .catch(error => {
          console.error('Error loading footer:', error.message);
          document.getElementById('footer').innerHTML = '<p>Footer content unavailable</p>';
        });
    </script>
    ```
  - Host a `footer.html` file at your site’s root with your content (e.g., contact info, links). Alternatively, use static content directly in the `<footer>`.

### 5. Customize Styling

- Create a `css/page.css` file to style your pages, ensuring compatibility with widget styles.
- Widgets use Font Awesome icons and their own CSS, which can be overridden (see widget documentation).
- Avoid conflicting CSS that may affect widget rendering (e.g., global resets impacting Font Awesome).

### 6. Authentication

- Widgets use AWS Lambda for authentication, checking an `authToken` in `localStorage`.
- Public pages (`login.html`, `signup.html`, `index.html`) use `data-requireToken="false"`.
- Protected pages (`dashboard.html`, `api-keys.html`, `category.html`) use `data-requireToken="true"`, redirecting unauthenticated users to the `loginUrl` from `index.json`.
- The login widget stores `authToken`, `user_id`, and `contact_name` in `localStorage` upon successful login.
- The signup widget stores an `authToken` in cookies during registration, completed via email, phone, and password.

### 7. Test Your Implementation

Deploy your site to your chosen hosting platform and test the following:
- **Navigation**: Header menu works, displaying public and authenticated options correctly.
- **Configuration**: `index.json` is fetched without errors (check console logs).
- **Widgets**: Login, signup, API keys, categories, and chart widgets render and function as expected.
- **Authentication**: Protected pages redirect to `loginUrl` if unauthenticated; login/signup store `authToken` correctly.
- **PWA**: Installation prompt appears on supported browsers (e.g., Chrome, Safari).
- **Footer**: `footer.html` loads, or static content displays correctly.
- **Affiliate Tracking**: The `affiliateCode` is appended to the Affiliate AI menu URL (e.g., `/category.html?affiliate=PARTNER123`).

Use browser developer tools to debug issues (e.g., 404 errors for `index.json` or `footer.html`, API failures).

### 8. Deploy and Monitor

- Upload all files to your hosting platform (e.g., S3 bucket, Netlify project).
- Verify HTTPS is enabled (most platforms, like Netlify and S3, support this).
- Monitor console logs for errors and test user flows (signup, login, dashboard access).
- Contact our integration team if you encounter issues.

## Common UK Hosting Setup Example: Amazon S3

For partners new to static hosting, here’s a quick guide to using Amazon S3:
1. **Create an S3 Bucket**:
   - Sign into the AWS Console, navigate to S3, and create a bucket (e.g., `your-partner-site`).
   - Choose the `eu-west-2` region for UK compliance.
2. **Enable Static Hosting**:
   - In the bucket’s Properties tab, enable Static Website Hosting.
   - Set `index.html` as the index document.
3. **Upload Files**:
   - Upload all HTML, CSS, JSON, and other files to the bucket.
   - Ensure `index.json` and `footer.html` are at the root.
4. **Set Permissions**:
   - Update the bucket policy to allow public read access:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Sid": "PublicReadGetObject",
           "Effect": "Allow",
           "Principal": "*",
           "Action": "s3:GetObject",
           "Resource": "arn:aws:s3:::your-partner-site/*"
         }
       ]
     }
     ```
5. **Test the Endpoint**:
   - Access your site via the S3 static website endpoint (e.g., `http://your-partner-site.s3-website.eu-west-2.amazonaws.com`).
   - Optionally, configure a custom domain with Route 53 or CloudFront for HTTPS.

## Support

If you need assistance, please:
- Refer to the widget documentation for detailed API and styling information.
- Contact our integration team at [support```clubmadeira.io](mailto:support```clubmadeira.io).
- Join our partner community on [X](https://x.com/clubmadeira) for tips and updates.

Thank you for partnering with ClubMadeira.io! We’re excited to help you drive affiliate success with our easy-to-use widgets.

---

**License**: This software is provided under the MIT License. See the repository’s license file for details.

**Copyright © 2025 Simon Barnett**