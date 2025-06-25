const express = require('express');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const AD_SERVER_URL = 'https://raw.githubusercontent.com/Jigsaw88/Spotify-Ad-List/refs/heads/main/Spotify%20Adblock.txt';

let adServers = new Set();
let lastUpdated = null;

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

// Initial load and periodic refresh (every 6 hours)
updateAdServers();
setInterval(updateAdServers, 6 * 60 * 60 * 1000);

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

// Proxy configuration for Spotify
const spotifyProxy = createProxyMiddleware({
  target: 'https://open.spotify.com',
  changeOrigin: true,
  onProxyRes: (proxyRes, req, res) => {
    // Modify responses if needed (e.g., remove ad-related elements)
    if (proxyRes.headers['content-type'] && proxyRes.headers['content-type'].includes('text/html')) {
      // This would need to be a transform stream in a real implementation
      // to modify the HTML content
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
app.listen(PORT, () => {
  console.log(`Spotify Ad-Free Proxy running on http://localhost:${PORT}`);
  console.log(`Ad server list will be refreshed every 6 hours`);
});