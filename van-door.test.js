const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const samsara = fs.readFileSync(__dirname + '/../marine-backend/Samsara.js', 'utf8');
const dashboard = fs.readFileSync(__dirname + '/../marine-backend/getDashboardState.js', 'utf8');
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

test('Samsara door snapshot maps open and closed states for the configured vehicle', () => {
  let request;
  const context = {
    DOOR_SENSOR_URL: 'https://api.samsara.com/v1/sensors/door',
    getSamsaraConfig_: () => ({vehicleId: 'vehicle-1', doorSensorIds: [101, 102]}),
    getSamsaraHeaders_: () => ({Authorization: 'Bearer test'}),
    logDebug: () => {},
    UrlFetchApp: {fetch: (url, options) => {
      request = {url, options};
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({sensors: [
          {id: 101, name: 'Habitation door', doorClosed: false, doorStatusTime: '2026-09-29T09:00:00Z', vehicleId: 'vehicle-1'},
          {id: 102, name: 'Other vehicle', doorClosed: true, doorStatusTime: '2026-09-29T08:00:00Z', vehicleId: 'vehicle-2'}
        ]})
      };
    }}
  };
  vm.createContext(context);
  vm.runInContext(functionSource(samsara, 'fetchDoorStatuses'), context);

  const result = context.fetchDoorStatuses();
  assert.equal(request.url, 'https://api.samsara.com/v1/sensors/door');
  assert.deepEqual(JSON.parse(request.options.payload), {sensors: [101, 102]});
  assert.equal(result.length, 1);
  assert.equal(result[0].closed, false);
  assert.equal(result[0].changedAt, '2026-09-29T09:00:00Z');
  assert.equal(result[0].status, 'OK');
});

test('door polling remains optional until a sensor id is configured', () => {
  let fetched = false;
  const context = {
    DOOR_SENSOR_URL: 'https://api.samsara.com/v1/sensors/door',
    getSamsaraConfig_: () => ({vehicleId: 'vehicle-1', doorSensorIds: []}),
    getSamsaraHeaders_: () => ({}),
    logDebug: () => {},
    UrlFetchApp: {fetch: () => { fetched = true; }}
  };
  vm.createContext(context);
  vm.runInContext(functionSource(samsara, 'fetchDoorStatuses'), context);
  assert.equal(context.fetchDoorStatuses().length, 0);
  assert.equal(fetched, false);
});

test('VehicleSnapshot door columns are exposed in the dashboard payload', () => {
  const row = new Array(25).fill('');
  row[3] = 13000;
  row[7] = 'OK';
  row[9] = 'OK';
  row[20] = '2026-09-29T09:05:00Z';
  row[21] = 'Habitation door';
  row[22] = false;
  row[23] = '2026-09-29T09:00:00Z';
  row[24] = 'OK';
  const context = {
    formatBatteryVoltageEmoji_: () => 'OK',
    formatCabinTempEmoji_: () => 'OK',
    formatGarageTempEmoji_: () => 'OK',
    samsaraSnapshotStaleMinutes_: () => 150,
    samsaraTimestampStatus_: () => ({status: 'OK'}),
    samsaraSensorStaleMinutes_: () => 360,
    UrlFetchApp: {fetch: () => ({getContentText: () => '{"elevation":[100]}'})},
    console
  };
  const sheet = {getRange: ref => ({getValue: () => ref === 'B2' ? 'Boston Spa' : '', getValues: () => [row]})};
  const ss = {getSheetByName: () => sheet};
  vm.createContext(context);
  vm.runInContext(functionSource(dashboard, 'buildVehicle_'), context);

  const vehicle = context.buildVehicle_(ss);
  assert.equal(vehicle.habitationDoorName, 'Habitation door');
  assert.equal(vehicle.habitationDoorClosed, false);
  assert.equal(vehicle.habitationDoorChangedAt, '2026-09-29T09:00:00Z');
  assert.equal(vehicle.habitationDoorStatus, 'OK');
});

test('Van shows an open habitation door and raises an attention item', () => {
  const context = {
    homeTelemetryConfidence: () => ({state: 'current'}),
    vanTelemetryInfo: () => ({state: 'OK', age: 'Checked recently'}),
    getVanScene: () => ({key: 'home', time: 'day'}),
    vanSceneStyle: () => '',
    vanTemperatureState: () => ({label: 'Normal', color: '#fff', level: 'go'}),
    vanHumidityState: () => ({label: 'Normal', color: '#fff'}),
    vanReadingAge: () => '5m ago',
    fmtDate: value => value,
    calcFuel: () => ({cost: 0})
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource(frontend, 'getVanHealth'),
    functionSource(frontend, 'buildVanView')
  ].join('\n'), context);
  const data = {
    meta: {vehicleRelevant: true},
    vehicle: {habitationDoorClosed: false, habitationDoorStatus: 'OK', habitationDoorChangedAt: '2026-09-29T09:00:00Z'},
    lpg: null
  };
  const health = context.getVanHealth(data);
  const html = context.buildVanView(data, {});
  assert.ok(health.issues.some(issue => issue.key === 'door'));
  assert.match(html, /Habitation door/);
  assert.match(html, />Open</);
});
