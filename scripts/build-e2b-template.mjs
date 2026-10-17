#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Template } from 'e2b';

if (!process.env.E2B_API_KEY) {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
}
if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required');

const template = Template({ fileContextPath: fileURLToPath(new URL('..', import.meta.url)) })
  .fromNodeImage('22')
  .copy('src/tools-cli.mjs', '/opt/coke/tools-cli.mjs')
  .copy('src/workspace-cli.mjs', '/opt/coke/workspace-cli.mjs');

const build = await Template.build(template, 'coke-task-cli:v3', {
  onBuildLogs: entry => {
    if (entry.message) process.stderr.write(`${entry.message}\n`);
  },
});
process.stdout.write(`${JSON.stringify({ template: build.name, templateId: build.templateId })}\n`);
