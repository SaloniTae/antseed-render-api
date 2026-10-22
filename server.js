'use strict';

const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Vercel's deployed filesystem is read-only except for /tmp. AntSeed keeps its
// config, identity and local state under its data directory, so give it a writable
// location there. On persistent hosts, keep AntSeed's normal home-directory paths.
if (process.env.VERCEL === '1') {
  const antseedTmpDir = '/tmp/antseed';
  process.env.ANTSEED_DATA_DIR = process.env.ANTSEED_DATA_DIR || antseedTmpDir;
  process.env.ANTSEED_CONFIG =
    process.env.ANTSEED_CONFIG || path.join(antseedTmpDir, 'config.json');
  fs.mkdirSync(process.env.ANTSEED_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(process.env.ANTSEED_CONFIG), { recursive: true, mode: 0o700 });
}

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN;
const API_TOKEN_CONFIGURED = typeof API_TOKEN === 'string' && API_TOKEN.length > 0;
const ANTSEED_BIN = path.join(__dirname, 'node_modules', '.bin', 'antseed');
const BUYER_PORT = 8377;
const PROXY_TIMEOUT_MS = 35 * 60 * 1000; // align with AntSeed's 30-minute stream limit

const EXACT_API_ROUTES = new Set([
  'GET /v1/models',
  'POST /v1/chat/completions',
  'POST /v1/responses',
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
]);

function isAllowedApiRoute(req) {
  if (EXACT_API_ROUTES.has(req.method + ' ' + req.path)) return true;
  // Model IDs can contain slashes (for example, provider/model-name).
  return req.method === 'GET' && /^\\/v1\\/models\\/.+/.test(req.path);
}

if (!API_TOKEN_CONFIGURED) {
  // Do not process.exit() during module initialization: Vercel turns it into the
  // opaque FUNCTION_INVOCATION_FAILED page. Keep the API safely closed and report
  // an actionable configuration error instead.
  console.error('API_TOKEN is missing. Set API_TOKEN in the Vercel Environment Variables to the token you want to use.');
}

let buyerReady = false;
let buyerProcess = null;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ANTSEED_BIN, args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('antseed ' + args.join(' ') + ' exited (code=' + code + ', signal=' + signal + ')'));
    });
  });
}

function configureFreeOnlyRouting() {
  const configPath = path.resolve(
    process.env.ANTSEED_CONFIG || path.join(os.homedir(), '.antseed', 'config.json')
  );

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.buyer = config.buyer || {};
  config.buyer.routingPreferences = config.buyer.routingPreferences || {};
  config.buyer.routingPreferences.preferFreePeers = true;
  config.buyer.maxPricing = config.buyer.maxPricing || {};
  config.buyer.maxPricing.defaults = config.buyer.maxPricing.defaults || {};
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 0;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 0;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.log('Configured free-peer preference and hard zero-price caps in ' + configPath);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buyerHealthCheck() {
  return new Promise(resolve => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: BUYER_PORT,
      path: '/v1/models',
      timeout: 2500,
    }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  const ready = API_TOKEN_CONFIGURED && buyerReady;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: 'antseed-render-api',
    buyer: buyerReady ? 'ready' : 'starting',
    configuration: API_TOKEN_CONFIGURED ? 'ok' : 'missing_api_token',
  });
});

app.use((req, res, next) => {
  if (!API_TOKEN_CONFIGURED) {
    return res.status(503).json({
      error: {
        message: 'Server misconfigured: set API_TOKEN in the deployment environment.',
        type: 'configuration_error',
      },
    });
  }
  if (req.get('authorization') !== 'Bearer ' + API_TOKEN) {
    return res.status(401).json({
      error: { message: 'Missing or invalid API token', type: 'authentication_error' },
    });
  }
  if (!buyerReady) {
    return res.status(503).json({
      error: { message: 'AntSeed buyer is starting; retry shortly', type: 'service_unavailable' },
    });
  }
  return next();
});

// Expose only the intended text-model API. In particular, don't forward AntSeed's
// /_antseed control plane or media endpoints whose billing is not token-price based.
app.use((req, res, next) => {
  if (!isAllowedApiRoute(req)) {
    return res.status(404).json({
      error: { message: 'Endpoint is not exposed by this text-only API wrapper', type: 'not_found' },
    });
  }
  return next();
});

// Do not parse the request body before proxying; streaming completions must pass through.
app.use('/', createProxyMiddleware({
  target: 'http://127.0.0.1:' + BUYER_PORT,
  changeOrigin: false,
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  on: {
    error(err, _req, res) {
      console.error('AntSeed proxy error:', err.message);
      if (res && !res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      if (res && !res.writableEnded) {
        res.end(JSON.stringify({
          error: { message: 'AntSeed buyer unavailable', type: 'proxy_error' },
        }));
      }
    },
  },
}));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Authenticated public API listening on 0.0.0.0:' + PORT);
});

async function startBuyer() {
  if (!API_TOKEN_CONFIGURED) return;

  const configPath = path.resolve(
    process.env.ANTSEED_CONFIG || path.join(os.homedir(), '.antseed', 'config.json')
  );
  if (!fs.existsSync(configPath)) {
    await runCli(['config', 'init']);
  }

  // Write booleans and numbers as actual JSON types; config buyer set treats CLI values as strings.
  configureFreeOnlyRouting();

  // Runtime flags are a hard cap, independent of seller/routing preferences.
  buyerProcess = spawn(ANTSEED_BIN, [
    'buyer',
    'start',
    '--max-input-usd-per-million',
    '0',
    '--max-output-usd-per-million',
    '0',
  ], {
    stdio: 'inherit',
    env: process.env,
  });

  buyerProcess.once('error', err => {
    console.error('Could not start AntSeed buyer:', err);
    process.exit(1);
  });
  buyerProcess.once('exit', (code, signal) => {
    console.error('AntSeed buyer exited (code=' + code + ', signal=' + signal + '); stopping web service.');
    process.exit(code === 0 ? 1 : (code || 1));
  });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (await buyerHealthCheck()) {
      buyerReady = true;
      console.log('AntSeed buyer is ready on 127.0.0.1:8377');
      return;
    }
    await sleep(2000);
  }
  console.error('AntSeed buyer did not become ready within 180 seconds. Check deployment logs.');
}

startBuyer().catch(err => {
  console.error('AntSeed startup failed:', err);
  process.exit(1);
});

function shutdown() {
  buyerReady = false;
  if (buyerProcess && buyerProcess.exitCode === null) buyerProcess.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
