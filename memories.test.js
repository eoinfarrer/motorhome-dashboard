const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');

test('Moments uses one Home-only heart action and retains the dedicated deep link', () => {
  assert.match(frontend, /id="momentFab"/);
  assert.match(frontend, /classList\.toggle\('is-ready',currentAppView==='home'/);
  assert.doesNotMatch(frontend, /function buildHomeMoments/);
  assert.match(frontend, /get\('capture'\)==='moment'/);
});

test('Moment capture requests phone GPS but preserves an itinerary fallback', () => {
  assert.match(frontend, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(frontend, /currentLocationCoords/);
  assert.match(frontend, /Trip location fallback/);
});

test('Moment save carries trip, weather and activity context automatically', () => {
  assert.match(frontend, /action:'save_memory'/);
  assert.match(frontend, /tripName:currentData\.meta/);
  assert.match(frontend, /weatherSummary:currentMomentWeather\(\)/);
  assert.match(frontend, /activityId:activity&&activity\.id/);
});
