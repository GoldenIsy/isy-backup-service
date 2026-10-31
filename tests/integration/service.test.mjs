import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, fakeRestic, writeConfig } from '../helpers/fixture.mjs';

const cli = path.resolve('dist/cli/main.js');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for service state');
}

test('serve schedules a backup, stays healthy, and publishes orderly shutdown', async () => {
  const value = fixture();
  let child;
  try {
    const restic = fakeRestic(value);
    const port = await availablePort();
    const config = writeConfig(value, {
      tools: { restic },
      service: {
        backup_interval_seconds: 60,
        heartbeat_interval_seconds: 5,
        run_on_start: true,
        listen_address: '127.0.0.1',
        port
      }
    });
    child = spawn(process.execPath, [cli, 'serve', '--config', config], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const heartbeatFile = path.join(value.state, 'heartbeat.json');
    const heartbeat = await waitFor(() => {
      if (!fs.existsSync(heartbeatFile)) return null;
      const candidate = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
      return candidate.state === 'READY' && candidate.last_success_at ? candidate : null;
    });
    assert.equal(heartbeat.scheduler_responsive, true);
    assert.match(heartbeat.next_backup_at, /^\d{4}-/u);
    assert.equal(typeof heartbeat.target_freshness.primary, 'string');

    const health = spawnSync(process.execPath, [cli, 'status', '--healthcheck', '--config', config], { encoding: 'utf8' });
    assert.equal(health.status, 0, `${health.stdout} ${health.stderr}`);
    assert.equal(JSON.parse(health.stdout).runtime_instance_id, heartbeat.runtime_instance_id);

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scheduler_responsive, true);

    const contender = spawnSync(process.execPath, [cli, 'serve', '--config', config], { encoding: 'utf8' });
    assert.equal(contender.status, 8, `${contender.stdout} ${contender.stderr}`);
    assert.equal(JSON.parse(contender.stdout).code, 'LOCK_UNAVAILABLE');

    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    assert.deepEqual(exit, { code: 0, signal: null });
    const stopped = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
    assert.equal(stopped.state, 'STOPPING');
    assert.equal(stopped.scheduler_responsive, false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    value.cleanup();
  }
});

test('healthcheck rejects a mismatched heartbeat even when it claims responsiveness', async () => {
  const value = fixture();
  try {
    const config = writeConfig(value, {
      service: {
        backup_interval_seconds: 60,
        heartbeat_interval_seconds: 5,
        run_on_start: false,
        listen_address: '127.0.0.1',
        port: await availablePort()
      }
    });
    fs.mkdirSync(value.state, { recursive: true });
    fs.writeFileSync(path.join(value.state, 'heartbeat.json'), JSON.stringify({
      schema: 'isy.backup.heartbeat/v1',
      config_sha256: 'does-not-match',
      scheduler_responsive: true,
      observed_at: new Date().toISOString()
    }), { mode: 0o600 });
    const health = spawnSync(process.execPath, [cli, 'status', '--healthcheck', '--config', config], { encoding: 'utf8' });
    assert.equal(health.status, 3);
    assert.equal(JSON.parse(health.stdout).code, 'HEALTHCHECK_FAILED');
  } finally { value.cleanup(); }
});
