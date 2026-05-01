const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, '..'),
  serverExternalPackages: ['better-sqlite3'],
  webpack(config) {
    // Server actions in app/actions.ts pull in code from ../../src/ (the
    // Convoy core, which is ESM and imports siblings with `.js` suffixes
    // per Node's ESM rules). web/tsconfig.json uses moduleResolution:
    // Bundler so tsc resolves those .js paths to the underlying .ts file,
    // but Next's webpack action-entry loader doesn't honor that — it asks
    // the filesystem for a literal `.js` file and fails. extensionAlias
    // tells webpack to try `.ts`/`.tsx` whenever a `.js` resolution misses.
    // Without this, /plans/[id] returned 500 the moment new server actions
    // were added: "Can't resolve '../../src/adapters/connections.js'".
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

module.exports = nextConfig;
