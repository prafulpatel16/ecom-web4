import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App.js';
import reportWebVitals from './reportWebVitals';
import { Auth0Provider } from '@auth0/auth0-react';

// Auth0 configuration with environment variables
const domain = process.env.REACT_APP_AUTH0_DOMAIN;
const clientId = process.env.REACT_APP_AUTH0_CLIENT_ID;
const audience = process.env.REACT_APP_AUTH0_AUDIENCE;
const redirectUri = window.location.origin;
   

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    {/* Wrap the App with Auth0Provider */}
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      redirectUri={redirectUri}
      audience={audience}
      scope="openid profile email"
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>
);

// For performance logging
reportWebVitals();
