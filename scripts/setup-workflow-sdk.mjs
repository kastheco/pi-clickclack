#!/usr/bin/env node
// Candidate-only clean local SDK staging. Never rewrites the normal SDK dependency or lock.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.versions.node, '24.20.0');
const source = resolve(process.argv[2] ?? '../clickclack.kas-769-workflow-activity/packages/sdk-ts');
assert.match(readFileSync(resolve(source, 'dist/index.d.ts'), 'utf8'), /WorkflowSnapshot/);
const target = resolve('node_modules/@clickclack/sdk-ts');
rmSync(target, { recursive: true, force: true }); // Remove the local symlink, not its target.
mkdirSync(target, { recursive: true });
cpSync(resolve(source, 'dist'), resolve(target, 'dist'), { recursive: true });
cpSync(resolve(source, 'package.json'), resolve(target, 'package.json'));
console.log('Candidate SDK copied into isolated node_modules; manifest and lock unchanged.');
