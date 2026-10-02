const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');

function functionSource(name) {
  const start = frontend.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const open = frontend.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < frontend.length; i++) {
    if (frontend[i] === '{') depth++;
    if (frontend[i] === '}' && --depth === 0) return frontend.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

const context = {};
vm.createContext(context);
vm.runInContext([
  functionSource('activityTabForRoute'),
  functionSource('trimExternalRoutesForTab'),
  functionSource('parseOsmDistanceKm'),
  functionSource('ptDist'),
  functionSource('polylineLengthDegrees'),
  functionSource('chainOrderWays')
].join('\n'), context);

test('classifies hiking and cycling route libraries into the right tab', () => {
  assert.equal(context.activityTabForRoute({activityTypes:['walking:hiking']}), 'trail');
  assert.equal(context.activityTabForRoute({activityType:'running:trail'}), 'trail');
  assert.equal(context.activityTabForRoute({activityTypes:['cycling:mountain']}), 'cycle');
  assert.equal(context.activityTabForRoute({activityType:'cycling:gravel'}), 'cycle');
});

test('trims each source to relevant routes and prioritises saved routes', () => {
  const routes = [
    {id:1, activityType:'walking:hiking', updatedAt:'2026-09-30'},
    {id:2, activityType:'cycling:road', updatedAt:'2026-10-01'},
    {id:3, activityType:'walking:hiking', updatedAt:'2026-09-01', saved:true},
    {id:4, activityType:'walking:hiking', updatedAt:'2026-09-29'}
  ];
  const result = context.trimExternalRoutesForTab(routes, 'trail', 2);
  assert.equal(result.map(route => route.id).join(','), '3,1');
  assert.equal(result.every(route => route.audreyType === 'trail'), true);
});

test('wires both authenticated route sources and their GPX actions', () => {
  assert.match(frontend, /action:'discover_ridewithgps'/);
  assert.match(frontend, /action:'discover_strava_routes'/);
  assert.match(frontend, /action: 'get_strava_route_gpx'/);
  assert.match(frontend, /trimExternalRoutesForTab\(rwData\.routes\|\|\[\],type,10\)/);
  assert.match(frontend, /trimExternalRoutesForTab\(stravaData\.routes\|\|\[\],type,10\)/);
});

test('normalises OSM route distances with common units', () => {
  assert.equal(context.parseOsmDistanceKm('12.4 km'), 12.4);
  assert.equal(context.parseOsmDistanceKm('6 mi'), 9.7);
  assert.equal(context.parseOsmDistanceKm('850 m'), 0.9);
  assert.equal(context.parseOsmDistanceKm('unknown'), null);
});

test('keeps the longest connected OSM component without adding a straight-line join', () => {
  const longest = context.chainOrderWays([
    {geometry:[{lat:0,lon:0},{lat:0,lon:1}]},
    {geometry:[{lat:0,lon:1},{lat:0,lon:2}]},
    {geometry:[{lat:10,lon:10},{lat:10,lon:10.5}]}
  ]);
  assert.equal(longest.length, 3);
  assert.equal(longest.some(point => point.lat === 10), false);
});

test('nearby OSM discovery includes superroutes, MTB and mirror fallback', () => {
  assert.match(frontend, /route\|superroute/);
  assert.match(frontend, /bicycle\|mtb/);
  assert.match(frontend, /overpass\.private\.coffee/);
  assert.match(frontend, /overpass-api\.de/);
  assert.match(frontend, /overpass\.kumi\.systems/);
});
