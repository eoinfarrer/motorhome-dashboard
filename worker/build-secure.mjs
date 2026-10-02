import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(workerDir, '..');
const output = path.join(root, 'dist-secure');

await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});

const source = await readFile(path.join(root, 'index.html'), 'utf8');
const publicApi = /var API_URL='https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec';/;
if (!publicApi.test(source)) {
  throw new Error('The public Apps Script URL declaration could not be found');
}

const secure = source.replace(publicApi, "var API_URL='/api';");
await writeFile(path.join(output, 'index.html'), secure);
await cp(path.join(root, 'assets'), path.join(output, 'assets'), {recursive: true});
await writeFile(path.join(output, '_headers'), [
  '/*',
  '  Cache-Control: no-store',
  '  Referrer-Policy: no-referrer',
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  ''
].join('\n'));

console.log('Secure Audrey assets built in dist-secure');
