'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = Number(process.env.PORT || 10000);
const API_TOKEN = process.env.API_TOKEN;
const ANTSEED_BIN = path.join(__dirname, 'node_modules', '.bin', 'antseed');
const BUYER_PORT = 8377;

if (!API_TOKEN || API_TOKEN.length < 24) {
  console.error('Set API_TOKEN in Render Environment to a random secret of at least 24 characters.');
  process.exit(1);
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
  res.status(buyerReady ? 200 : 503).json({
    ok: buyerReady,
    service: 'antseed-render-api',
    buyer: buyerReady ? 'ready' : 'starting',
  });
});

app.use((req, res, next) => {
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

// Do not parse the request body before proxying; streaming completions must pass through.
app.use('/', createProxyMiddleware({
  target: 'http://127.0.0.1:' + BUYER_PORT,
  changeOrigin: false,
  proxyTimeout: 300000,
  timeout: 300000,
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
  // Hard price caps, not just a routing preference: zero-priced sellers only.
  await runCli(['config', 'init']);
  await runCli(['config', 'buyer', 'set', 'routingPreferences.preferFreePeers', 'true']);
  await runCli(['config', 'buyer', 'set', 'maxPricing.defaults.inputUsdPerMillion', '0']);
  await runCli(['config', 'buyer', 'set', 'maxPricing.defaults.outputUsdPerMillion', '0']);

  const buyerEnv = {
    ...process.env,
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '0',
    ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION: '0',
  };

  buyerProcess = spawn(ANTSEED_BIN, ['buyer', 'start'], {
    stdio: 'inherit',
    env: buyerEnv,
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
  console.error('AntSeed buyer did not become ready within 180 seconds. Check Render logs.');
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
