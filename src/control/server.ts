import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { EvidenceStore } from '../evidence/store.js';
import { CommandAdmissionError, type ControlCommandService, type LocalCommandAction } from './commands.js';

export interface ControlServerOptions {
  socketPath: string;
  ownerUid: number;
  groupGid: number;
  mode: string;
  maximumReceiptPageSize: number;
  maximumConnections?: number;
  evidenceStore: EvidenceStore;
  commandService?: ControlCommandService;
}

export interface ControlServerHandle {
  socketPath: string;
  close: () => Promise<void>;
}

function controlError(response: http.ServerResponse, status: number, code: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify({ schema: 'isy.backup.control-error/v1', code })}\n`);
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function singleQuery(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`duplicate ${name}`);
  return values[0] ?? null;
}

function requestHasBody(request: http.IncomingMessage): boolean {
  const length = request.headers['content-length'];
  return request.headers['transfer-encoding'] !== undefined
    || (length !== undefined && length !== '0');
}

function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024) request.destroy(new Error('body oversized'));
      else chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
  });
}

function createHandler(options: ControlServerOptions): http.RequestListener {
  return async (request, response) => {
    response.setHeader('connection', 'close');
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://local.invalid');
    } catch {
      controlError(response, 400, 'INVALID_REQUEST_TARGET');
      return;
    }
    const commandRoutes: Record<string, LocalCommandAction> = {
      '/v1/commands/backup': 'backup',
      '/v1/commands/repository-check': 'repository-check',
      '/v1/commands/read-data-check': 'read-data-check',
      '/v1/commands/restore-test': 'restore-test',
      '/v1/commands/cancel': 'cancel',
    };
    const commandAction = commandRoutes[url.pathname];
    if (commandAction) {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST'); controlError(response, 405, 'METHOD_NOT_ALLOWED'); return;
      }
      if (!options.commandService) { request.resume(); controlError(response, 404, 'ROUTE_NOT_FOUND'); return; }
      if (String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        request.resume(); controlError(response, 415, 'CONTENT_TYPE_REQUIRED'); return;
      }
      try {
        const value = await readJsonBody(request) as { action?: unknown };
        if (value?.action !== commandAction) throw new CommandAdmissionError('COMMAND_ROUTE_MISMATCH');
        sendJson(response, await options.commandService.submit(value));
      } catch (error) {
        controlError(response, error instanceof CommandAdmissionError && error.code === 'COMMAND_OUTCOME_UNKNOWN' ? 503 : 409,
          error instanceof CommandAdmissionError ? error.code : 'COMMAND_INVALID');
      }
      return;
    }
    if (requestHasBody(request)) {
      request.resume(); controlError(response, 400, 'REQUEST_BODY_FORBIDDEN'); return;
    }
    const readOnlyRoute = url.pathname === '/v1/status'
      || url.pathname === '/v1/observations/current'
      || url.pathname === '/v1/receipts'
      || /^\/v1\/operations\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(url.pathname);
    if (!readOnlyRoute) {
      controlError(response, 404, 'ROUTE_NOT_FOUND');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      controlError(response, 405, 'METHOD_NOT_ALLOWED');
      return;
    }
    try {
      if (url.pathname === '/v1/status' || url.pathname === '/v1/observations/current') {
        if ([...url.searchParams].length !== 0) throw new Error('queries are forbidden');
        const observation = options.evidenceStore.currentObservation();
        if (!observation) {
          controlError(response, 503, 'OBSERVATION_UNAVAILABLE');
          return;
        }
        sendJson(response, observation);
        return;
      }
      if (url.pathname === '/v1/receipts') {
        if ([...url.searchParams.keys()].some((key) => key !== 'after' && key !== 'limit')) {
          throw new Error('unknown receipt query');
        }
        const after = singleQuery(url, 'after');
        if (after !== null && (after.length < 1 || after.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(after))) {
          throw new Error('invalid cursor');
        }
        const rawLimit = singleQuery(url, 'limit');
        const limit = rawLimit === null ? options.maximumReceiptPageSize : Number(rawLimit);
        if (!/^\d+$/u.test(rawLimit ?? String(limit)) || !Number.isInteger(limit) || limit < 1 || limit > options.maximumReceiptPageSize) {
          throw new Error('invalid limit');
        }
        sendJson(response, options.evidenceStore.listReceipts(after, limit));
        return;
      }
      if ([...url.searchParams].length !== 0) throw new Error('queries are forbidden');
      const operationId = decodeURIComponent(url.pathname.slice('/v1/operations/'.length));
      const summary = options.evidenceStore.operation(operationId);
      if (!summary) {
        controlError(response, 404, 'OPERATION_NOT_FOUND');
        return;
      }
      sendJson(response, summary);
    } catch {
      controlError(response, 400, 'INVALID_REQUEST');
    }
  };
}

function validateSocketParent(socketPath: string, ownerUid: number): void {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) {
    throw new Error('control socket path must be an absolute Unix path of at most 100 bytes');
  }
  const parent = path.dirname(socketPath);
  const stat = fs.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) {
    throw new Error('control socket parent has unsafe ownership or permissions');
  }
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function prepareFinalSocket(socketPath: string, ownerUid: number, groupGid: number, mode: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    stat.isSymbolicLink()
    || !stat.isSocket()
    || stat.uid !== ownerUid
    || stat.gid !== groupGid
    || (stat.mode & 0o777) !== mode
  ) {
    throw new Error('control socket refuses unsafe pre-existing collision or permission');
  }
  fs.unlinkSync(socketPath);
}

function listen(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startControlServer(options: ControlServerOptions): Promise<ControlServerHandle> {
  const mode = Number.parseInt(options.mode, 8);
  if (!/^0[0-7]{3}$/u.test(options.mode) || mode > 0o660 || (mode & 0o006) !== 0) {
    throw new Error('control socket mode is invalid or permissive');
  }
  if (!Number.isInteger(options.maximumReceiptPageSize) || options.maximumReceiptPageSize < 1 || options.maximumReceiptPageSize > 100) {
    throw new Error('maximum receipt page size must be between 1 and 100');
  }
  validateSocketParent(options.socketPath, options.ownerUid);
  prepareFinalSocket(options.socketPath, options.ownerUid, options.groupGid, mode);
  const temporary = `${options.socketPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (Buffer.byteLength(temporary) > 107) throw new Error('control socket path leaves no room for atomic temporary name');
  const server = http.createServer(createHandler(options));
  server.maxConnections = options.maximumConnections ?? 16;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  try {
    await listen(server, temporary);
    fs.chmodSync(temporary, mode);
    const temporaryStat = fs.lstatSync(temporary);
    if (temporaryStat.uid !== options.ownerUid || temporaryStat.gid !== options.groupGid) {
      fs.chownSync(temporary, options.ownerUid, options.groupGid);
    }
    if (pathEntryExists(options.socketPath)) throw new Error('control socket collision appeared during startup');
    fs.renameSync(temporary, options.socketPath);
    const socketStat = fs.lstatSync(options.socketPath);
    if (!socketStat.isSocket() || socketStat.uid !== options.ownerUid || socketStat.gid !== options.groupGid || (socketStat.mode & 0o777) !== mode) {
      throw new Error('control socket identity verification failed');
    }
    const identity = { dev: socketStat.dev, ino: socketStat.ino };
    let closed = false;
    return {
      socketPath: options.socketPath,
      close: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await closeServer(server);
        if (pathEntryExists(options.socketPath)) {
          const current = fs.lstatSync(options.socketPath);
          if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(options.socketPath);
        }
      },
    };
  } catch (error) {
    if (server.listening) await closeServer(server).catch(() => undefined);
    if (pathEntryExists(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}
