const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('road cycling planners default to realistic touring speeds', () => {
  assert.match(html, /flatSpeed:type==='cycle'\?24:type==='mtb'\?15:4/);
  assert.match(html, /climbSpeed:type==='cycle'\?6:type==='mtb'\?8:2/);
  assert.match(html, /id="cyclingFlatSpeed" value="24"/);
  assert.match(html, /id="cyclingClimbSpeed" value="6"/);
});

test('road cycling analysis fallbacks use the same defaults', () => {
  assert.match(html, /flatSpeedKmh\s*=\s*flatSpeedKmh\s*\|\| 24/);
  assert.match(html, /climbSpeedKmh\s*=\s*climbSpeedKmh\s*\|\| 6/);
  assert.match(html, /cyclingFlatSpeed'\)\.value\)\s*\|\| 24/);
  assert.match(html, /cyclingClimbSpeed'\)\.value\)\s*\|\| 6/);
});
