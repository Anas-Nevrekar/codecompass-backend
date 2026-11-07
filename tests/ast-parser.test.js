import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, languageForExtension } from '../src/services/ast-parser.service.js';

test('extracts JavaScript declarations with exact text and one-based line ranges', () => {
  const source = "import { readFile } from 'node:fs';\nconst answer = 42;\nconst greet = (name) => name;\nasync function load() {}\nclass Store { save() {} }";
  const result = parseSource(source, '.js');
  assert.equal(result.supported, true);
  assert.deepEqual(result.chunks.map((chunk) => chunk.structureType), ['import', 'variable', 'variable', 'function', 'function', 'class', 'function']);
  assert.equal(result.chunks[0].metadata.moduleName, 'node:fs');
  assert.equal(result.chunks[1].symbolName, 'answer');
  assert.equal(result.chunks[1].source, 'const answer = 42;');
  assert.equal(result.chunks[2].symbolName, 'greet');
  assert.equal(result.chunks[3].symbolName, 'greet');
  assert.equal(result.chunks[4].symbolName, 'load');
  assert.equal(result.chunks[6].symbolName, 'save');
  assert.equal(result.chunks[6].startLine, 5);
  assert.equal(result.chunks[6].endLine, 5);
});

test('extracts TypeScript and Python structures and recovers malformed input', () => {
  const ts = parseSource('export function run(): void {}\nconst n: number = 1;', '.ts');
  assert.deepEqual(ts.chunks.map((chunk) => chunk.structureType), ['function', 'variable']);
  assert.equal(ts.chunks[0].symbolName, 'run');
  const py = parseSource('import os\n\ndef work():\n    return 1\n\nclass Box:\n    def open(self):\n        pass', '.py');
  assert.ok(py.chunks.some((chunk) => chunk.structureType === 'import'));
  assert.ok(py.chunks.some((chunk) => chunk.symbolName === 'Box'));
  assert.ok(py.chunks.some((chunk) => chunk.symbolName === 'open'));
  assert.doesNotThrow(() => parseSource('function broken( {', '.js'));
  assert.equal(parseSource('', '.py').chunks.length, 0);
});

test('extracts literal CommonJS require dependencies from parsed JavaScript declarations', () => {
  const result = parseSource("const User = require('../models/User');\nconst { createOrder } = require('../services/orders');", '.js');
  const variables = result.chunks.filter((chunk) => chunk.structureType === 'variable');
  assert.deepEqual(variables.map((chunk) => chunk.metadata.moduleNames), [['../models/User'], ['../services/orders']]);
  assert.ok(variables.every((chunk) => chunk.metadata.importKind === 'commonjs-require'));
});

test('unsupported extensions are skipped', () => {
  assert.equal(languageForExtension('.md'), null);
  assert.deepEqual(parseSource('# heading', '.md'), { supported: false, chunks: [], hasErrors: false });
});
