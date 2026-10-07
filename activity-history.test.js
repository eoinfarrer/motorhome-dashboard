const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/index.html', 'utf8');

function functionSource(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unterminated function ' + name);
}

const context = {
  Date,
  Number,
  String,
  Math,
  escapeDoHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  fmtDuration: minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`,
  fmtDate: value => value
};
vm.createContext(context);
vm.runInContext([
  functionSource('formatActivityNumber'),
  functionSource('activityMetricParts'),
  functionSource('activityIcon'),
  functionSource('buildHomeActivityCard'),
  functionSource('buildJourneyActivityPoint'),
  functionSource('buildMoreActivityHistory')
].join('\n'), context);

test('Home presents a completed padel session without meaningless zero distance', () => {
  const html = context.buildHomeActivityCard([{
    name: 'Evening Padel', sportType: 'Padel', distanceKm: 0, movingMinutes: 72, elevationM: 0
  }]);

  assert.match(html, /Completed today/);
  assert.match(html, /Evening Padel/);
  assert.match(html, /1h 12m/);
  assert.doesNotMatch(html, /0 km/);
});

test('Journey activity safely renders metrics, location and Strava link', () => {
  const html = context.buildJourneyActivityPoint({
    name: '<Coast ride>', sportType: 'Ride', tripLocation: 'White Rocks Hotel',
    distanceKm: 42.6, movingMinutes: 138, elevationM: 780,
    url: 'https://www.strava.com/activities/123'
  });

  assert.match(html, /&lt;Coast ride&gt;/);
  assert.match(html, /42.6 km/);
  assert.match(html, /2h 18m/);
  assert.match(html, /780m climbing/);
  assert.match(html, /White Rocks Hotel/);
});

test('More shows import status and activity history', () => {
  const html = context.buildMoreActivityHistory({
    sync: {count: 12, lastSync: '2026-10-01T15:00:00Z'},
    items: [{name: 'Morning hike', sportType: 'Hike', category: 'Walking & hiking', date: '2026-09-30', movingMinutes: 90}]
  });

  assert.match(html, /12 imported/);
  assert.match(html, /Morning hike/);
  assert.match(html, /Walking &amp; hiking/);
  assert.match(html, /^<details class="more-activity-panel">/);
  assert.doesNotMatch(html, /<details[^>]+open/);
});

test('More limits the collapsible history to the latest 20 activities', () => {
  const items = Array.from({length: 25}, (_, index) => ({
    name: `Activity ${index + 1}`,
    sportType: 'Ride',
    date: `2026-09-${String(30 - index).padStart(2, '0')}`
  }));
  const html = context.buildMoreActivityHistory({sync: {count: 25}, items});

  assert.equal((html.match(/class="more-activity-row"/g) || []).length, 20);
  assert.match(html, /Activity 20/);
  assert.doesNotMatch(html, /Activity 21/);
});

test('Journey inserts the Daily Story once after the final itinerary row for that day', () => {
  const tripContext = {
    Date,
    Object,
    Number,
    buildJourneyTripPoint: row => '<stop>' + row.location + '</stop>',
    buildDailyStoryPoint: (data, date) => '<story>' + date + ':' + data.activities.tripItems[0].name + '</story>',
    journeyOverview: () => '',
  };
  vm.createContext(tripContext);
  vm.runInContext(functionSource('buildJourneyTrip'), tripContext);
  const html = tripContext.buildJourneyTrip({
    meta: {departDate: '2026-09-21', returnDate: '2026-09-22'},
    itinerary: [
      {date: '2026-09-21', type: 'FLIGHT', location: 'Kefalonia Airport'},
      {date: '2026-09-21', type: 'STAY', location: 'White Rocks Hotel'},
      {date: '2026-09-22', type: 'STAY', location: 'White Rocks Hotel'}
    ],
    activities: {tripItems: [{tripDate: '2026-09-21', name: 'Evening walk'}]}
  });

  assert.equal((html.match(/<story>/g) || []).length, 2);
  assert.ok(html.indexOf('White Rocks Hotel</stop><story>2026-09-21:Evening walk') > -1);
});
