const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/../marine-backend/LocalIntelligence.js', 'utf8');

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

const context = {};
vm.createContext(context);
vm.runInContext([
  'categoriseDoPlace_', 'groupDoPlace_', 'doRateValue_',
  'isReligiousDoPlace_', 'isStrongDoMustSee_', 'scoreDoPlace_',
  'selectDiverseDoPlaces_', 'isSouthTyrolDoCoords_',
  'selectOpenDataHubOccurrence_', 'normaliseDoEventTime_',
  'localisedDoValue_', 'localisedDoName_', 'firstHttpsDoUrl_',
  'categoriseOpenDataHubEvent_', 'trimDoSummary_', 'haversineDoKm_',
  'normaliseOpenDataHubEvent_'
].map(functionSource).join('\n'), context);

function place(name, kinds, distanceKm, rate, extras = {}) {
  const category = context.categoriseDoPlace_(kinds, {});
  const candidate = {
    name, kinds, distanceKm, rate: String(rate), category,
    group: context.groupDoPlace_(kinds, {}), summary: extras.summary || '',
    image: null, wikidataId: extras.wikidataId || null,
    sources: {opentripmap: true, osm: false, wikimedia: !!extras.wikidataId},
    osm: {}, nearby: {}, access: {level: 'easy'}
  };
  candidate.score = context.scoreDoPlace_(candidate);
  return candidate;
}

test('Boston Spa ranking suppresses churches and favours close food and drink', () => {
  const candidates = [
    place('Boston Spa Methodist Church', 'architecture,churches,religion', 0.1, 3, {summary: 'Listed church', wikidataId: 'Q1'}),
    place('Local History Landmark', 'historic,monuments', 0.8, 3, {summary: 'A genuinely notable local landmark', wikidataId: 'Q2'}),
    place('The Crown', 'foods,pubs', 0.2, 1),
    place('High Street Kitchen', 'foods,restaurants', 0.4, 1),
    place('Village Coffee', 'foods,cafes', 0.6, 1),
    place('The Red Lion Bramham', 'foods,pubs', 2.8, 2),
    place('Riverside Walk', 'natural,interesting_places', 0.7, 2)
  ].sort((a, b) => b.score - a.score);

  const selected = context.selectDiverseDoPlaces_(candidates, 5);
  const names = selected.map(item => item.name);
  assert.ok(names.includes('Local History Landmark'));
  assert.ok(names.includes('The Crown'));
  assert.ok(names.includes('High Street Kitchen'));
  assert.ok(names.includes('Village Coffee'));
  assert.ok(!names.includes('Boston Spa Methodist Church'));
  assert.ok(!names.includes('The Red Lion Bramham'));
});

test('South Tyrol event coverage includes Alta Badia but excludes unrelated trips', () => {
  assert.equal(context.isSouthTyrolDoCoords_({lat: 46.57, lon: 11.93}), true);
  assert.equal(context.isSouthTyrolDoCoords_({lat: 53.91, lon: -1.35}), false);
  assert.equal(context.isSouthTyrolDoCoords_({lat: 45.41, lon: 6.63}), false);
});

test('Open Data Hub events use the first live occurrence inside the stay window', () => {
  const occurrence = context.selectOpenDataHubOccurrence_([
    {From: '2027-01-10T00:00:00', To: '2027-01-10T00:00:00', Begin: '09:00:00', End: '10:00:00'},
    {From: '2027-01-23T00:00:00', To: '2027-01-23T00:00:00', Begin: '18:30:00', End: '20:00:00', Cancelled: '1'},
    {From: '2027-01-24T00:00:00', To: '2027-01-24T00:00:00', Begin: '17:00:00', End: '19:00:00', IsBookable: true}
  ], {from: '2027-01-22', to: '2027-01-28'});
  assert.deepEqual(JSON.parse(JSON.stringify(occurrence)), {
    start: '2027-01-24T17:00:00', end: '2027-01-24T19:00:00',
    date: '2027-01-24', time: '17:00', bookable: true
  });
});

test('Open Data Hub event response is normalized for Audrey', () => {
  const event = context.normaliseOpenDataHubEvent_({
    Id: 'event-1', Shortname: 'Mountain food evening', Latitude: 46.58, Longitude: 11.94,
    Detail: {en: {Title: 'Mountain food evening', BaseText: 'Taste local dishes.'}},
    ContactInfos: {en: {City: 'San Cassiano', Url: 'https://example.test/event'}},
    LocationInfo: {RegionInfo: {Name: {en: 'Dolomites Region Alta Badia'}}, DistrictInfo: {Name: {en: 'San Cassiano'}}},
    ODHTags: [{Id: 'genuss-events'}], EventProperty: {TicketRequired: true},
    EventDate: [{From: '2027-01-24T00:00:00', To: '2027-01-24T00:00:00', Begin: '18:00:00', End: '21:00:00'}]
  }, {lat: 46.57, lon: 11.93}, {from: '2027-01-22', to: '2027-01-28'});
  assert.equal(event.title, 'Mountain food evening');
  assert.equal(event.category, 'food');
  assert.equal(event.location, 'San Cassiano');
  assert.equal(event.date, '2027-01-24');
  assert.equal(event.time, '18:00');
  assert.equal(event.ticketRequired, true);
  assert.equal(event.url, 'https://example.test/event');
  assert.ok(event.distanceKm > 0);
});

test('architecture alone is not labelled must see', () => {
  assert.equal(context.groupDoPlace_('architecture,churches', {}), 'other');
  assert.equal(context.isReligiousDoPlace_(place('St Mary Church', 'architecture,churches', 0.2, 3)), true);
});
