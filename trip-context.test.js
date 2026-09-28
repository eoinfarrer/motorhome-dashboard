const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const backend = fs.readFileSync(__dirname + '/../marine-backend/getDashboardState.js', 'utf8');
const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');

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

const backendContext = {
  formatDateISO_: date => {
    const d = new Date(date);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
};
vm.createContext(backendContext);
vm.runInContext([
  functionSource(backend, 'deriveTripTransport_'),
  functionSource(backend, 'selectCurrentItineraryRow_'),
  functionSource(backend, 'buildWeatherLocationByDate_')
].join('\n'), backendContext);

test('Kefalonia is classified as a flight trip', () => {
  assert.equal(backendContext.deriveTripTransport_([
    {type: 'DEPART'}, {type: 'DRIVE'}, {type: 'FLIGHT'}, {type: 'STAY'}
  ]), 'flight');
});

test('a road itinerary remains a motorhome trip', () => {
  assert.equal(backendContext.deriveTripTransport_([
    {type: 'DEPART'}, {type: 'FERRY'}, {type: 'DRIVE'}, {type: 'STAY'}, {type: 'RETURN'}
  ]), 'motorhome');
});

test('current location uses the final same-day destination', () => {
  const today = new Date(2026, 8, 21);
  const row = backendContext.selectCurrentItineraryRow_([
    {date: '2026-09-21', type: 'DEPART', location: 'Boston Spa'},
    {date: '2026-09-21', type: 'DRIVE', location: 'Leeds Bradford Airport'},
    {date: '2026-09-21', type: 'FLIGHT', location: 'Kefalonia Airport'},
    {date: '2026-09-21', type: 'STAY', location: 'White Rocks Hotel'}
  ], today, 'ACTIVE');
  assert.equal(row.location, 'White Rocks Hotel');
});

test('weather locations are selected per date instead of across the whole forecast window', () => {
  const lookup = backendContext.buildWeatherLocationByDate_([
    {date: '2026-09-26', type: 'STAY', location: 'White Rocks Hotel'},
    {date: '2026-09-28', type: 'FLIGHT', location: 'Leeds Bradford Airport'},
    {date: '2026-09-28', type: 'RETURN', location: 'Boston Spa'}
  ]);
  assert.equal(lookup['2026-09-26'], 'white rocks hotel');
  assert.equal(lookup['2026-09-28'], 'boston spa');
});

const uiContext = {
  getHomeAttention: () => '',
  homeTelemetryConfidence: () => ({state: 'current', copy: ''})
};
vm.createContext(uiContext);
vm.runInContext(functionSource(frontend, 'getHomeContext'), uiContext);

test('active flight stay is described without motorhome language', () => {
  const result = uiContext.getHomeContext({
    meta: {tripStatus: 'ACTIVE', todayType: 'STAY', vehicleRelevant: false},
    vehicle: {}
  });
  assert.equal(result.stateLabel, 'Staying here');
});

const attentionContext = {};
vm.createContext(attentionContext);
vm.runInContext(functionSource(frontend, 'getHomeAttention'), attentionContext);

test('vehicle and LPG alerts do not take over a flight-trip Home screen', () => {
  assert.equal(attentionContext.getHomeAttention({
    meta: {vehicleRelevant: false},
    vehicle: {systemAlert: 'GARAGE FREEZING', batteryV: 11.9},
    lpg: {current: {alert: 'CRITICAL', statusMsg: 'Refill'}}
  }), '');
});

const vanContext = {
  getVanHealth: () => ({level: 'go', title: 'Van is okay', copy: '', issues: []}),
  vanTelemetryInfo: () => ({state: 'OK', age: 'Checked recently'}),
  getVanScene: () => ({key: 'home', time: 'day'}),
  vanSceneStyle: () => '',
  vanTemperatureState: () => ({label: 'Normal', color: '#fff', level: 'go'}),
  vanHumidityState: () => ({label: 'Normal', color: '#fff'}),
  vanReadingAge: () => '',
  fmtDate: value => value,
  calcFuel: () => ({cost: 0})
};
vm.createContext(vanContext);
vm.runInContext(functionSource(frontend, 'buildVanView'), vanContext);

test('Van uses the telemetry place label and suppresses flight-trip LPG projections', () => {
  const html = vanContext.buildVanView({
    meta: {currentLocation: 'White Rocks Hotel', vehicleRelevant: false},
    vehicle: {locationLabel: 'Boston Spa', lat: 53.9, lon: -1.3, telStatus: 'OK'},
    lpg: {current: {litres: 6.5}, forecast: [{isFuture: true, location: 'White Rocks Hotel'}]}
  }, {pricePerLitre: 1.82, lpgPrice: 0.96, mpg: 28.9, tankLitres: 12});

  assert.match(html, />Boston Spa ↗<\/a>/);
  assert.doesNotMatch(html, />White Rocks Hotel ↗<\/a>/);
  assert.doesNotMatch(html, /Heating runway/);
});
