'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const root = path.join(__dirname, '..');
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const documented = new Set(
  example
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean)
);
const registered = new Set(Object.keys(config.CONFIG_REGISTRY));
const missingDocumentation = [...registered].filter((key) => !documented.has(key));
const missingRegistry = [...documented].filter((key) => !registered.has(key));

if (missingDocumentation.length || missingRegistry.length) {
  if (missingDocumentation.length) {
    console.error('Missing from .env.example:', missingDocumentation.join(', '));
  }
  if (missingRegistry.length) {
    console.error('Missing from CONFIG_REGISTRY:', missingRegistry.join(', '));
  }
  process.exit(1);
}

const publicPayload = JSON.stringify(config.publicConfig());
for (const [key, metadata] of Object.entries(config.CONFIG_REGISTRY)) {
  if (metadata.secret && publicPayload.includes(key)) {
    console.error(`Secret config key leaked through publicConfig: ${key}`);
    process.exit(1);
  }
}

console.log(`Config registry OK: ${registered.size} documented keys`);
