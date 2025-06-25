const express = require('express');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 5555;
const AD_SERVER_URL = 'https://raw.githubusercontent.com/Jigsaw88/Spotify-Ad-List/refs/heads/main/Spotify%20Adblock.txt';
const COOKIES_FILE = 'cookies.txt';

let adServers = new Set();
let lastUpdated = null;
let spotifyCookies = '';

// Load cookies from file
function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = fs.readFileSync(COOKIES_FILE, 'utf8');
      spotifyCookies = cookies.split('\n')
        .filter(line => line.trim() && !line.startsWith('#') && line.includes('open.spotify.com'))
        .map(line => {
          const parts = line.split('\t');
          return `${parts[5]}=${parts[6]}`;
        })
        .join('; ');
      
      console.log('Loaded Spotify cookies from file');
    } else {
      console.warn(`No cookies file found at ${COOKIES_FILE}`);
    }
  } catch (err) {
    console.error('Error loading cookies:', err);
  }
}

// Initialize cookie parser (but we won't use it for storing cookies)
app.use(cookieParser());

// CORS middleware - must come before proxy
app.use((req, res, next) => {
  // Set CORS headers for all responses
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Middleware to block ads
app.use((req, res, next) => {
  const host = req.headers.host;
  
  if (host && adServers.has(host)) {
    console.log(`Blocked ad request to: ${host}`);
    return res.status(403).send('Ad blocked');
  }
  
  const blockedKeywords = ['ad', 'ads', 'advertising', 'tracking', 'analytics'];
  if (blockedKeywords.some(keyword => req.url.includes(keyword))) {
    console.log(`Blocked ad-related URL: ${req.url}`);
    return res.status(403).send('Ad content blocked');
  }
  
  next();
});

// Proxy configuration for Spotify
const spotifyProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  cookieDomainRewrite: {
    '*': '', // Remove domain restriction for cookies
  },
  onProxyReq: (proxyReq, req) => {
    // Always inject our cookies from the file
    if (spotifyCookies) {
      proxyReq.setHeader('cookie', spotifyCookies);
    }
    
    // Additional headers to mimic browser behavior
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    proxyReq.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
    
    if (req.url.includes('clienttoken')) {
      proxyReq.setHeader('Origin', 'https://open.spotify.com');
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    // Ensure CORS headers are properly set
    proxyRes.headers['access-control-allow-origin'] = req.headers.origin || '*';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    
    // Remove all set-cookie headers to prevent browser from storing them
    if (proxyRes.headers['set-cookie']) {
      delete proxyRes.headers['set-cookie'];
    }
    
    if (req.url.includes('clienttoken')) {
      proxyRes.headers['access-control-allow-origin'] = req.headers.origin || '*';
    }
  },
  secure: false,
  logLevel: 'debug'
});

// Route all requests through our proxy
app.use('/', spotifyProxy);

// Add endpoint to check blocked domains
app.get('/blocked-domains', (req, res) => {
  res.json({
    count: adServers.size,
    lastUpdated: lastUpdated,
    domains: Array.from(adServers)
  });
});

// Start server
loadCookies(); // Load cookies at startup
updateAdServers().then(() => {
  setInterval(updateAdServers, 6 * 60 * 60 * 1000);
  
  app.listen(PORT, () => {
    console.log(`\nSpotify Ad-Free Proxy running on http://localhost:${PORT}`);
    console.log(`Ad server list will be refreshed every 6 hours`);
    console.log(`Access /blocked-domains to view current blocking rules\n`);
  });
});