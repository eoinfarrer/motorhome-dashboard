const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');
const backend = fs.readFileSync(__dirname + '/../marine-backend/SnowStatus.js', 'utf8');

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

const context = {URL};
vm.createContext(context);
vm.runInContext([
  functionSource(frontend, 'escapeDoHtml'),
  functionSource(frontend, 'safeDoUrl'),
  functionSource(frontend, 'getDoStayLocation'),
  functionSource(frontend, 'winterMobilityDestinations_'),
  functionSource(frontend, 'findWinterPass_'),
  functionSource(frontend, 'assessWinterPass_'),
  functionSource(frontend, 'buildExploreFromHere')
].join('\n'), context);

test('Explore from here is anchored to the active stay rather than vehicle telemetry', () => {
  const data = {
    meta: {currentLocation: 'Boston Spa'},
    itinerary: [
      {isToday: true, type: 'FLIGHT', location: 'Innsbruck Airport'},
      {isToday: true, type: 'STAY', location: 'Alta Badia'}
    ],
    vehicle: {locationLabel: 'Boston Spa'}
  };
  assert.equal(context.getDoStayLocation(data), 'Alta Badia');
});

test('rental car profile ignores trailer-only restrictions but respects closures', () => {
  const trailer = context.assessWinterPass_({
    status: '🟠 Restricted',
    detail: 'Fahrverbot für alle Fahrzeuge mit Anhänger.'
  }, 'rental-car');
  assert.equal(trailer.level, 'go');
  assert.equal(trailer.label, 'OPEN FOR CAR');

  const closed = context.assessWinterPass_({
    status: '❌ Closed',
    detail: 'Wintersperre.'
  }, 'rental-car');
  assert.equal(closed.level, 'danger');
});

test('motorhome profile retains official vehicle restrictions', () => {
  const result = context.assessWinterPass_({
    status: '🟠 Restricted',
    detail: 'Fahrverbot für Fahrzeuge mit einer Länge über 12 m.'
  }, 'motorhome');
  assert.equal(result.level, 'caution');
  assert.equal(result.label, 'RESTRICTIONS');
});

test('Alta Badia winter board offers ad hoc valleys without itinerary drives', () => {
  const passes = [
    {name: 'Gardena Pass', status: '✅ Open', updated: '2026-12-15 08:00'},
    {name: 'Campolongo Pass', status: '✅ Open', updated: '2026-12-15 08:00'},
    {name: 'Falzarego Pass', status: '✅ Open', updated: '2026-12-15 08:00'},
    {name: 'Valparola Pass', status: '✅ Open', updated: '2026-12-15 08:00'},
    {name: 'Pordoi Pass', status: '❌ Closed', updated: '2026-12-15 08:00'},
    {name: 'Furkel Pass', status: '✅ Open', updated: '2026-12-15 08:00'},
    {name: 'Sella Pass', status: '✅ Open', updated: '2026-12-15 08:00'}
  ];
  const html = context.buildExploreFromHere({
    meta: {season: 'winter', currentLocation: 'Alta Badia', vehicleRelevant: false},
    snowStatus: {passes}
  });
  assert.match(html, /Explore from here/);
  assert.match(html, /Day trips from Alta Badia/);
  assert.match(html, /Rental car · winter tyres/);
  assert.match(html, /Cortina d’Ampezzo/);
  assert.match(html, /Val di Fassa/);
  assert.match(html, /CLOSED/);
  assert.doesNotMatch(html, /next drive/i);
});

test('official feed classifier distinguishes open, restricted and closed passes', () => {
  const classifierContext = {};
  vm.createContext(classifierContext);
  vm.runInContext(functionSource(backend, 'classifyOfficialPassStatus_'), classifierContext);
  assert.equal(classifierContext.classifyOfficialPassStatus_('Keine Beschränkungen.'), '✅ Open');
  assert.equal(classifierContext.classifyOfficialPassStatus_('Fahrverbot für Fahrzeuge mit Anhänger.'), '🟠 Restricted');
  assert.equal(classifierContext.classifyOfficialPassStatus_('Wintersperre.'), '❌ Closed');
});
