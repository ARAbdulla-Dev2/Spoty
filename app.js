const express = require('express');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 5555;
const AD_SERVER_URL = 'https://raw.githubusercontent.com/Jigsaw88/Spotify-Ad-List/refs/heads/main/Spotify%20Adblock.txt';
const COOKIE_FILE = 'cookies.txt';

let adServers = new Set();
let lastUpdated = null;

// Initialize cookie parser
app.use(cookieParser());

// Function to load cookies from file
function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookieData = fs.readFileSync(COOKIE_FILE, 'utf8');
      return cookieData.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    }
  } catch (err) {
    console.error('Error loading cookies:', err);
  }
  return [];
}

// Function to fetch and update ad servers list
async function updateAdServers() {
  try {
    console.log('Fetching updated ad server list...');
    const response = await axios.get(AD_SERVER_URL);
    const servers = response.data.split('\n')
      .map(server => server.trim())
      .filter(server => server && !server.startsWith('#') && server !== '');
    
    adServers = new Set(servers);
    lastUpdated = new Date();
    console.log(`Ad servers updated at ${lastUpdated}. Total: ${adServers.size}`);
  } catch (error) {
    console.error('Failed to update ad servers:', error.message);
  }
}

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Middleware to inject cookies
app.use((req, res, next) => {
  const cookies = loadCookies();
  if (cookies.length > 0) {
    req.headers.cookie = cookies.join('; ');
  }
  next();
});

// Middleware to block ads
app.use((req, res, next) => {
  const host = req.headers.host;
  
  // Check if request is to a known ad server
  if (host && adServers.has(host)) {
    console.log(`Blocked ad request to: ${host}`);
    return res.status(403).send('Ad blocked');
  }
  
  // Additional checks for ad URLs in the path
  const blockedKeywords = ['ad', 'ads', 'advertising', 'tracking', 'analytics'];
  if (blockedKeywords.some(keyword => req.url.includes(keyword))) {
    console.log(`Blocked ad-related URL: ${req.url}`);
    return res.status(403).send('Ad content blocked');
  }
  
  next();
});

// Proxy configuration for Spotify with cookie support
const spotifyProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  cookieDomainRewrite: {
    '*': '', // Remove domain restriction for cookies
  },
  onProxyReq: (proxyReq, req) => {
    // Forward cookies from client to Spotify
    if (req.headers.cookie) {
      proxyReq.setHeader('cookie', req.headers.cookie);
    }
    
    // Additional headers to mimic browser behavior
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    proxyReq.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Handle CORS headers
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    
    // Store received cookies
    if (proxyRes.headers['set-cookie']) {
      const cookies = proxyRes.headers['set-cookie'].map(cookie => {
        return cookie.split(';')[0]; // Get just the key=value part
      });
      
      // Save new cookies to file
      fs.writeFileSync(COOKIE_FILE, cookies.join('\n'));
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

// Add endpoint to view current cookies
app.get('/cookies', (req, res) => {
  try {
    const cookies = loadCookies();
    res.json({
      count: cookies.length,
      cookies: cookies
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cookies' });
  }
});

// Start server
updateAdServers().then(() => {
  setInterval(updateAdServers, 6 * 60 * 60 * 1000);
  
  app.listen(PORT, () => {
    console.log(`\nSpotify Ad-Free Proxy running on http://localhost:${PORT}`);
    console.log(`Ad server list will be refreshed every 6 hours`);
    console.log(`Cookies will be loaded from ${COOKIE_FILE}`);
    console.log(`Access /blocked-domains to view current blocking rules`);
    console.log(`Access /cookies to view current authentication cookies\n`);
  });
});