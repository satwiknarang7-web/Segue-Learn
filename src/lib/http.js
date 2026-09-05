import fsp from 'node:fs/promises';
import path from 'node:path';

import { payloadTooLarge, badRequest } from './errors.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': buffer.length, ...headers });
  res.end(buffer);
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

/** Read and parse a JSON request body, refusing anything oversized. */
export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw payloadTooLarge('Request body is too large.');
    chunks.push(chunk);
  }

  if (size === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
}

/**
 * Serve a file from the public directory.
 * Returns false when the path does not resolve to a real file, so the
 * caller can fall through to its own 404 handling.
 */
export async function serveStaticFile(res, publicDir, requestPath) {
  const relativePath = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, relativePath);

  // Refuse anything that escapes the public directory.
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return false;

  // Pages are only reachable through their routes, which is where the
  // organiser check lives. Serving editor.html directly would hand a
  // participant the editor shell and route around that check.
  if (resolved.toLowerCase().endsWith('.html')) return false;

  try {
    const stats = await fsp.stat(resolved);
    if (!stats.isFile()) return false;

    const body = await fsp.readFile(resolved);
    const extension = path.extname(resolved).toLowerCase();
    // App code is revalidated every time; only static assets are cached, so
    // an edit to the CSS or a script is never served stale.
    const isAppCode = ['.html', '.css', '.js'].includes(extension);
    send(res, 200, body, {
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': isAppCode ? 'no-cache' : 'public, max-age=300',
    });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Serve one specific HTML page (used for pretty routes like /take/ABC123). */
export async function sendHtmlPage(res, publicDir, fileName) {
  const body = await fsp.readFile(path.join(publicDir, fileName));
  send(res, 200, body, {
    'Content-Type': CONTENT_TYPES['.html'],
    'Cache-Control': 'no-cache',
  });
}
