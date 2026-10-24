const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(__dirname + '/index.html', 'utf8');

test('legacy GitHub Pages visitors are transferred to the protected Audrey domain', () => {
  assert.match(source, /location\.hostname==='eoinfarrer\.github\.io'/);
  assert.match(source, /location\.replace\('https:\/\/audrey\.eoinfarrer\.uk\/'/);
});

test('Audrey Travel OS 1.0 is the formal installed product identity', () => {
  assert.match(source, /<title>Audrey Travel OS<\/title>/);
  assert.match(source, /apple-mobile-web-app-title" content="Audrey Travel OS"/);
  assert.match(source, /<div class="product-edition">Travel OS<br>1\.0<\/div>/);
});
