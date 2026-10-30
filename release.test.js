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

test('installed Audrey exposes owner-controlled native safety notifications', () => {
  const manifest = JSON.parse(fs.readFileSync(__dirname + '/manifest.webmanifest', 'utf8'));
  const serviceWorker = fs.readFileSync(__dirname + '/sw.js', 'utf8');
  assert.equal(manifest.display, 'standalone');
  assert.match(source, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(source, /Safety notifications/);
  assert.match(source, /Notification\.requestPermission\(\)/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /notificationclick/);
});
