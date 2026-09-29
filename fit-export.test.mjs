import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeCourse, inspectCourse} from './src/fit-export.mjs';

const result = encodeCourse({
  name: 'Maratona Course',
  activityType: 'cycling',
  speedKmh: 25,
  startTime: new Date('2026-09-29T07:00:00Z'),
  points: [
    {lat: 46.55, lon: 11.87, elevationM: 1500, distanceM: 0},
    {lat: 46.56, lon: 11.89, elevationM: 1600, distanceM: 2000},
    {lat: 46.57, lon: 11.91, elevationM: 1700, distanceM: 4000}
  ],
  coursePoints: [
    {name: 'Village Fountain', coursePointName: 'WATER FOUNTAIN', fitType: 'water', routeDistanceM: 1900},
    {name: 'Rifugio', coursePointName: 'SHELTER RIFUGIO', fitType: 'shelter', routeDistanceM: 3500}
  ]
});

const inspected = inspectCourse(result.bytes);

test('encodes a valid FIT course with route records and course points', () => {
  assert.equal(inspected.integrity, true);
  assert.deepEqual(inspected.errors, []);
  assert.equal(inspected.messages.fileIdMesgs[0].type, 'course');
  assert.equal(inspected.messages.courseMesgs[0].sport, 'cycling');
  assert.equal(inspected.messages.recordMesgs.length, 3);
  assert.equal(inspected.messages.coursePointMesgs.length, 2);
  assert.deepEqual(inspected.messages.coursePointMesgs.map(point => point.type), ['water', 'shelter']);
  assert.deepEqual(inspected.messages.coursePointMesgs.map(point => point.name), ['WATER FOUNTAIN', 'SHELTER RIFUGIO']);
  assert.deepEqual(inspected.messageSequence.slice(0, 4), ['fileId', 'course', 'lap', 'event']);
  assert.equal(inspected.messages.eventMesgs.at(-1).eventType, 'stopDisableAll');
});

test('uses a device-safe course name unique within the first fifteen characters', () => {
  assert.ok(result.name.length <= 15);
  assert.match(result.name, /^MARATONA CO [A-Z0-9]{3}$/);
});

test('places course points on route records in distance order', () => {
  const points = inspected.messages.coursePointMesgs;
  assert.ok(points[0].distance <= points[1].distance);
  assert.equal(points[0].positionLat, inspected.messages.recordMesgs[1].positionLat);
  assert.equal(points[1].positionLat, inspected.messages.recordMesgs[2].positionLat);
});
