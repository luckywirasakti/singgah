const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PROXY_PORT = process.env.PROXY_PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'dist');
const DOMAIN = process.env.DOMAIN || 'singgah.web.id';
const SERVER_HOST = process.env.SERVER_HOST || 'singgah.web.id';    // fallback default (no subdomain)
const TUNNEL_MIN = parseInt(process.env.TUNNEL_MIN, 10) || 9000;
const TUNNEL_MAX = parseInt(process.env.TUNNEL_MAX, 10) || 9015;
const DEFAULT_PORT = parseInt(process.env.DEFAULT_PORT, 10) || 9000;
const NAMES_FILE = process.env.NAMES_FILE || path.join(__dirname, 'tunnel-names.json');

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.json':'application/json','.woff':'font/woff','.woff2':'font/woff2',
  '.webp':'image/webp','.mp4':'video/mp4','.pdf':'application/pdf'
};

// ── Name→Port mapping ──
var nameMap = {};
function loadNames() {
  try {
    nameMap = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf-8'));
    console.log('names loaded: ' + Object.keys(nameMap).length + ' entries');
  } catch(e) {
    console.error('names load error:', e.message);
  }
}
loadNames();
fs.watchFile(NAMES_FILE, { interval: 2000 }, function() { loadNames(); });

// ── Scan all tunnel ports every 2s ──
var tunnelAlive = {};
function scanTunnels() {
  for (var p = TUNNEL_MIN; p <= TUNNEL_MAX; p++) {
    (function(port) {
      var s = new net.Socket();
      s.setTimeout(500);
      s.on('connect', function() { tunnelAlive[port] = true; s.destroy(); });
      s.on('error', function() { delete tunnelAlive[port]; s.destroy(); });
      s.on('timeout', function() { delete tunnelAlive[port]; s.destroy(); });
      s.connect(port, '127.0.0.1');
    })(p);
  }
}
scanTunnels();
setInterval(scanTunnels, 2000);

// ── Resolve port from Host header ──
// Supports: root, port-number (9000.singgah.web.id), indie-name (panggung.singgah.web.id)
function resolvePort(host) {
  if (!host) return DEFAULT_PORT;
  // Strip port suffix if any
  host = host.replace(/:\d+$/, '');
  var root = DOMAIN;
  var wwwRoot = 'www.' + DOMAIN;
  if (host === root || host === wwwRoot) return DEFAULT_PORT;

  // Extract subdomain: e.g. "panggung" from "panggung.singgah.web.id"
  var suffix = '.' + DOMAIN;
  if (host.endsWith(suffix)) {
    var sub = host.slice(0, -suffix.length);
    // Number?
    var num = parseInt(sub, 10);
    if (!isNaN(num) && num >= TUNNEL_MIN && num <= TUNNEL_MAX) return num;
    // Indie name?
    if (nameMap[sub]) return nameMap[sub];
    if (nameMap[sub.toLowerCase()]) return nameMap[sub.toLowerCase()];
  }
  return null;
}

// ── Proxy to tunnel ──
function proxyRequest(req, res, port) {
  var opts = {
    hostname: '127.0.0.1',
    port: port,
    path: req.url,
    method: req.method,
    headers: req.headers
  };
  var proxyReq = http.request(opts, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', function() { serveStatic(req, res, STATIC_DIR); });
  req.pipe(proxyReq);
}

// ── Static fallback ──
function serveStatic(req, res, dir) {
  var filePath = path.join(dir, req.url === '/' ? 'index.html' : req.url);
  if (!path.extname(filePath)) filePath = path.join(dir, 'index.html');
  fs.readFile(filePath, function(err, data) {
    if (err) {
      fs.readFile(path.join(dir, 'index.html'), function(err2, data2) {
        if (err2) { res.writeHead(500); res.end('500'); return; }
        res.writeHead(200, {'Content-Type':'text/html'});
        res.end(data2);
      });
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
}

// ── Server ──
http.createServer(function(req, res) {
  var host = req.headers.host || '';
  var tunnelPort = resolvePort(host);

  res.setHeader('X-Tunnel-Port', tunnelPort !== null ? String(tunnelPort) : 'none');

  if (tunnelPort !== null && tunnelAlive[tunnelPort]) {
    proxyRequest(req, res, tunnelPort);
  } else {
    serveStatic(req, res, STATIC_DIR);
  }
}).listen(PROXY_PORT, function() {
  console.log('dynamic proxy on :' + PROXY_PORT + ' | ' + DOMAIN + ' / *.' + DOMAIN);
  console.log('tunnel range: ' + TUNNEL_MIN + '–' + TUNNEL_MAX + ' | names: ' + Object.keys(nameMap).length);
});
