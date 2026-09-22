const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/index.html', 'utf8');
const start = source.indexOf('function getActivityCoordinates(');
const end = source.indexOf('// ── Discovery view', start);
assert.ok(start >= 0 && end > start);
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

test('flight trip uses the current itinerary stop instead of the parked van', () => {
  const result = context.getActivityCoordinates({
    meta: {currentLocationCoords: {lat:38.15164, lon:20.4853}},
    vehicle: {lat:53.9041, lon:-1.3419},
    itinerary: [{type:'FLIGHT'}, {type:'STAY'}]
  });
  assert.deepEqual({...result}, {lat:38.15164, lon:20.4853, source:'itinerary'});
});

test('motorhome trip retains live vehicle coordinates', () => {
  const result = context.getActivityCoordinates({
    meta: {currentLocationCoords: {lat:55.5534, lon:-1.6563}},
    vehicle: {lat:55.5601, lon:-1.6502},
    itinerary: [{type:'DRIVE'}, {type:'STAY'}]
  });
  assert.deepEqual({...result}, {lat:55.5601, lon:-1.6502, source:'vehicle'});
});

test('itinerary coordinates are the fallback without telemetry', () => {
  const result = context.getActivityCoordinates({
    meta: {currentLocationCoords: {lat:38.15164, lon:20.4853}},
    vehicle: {},
    itinerary: [{type:'STAY'}]
  });
  assert.deepEqual({...result}, {lat:38.15164, lon:20.4853, source:'itinerary'});
});

test('missing coordinates do not manufacture a location', () => {
  assert.deepEqual({...context.getActivityCoordinates({itinerary:[{type:'FLIGHT'}]})},
    {lat:null, lon:null, source:'none'});
});
