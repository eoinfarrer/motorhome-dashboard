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
context.currentDoDayMode = 'ski';
context.currentDoPlaceContext = 'now';
vm.createContext(context);
vm.runInContext([
  functionSource(frontend, 'escapeDoHtml'),
  functionSource(frontend, 'safeDoUrl'),
  functionSource(frontend, 'isSkiSeason'),
  functionSource(frontend, 'isSkiTrip'),
  functionSource(frontend, 'getDoStayLocation'),
  functionSource(frontend, 'buildDoLocalOpportunities'),
  functionSource(frontend, 'buildDoDayModeSwitch'),
  functionSource(frontend, 'formatDoEventDate_'),
  functionSource(frontend, 'buildDoLocalEvent'),
  functionSource(frontend, 'buildDoOpportunities'),
  functionSource(frontend, 'winterMobilityDestinations_'),
  functionSource(frontend, 'findWinterPass_'),
  functionSource(frontend, 'translateWinterPassDetail_'),
  functionSource(frontend, 'winterPassRestrictionApplies_'),
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

test('8m motorhome ignores restrictions for vehicles over 12m', () => {
  const result = context.assessWinterPass_({
    status: '🟠 Restricted',
    detail: 'Fahrverbot für Fahrzeuge mit einer Länge über 12 m.'
  }, 'motorhome');
  assert.equal(result.level, 'go');
  assert.equal(result.label, 'OPEN FOR 8M VAN');
  assert.match(result.copy, /vehicles over 12m are prohibited/);
  assert.match(result.copy, /does not apply/);
});

test('8m motorhome retains restrictions that actually apply', () => {
  const result = context.assessWinterPass_({
    status: '🟠 Restricted',
    detail: 'Fahrverbot für Fahrzeuge mit einer Länge über 7,5 m.'
  }, 'motorhome');
  assert.equal(result.level, 'caution');
  assert.equal(result.label, 'RESTRICTIONS');
  assert.match(result.copy, /vehicles over 7.5m are prohibited/);
});

test('current official German pass restrictions do not apply to the 8m motorhome', () => {
  [
    'Fahrverbot für alle Fahrzeuge mit Anhänger.',
    'Fahrverbot für Fahrzeuge mit einem Gewicht über 33 t.',
    'Verbot für Transporte von verunreinigenden Flüssigkeiten.',
    'Fahrverbot nur für Sattelschlepper mit einer Höhe über 3,20 m und einer Länge über 13 m.'
  ].forEach(detail => {
    const result = context.assessWinterPass_({status: '🟠 Restricted', detail}, 'motorhome');
    assert.equal(result.level, 'go', detail);
    assert.equal(result.label, 'OPEN FOR 8M VAN');
  });
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
    meta: {tripName: 'Italy Winter 2027', departDate: '2027-01-22', season: 'winter', currentLocation: 'Alta Badia', vehicleRelevant: false},
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

test('winter trips can switch to stay-based local interests for a non-ski day', () => {
  context.currentDoDayMode = 'explore';
  context.currentDoPlaceContext = 'now';
  const html = context.buildDoOpportunities({
    meta: {tripName: 'Italy Winter 2027', departDate: '2027-01-22', season: 'winter', currentLocation: 'San Cassiano'},
    itinerary: [{isToday: true, type: 'STAY', location: 'San Cassiano'}],
    snowStatus: {resorts: [{name: 'Alta Badia', isOpen: true}]}
  });
  assert.match(html, /Ski today/);
  assert.match(html, /Explore today/);
  assert.match(html, /Explore from your stay/);
  assert.match(html, /This stay/);
  assert.match(html, /id="do-local-opportunities"/);
  assert.match(html, /Happening during your stay/);
  assert.doesNotMatch(html, /Where to ski today/);
});

test('South Tyrol events render as concise links above local places', () => {
  const html = context.buildDoLocalEvent({
    title: 'Christmas market', category: 'market', date: '2027-01-24', time: '17:30',
    location: 'Corvara', distanceKm: 7.2, bookable: false,
    url: 'https://www.altabadia.org/en/alta-badia-events'
  });
  assert.match(html, /MARKET/);
  assert.match(html, /Christmas market/);
  assert.match(html, /Sun 24 Jan · 17:30/);
  assert.match(html, /Corvara/);
  assert.match(html, /7.2 km away/);
  assert.match(html, /target="_blank"/);
});

test('unknown ski regions never inherit the South Tyrol pass list', () => {
  context.currentDoDayMode = 'ski';
  const html = context.buildExploreFromHere({
    meta: {tripName: 'Three Valleys Ski', departDate: '2027-02-01', currentLocation: 'Méribel', vehicleRelevant: false},
    snowStatus: {passes: [{name: 'Gardena Pass', status: '✅ Open'}]}
  });
  assert.equal(html, '');
});

test('local-place loading remains enabled only when a ski trip selects Explore today', () => {
  assert.match(frontend, /if\(isSkiTrip\(d\)&&currentDoDayMode!==['"]explore['"]\)return/);
});

test('official feed classifier distinguishes open, restricted and closed passes', () => {
  const classifierContext = {};
  vm.createContext(classifierContext);
  vm.runInContext(functionSource(backend, 'classifyOfficialPassStatus_'), classifierContext);
  assert.equal(classifierContext.classifyOfficialPassStatus_('Keine Beschränkungen.'), '✅ Open');
  assert.equal(classifierContext.classifyOfficialPassStatus_('Fahrverbot für Fahrzeuge mit Anhänger.'), '🟠 Restricted');
  assert.equal(classifierContext.classifyOfficialPassStatus_('Wintersperre.'), '❌ Closed');
});
