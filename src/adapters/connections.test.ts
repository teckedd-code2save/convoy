import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPlatformConnectionProbe } from './connections.js';

test('all platform probes report missing CLI state consistently', async () => {
  const probe = createPlatformConnectionProbe({
    runCommand: async (cmd) => ({ ok: false, stdout: '', stderr: `${cmd} missing` }),
    flyctlAvailable: async () => false,
    flyAuthStatus: async () => ({ ok: false }),
    flyAppExists: async () => false,
    vercelAvailable: async () => false,
    vercelAuthStatus: async () => ({ ok: false }),
    vercelProjectInfo: async () => null,
  });

  const [fly, vercel, railway, cloudrun] = await Promise.all([
    probe('fly', '/tmp'),
    probe('vercel', '/tmp'),
    probe('railway', '/tmp'),
    probe('cloudrun', '/tmp'),
  ]);

  for (const status of [fly, vercel, railway, cloudrun]) {
    assert.equal(status.cliAvailable, false);
    assert.equal(status.authenticated, false);
    assert.equal(status.projectLinked, false);
    assert.equal(status.rollbackReady, false);
    assert.equal(status.envKeys.length, 0);
    assert.equal(typeof status.recommendedRemedy, 'string');
  }
});

test('railway probe parses linked project, environment, service, and env keys', async () => {
  const probe = createPlatformConnectionProbe({
    runCommand: async (_cmd, args) => {
      const joined = args.join(' ');
      if (joined === '--version') return { ok: true, stdout: 'railway 4.0.0', stderr: '' };
      if (joined === 'whoami') return { ok: true, stdout: 'operator@example.com\n', stderr: '' };
      if (joined === 'status --json') {
        return {
          ok: true,
          stdout: JSON.stringify({
            project: { name: 'platform' },
            environment: { name: 'production' },
            service: { name: 'api' },
          }),
          stderr: '',
        };
      }
      if (joined.startsWith('variables list --json')) {
        return {
          ok: true,
          stdout: JSON.stringify([{ name: 'DATABASE_URL' }, { key: 'REDIS_URL' }]),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${joined}`);
    },
  });

  const status = await probe('railway', '/tmp');

  assert.equal(status.cliAvailable, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.projectLinked, true);
  assert.equal(status.projectBinding, 'platform/production/api');
  assert.deepEqual(status.envKeys, ['DATABASE_URL', 'REDIS_URL']);
  assert.deepEqual(status.raw, {
    project: 'platform',
    environment: 'production',
    service: 'api',
  });
});

test('cloudrun probe infers service binding and env keys from cloudbuild and gcloud describe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'convoy-cloudrun-'));
  try {
    write(dir, 'cloudbuild.yaml', `steps:
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - api-service
      - --region=us-central1
`);

    const probe = createPlatformConnectionProbe({
      runCommand: async (_cmd, args) => {
        const joined = args.join(' ');
        if (joined === 'version --format=json') return { ok: true, stdout: '{}', stderr: '' };
        if (joined === 'auth list --filter=status:ACTIVE --format=value(account)') {
          return { ok: true, stdout: 'operator@example.com\n', stderr: '' };
        }
        if (joined === 'config get-value project') return { ok: true, stdout: 'demo-project\n', stderr: '' };
        if (joined === 'run services describe api-service --region us-central1 --format=json') {
          return {
            ok: true,
            stdout: JSON.stringify({
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        env: [{ name: 'DATABASE_URL' }, { name: 'NEXT_PUBLIC_API_URL' }],
                      },
                    ],
                  },
                },
              },
            }),
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${joined}`);
      },
    });

    const status = await probe('cloudrun', dir);

    assert.equal(status.cliAvailable, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.projectLinked, true);
    assert.equal(status.projectBinding, 'demo-project/api-service (us-central1)');
    assert.deepEqual(status.envKeys, ['DATABASE_URL', 'NEXT_PUBLIC_API_URL']);
    assert.deepEqual(status.raw, {
      project: 'demo-project',
      service: 'api-service',
      region: 'us-central1',
      serviceDescribeOk: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, relPath: string, content: string): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}
