#!/usr/bin/env node
/** Serve the loopback dashboard and its JSON API using the shared board database. */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoard, parseArguments } from './board.mjs';

/** Read a JSON object from an HTTP request, rejecting bodies larger than 64 KiB. */
const readJson = async request => {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error('Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Invalid JSON');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a JSON object');
  return result;
};

/**
 * Open a board from an optional config path and serve it on 127.0.0.1.
 * requestedPort overrides web.port; return the listening http.Server.
 * Closing the server closes its database; dashboard writes use the user identity.
 */
export async function startServer(configPath, requestedPort) {
  const board = await createBoard(configPath);
  const port = Number(requestedPort ?? board.config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    board.close();
    throw new Error('Port must be an integer from 1 to 65535');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(18).toString('hex');
  // The page and write API share a per-server token; the nonce authorizes its script.
  const html = fs.readFileSync(new URL('./web.html', import.meta.url), 'utf8')
    .replaceAll('__BOARD_TOKEN__', token)
    .replaceAll('__SCRIPT_NONCE__', nonce);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  const user = { handle: 'user', runtime: 'web' };
  const respond = (response, status, body, type = 'application/json; charset=utf-8') => {
    if (response.destroyed) return;
    response.writeHead(status, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  let pending = Promise.resolve();
  const server = http.createServer((request, response) => {
    const handle = async () => {
      if (!hosts.has(request.headers.host)) return respond(response, 403, { error: 'Invalid Host header' });
      if (request.headers.origin && !origins.has(request.headers.origin)) return respond(response, 403, { error: 'Invalid request origin' });
      try {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (request.method === 'GET' && url.pathname === '/') {
          return respond(response, 200, html, 'text/html; charset=utf-8');
        }
        if (request.method === 'GET' && url.pathname === '/api/snapshot') {
          return respond(response, 200, await board.snapshot());
        }
        if (request.method !== 'POST') return respond(response, 404, { error: 'Not found' });
        if (request.headers['x-board-token'] !== token) return respond(response, 403, { error: 'Invalid token; reload the page' });
        if (!request.headers['content-type']?.startsWith('application/json')) return respond(response, 415, { error: 'Use application/json' });
        const body = await readJson(request);
        board.discovered = null;
        board.processes = null;
        if (url.pathname === '/api/send') {
          const results = await board.sendMessage(user, body.to, body.body, { quiet: body.quiet === true, push: body.push === true });
          if (body.replyTo != null) board.markRead('user', [body.replyTo]);
          return respond(response, 200, { lines: results.map(result => result.line) });
        }
        if (url.pathname === '/api/decide') {
          const line = await board.decide(user, body.id, body.status, String(body.note || '').trim());
          return respond(response, 200, { line });
        }
        if (url.pathname === '/api/read') {
          if (!Array.isArray(body.ids)) throw new Error('ids must be an array');
          board.markRead('user', body.ids);
          return respond(response, 200, { ok: true });
        }
        return respond(response, 404, { error: 'Not found' });
      } catch (error) {
        respond(response, 400, { error: error.message });
      }
    };
    // Serialize requests so asynchronous delivery cannot interleave board operations.
    pending = pending.then(handle).catch(error => respond(response, 500, { error: error.message }));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('close', () => board.close());
  await new Promise((resolve, reject) => {
    const failed = error => {
      board.close();
      reject(error);
    };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', failed);
      resolve();
    });
  });
  server.on('error', error => console.error(error.message));
  console.log(`Dashboard: http://127.0.0.1:${port}/ (local access only; Ctrl+C to stop)`);
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const run = async () => {
    const { options, positionals } = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node web.mjs [--config path] [--port 8790]\nServe the local dashboard in the foreground. Requires Node.js 22.13+. Ctrl+C stops it.');
      return;
    }
    if (positionals.length) throw new Error('Unexpected argument; use --help');
    await startServer(options.config, options.port);
  };
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
