const express = require('express');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { parse } = require('tough-cookie');

const app = express();
const PORT = 5555;
const AD_SERVER_URL = 'https://raw.githubusercontent.com/Jigsaw88/Spotify-Ad-List/refs/heads/main/Spotify%20Adblock.txt';
const COOKIES_FILE = 'cookies.txt';

let adServers = new Set();
let lastUpdated = null;
let spotifyCookies = '';

// Enhanced cookie loading with tough-cookie parsing
function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = fs.readFileSync(COOKIES_FILE, 'utf8');
      const cookieLines = cookies.split('\n')
        .filter(line => line.trim() && !line.startsWith('#'));
      
      const cookieJar = new Map();
      
      cookieLines.forEach(line => {
        try {
          const parts = line.split('\t');
          if (parts.length >= 7 && parts[0].includes('spotify.com')) {
            const cookie = new parse.Cookie({
              key: parts[5],
              value: parts[6],
              domain: parts[0],
              path: parts[2],
              secure: parts[3] === 'TRUE',
              httpOnly: false,
              hostOnly: !parts[0].startsWith('.'),
              creation: new Date(),
              lastAccessed: new Date()
            });
            
            if (!cookieJar.has(parts[0])) {
              cookieJar.set(parts[0], []);
            }
            cookieJar.get(parts[0]).push(cookie);
          }
        } catch (e) {
          console.error('Error parsing cookie line:', line, e);
        }
      });
      
      // Convert to cookie string
      spotifyCookies = Array.from(cookieJar.values())
        .flat()
        .map(cookie => cookie.cookieString())
        .join('; ');
      
      console.log('Loaded Spotify cookies from file');
    } else {
      console.warn(`No cookies file found at ${COOKIES_FILE}`);
    }
  } catch (err) {
    console.error('Error loading cookies:', err);
  }
}

app.use(cookieParser());

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

// Enhanced CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Spotify-App-Version');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Enhanced ad blocking
app.use((req, res, next) => {
  const host = req.headers.host;
  const referer = req.headers.referer;
  
  if (host && adServers.has(host)) {
    console.log(`Blocked ad request to: ${host}`);
    return res.status(403).send('Ad blocked');
  }
  
  const blockedKeywords = ['ad', 'ads', 'advert', 'track', 'log', 'analytic'];
  const url = req.url.toLowerCase();
  if (blockedKeywords.some(keyword => url.includes(keyword))) {
    console.log(`Blocked ad-related URL: ${req.url}`);
    return res.status(403).send('Ad content blocked');
  }
  
  next();
});

// WebSocket support for Spotify player
const wsProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  ws: true,
  secure: false,
  logLevel: 'debug'
});

// Main proxy with enhanced handling
const spotifyProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  cookieDomainRewrite: {
    '*': '',
  },
  onProxyReq: (proxyReq, req) => {
    // Inject cookies from file
    if (spotifyCookies) {
      proxyReq.setHeader('cookie', spotifyCookies);
    }
    
    // Fix headers for Spotify
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    proxyReq.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
    proxyReq.setHeader('Referer', 'https://open.spotify.com/');
    
    // Special endpoints
    if (req.url.includes('clienttoken')) {
      proxyReq.setHeader('Origin', 'https://open.spotify.com');
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    // Fix CORS
    proxyRes.headers['access-control-allow-origin'] = req.headers.origin || '*';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    
    // Remove cookies from response
    if (proxyRes.headers['set-cookie']) {
      delete proxyRes.headers['set-cookie'];
    }
    
    // Modify manifest to fix PWA warnings
    if (req.url.includes('manifest-web-player')) {
      try {
        const manifest = JSON.parse(proxyRes.body.toString('utf8'));
        manifest.start_url = `http://${req.headers.host}/`;
        manifest.scope = `/`;
        proxyRes.body = Buffer.from(JSON.stringify(manifest), 'utf8');
      } catch (e) {
        console.error('Error modifying manifest:', e);
      }
    }
  },
  secure: false,
  logLevel: 'debug'
});

// Apply proxies
app.use('/', spotifyProxy);
app.use('/.ws', wsProxy); // WebSocket endpoint

// Blocked domains endpoint
app.get('/blocked-domains', (req, res) => {
  res.json({
    count: adServers.size,
    lastUpdated: lastUpdated,
    domains: Array.from(adServers)
  });
});

// Start server
loadCookies();
updateAdServers().then(() => {
  setInterval(updateAdServers, 6 * 60 * 60 * 1000);
  
  const server = app.listen(PORT, () => {
    console.log(`\nSpotify Ad-Free Proxy running on http://localhost:${PORT}`);
    console.log(`Ad server list will be refreshed every 6 hours`);
    console.log(`Access /blocked-domains to view current blocking rules\n`);
  });
  
  // Enable WebSocket upgrade
  server.on('upgrade', wsProxy.upgrade);
});