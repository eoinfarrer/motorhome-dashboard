import {Decoder, Encoder, Profile, Stream} from '@garmin/fitsdk';

const SEMICIRCLES_PER_DEGREE = 0x80000000 / 180;
const MAX_RECORDS = 3000;
const COURSE_CAPABILITIES = 0x00000001 | 0x00000002 | 0x00000004
  | 0x00000008 | 0x00000010 | 0x00000200;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normaliseRoutePoints(rawPoints) {
  const points = (Array.isArray(rawPoints) ? rawPoints : []).map((point) => ({
    lat: finiteNumber(point.lat),
    lon: finiteNumber(point.lon),
    elevationM: finiteNumber(point.elevationM, finiteNumber(point.ele)),
    distanceM: finiteNumber(point.distanceM, finiteNumber(point.distanceKm, 0) * 1000)
  })).filter((point) => point.lat !== null && point.lon !== null && point.distanceM !== null);
  if (points.length < 2) throw new Error('A FIT course needs at least two route points');
  points.sort((a, b) => a.distanceM - b.distanceM);
  return points;
}

function sampleRecords(points, maximum = MAX_RECORDS) {
  if (points.length <= maximum) return points.slice();
  const sampled = [];
  const step = (points.length - 1) / (maximum - 1);
  for (let index = 0; index < maximum; index++) sampled.push(points[Math.round(index * step)]);
  sampled[sampled.length - 1] = points[points.length - 1];
  return sampled.filter((point, index, all) => index === 0 || point.distanceM !== all[index - 1].distanceM);
}

function degreesToSemicircles(value) {
  return Math.round(value * SEMICIRCLES_PER_DEGREE);
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(-3).toUpperCase().padStart(3, '0');
}

function deviceCourseName(name, points) {
  const clean = String(name || 'AUDREY ROUTE').replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim().toUpperCase() || 'AUDREY ROUTE';
  const identity = clean + '|' + points[0].lat.toFixed(5) + ',' + points[0].lon.toFixed(5)
    + '|' + points[points.length - 1].lat.toFixed(5) + ',' + points[points.length - 1].lon.toFixed(5);
  return (clean.slice(0, 11).trimEnd() + ' ' + hashText(identity)).slice(0, 15);
}

function nearestRecordIndex(records, distanceM) {
  let low = 0;
  let high = records.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].distanceM < distanceM) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(records[low - 1].distanceM - distanceM) <= Math.abs(records[low].distanceM - distanceM)) return low - 1;
  return low;
}

function safeCoursePointType(value) {
  const allowed = new Set(Object.values(Profile.types.coursePoint));
  return allowed.has(value) ? value : 'generic';
}

export function encodeCourse(options = {}) {
  const route = normaliseRoutePoints(options.points);
  const records = sampleRecords(route, finiteNumber(options.maxRecords, MAX_RECORDS));
  const totalDistanceM = route[route.length - 1].distanceM;
  const speedKmh = Math.max(1, finiteNumber(options.speedKmh, options.activityType === 'hiking' ? 4 : 24));
  const totalSeconds = Math.max(records.length - 1, Math.round(totalDistanceM / (speedKmh * 1000 / 3600)));
  const startTime = options.startTime instanceof Date && !Number.isNaN(options.startTime.valueOf())
    ? options.startTime : new Date();
  const sport = options.activityType === 'hiking' ? 'hiking' : 'cycling';
  const name = deviceCourseName(options.name, route);
  const pointsByRecord = new Map();

  (Array.isArray(options.coursePoints) ? options.coursePoints : []).forEach((point) => {
    const distanceM = Math.max(0, Math.min(totalDistanceM, finiteNumber(point.routeDistanceM, 0)));
    const recordIndex = nearestRecordIndex(records, distanceM);
    const list = pointsByRecord.get(recordIndex) || [];
    list.push({
      name: String(point.coursePointName || point.name || 'POI').slice(0, 24),
      type: safeCoursePointType(point.fitType),
      recordIndex
    });
    pointsByRecord.set(recordIndex, list);
  });

  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, {
    type: 'course', manufacturer: 'development', product: 1,
    serialNumber: 0, timeCreated: startTime
  });
  encoder.onMesg(Profile.MesgNum.COURSE, {
    sport, name, capabilities: COURSE_CAPABILITIES
  });
  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: startTime, event: 'timer', eventType: 'start'
  });

  let coursePointIndex = 0;
  records.forEach((point, index) => {
    const elapsedSeconds = Math.round((point.distanceM / Math.max(totalDistanceM, 1)) * totalSeconds);
    const timestamp = new Date(startTime.getTime() + elapsedSeconds * 1000);
    encoder.onMesg(Profile.MesgNum.RECORD, {
      timestamp,
      positionLat: degreesToSemicircles(point.lat),
      positionLong: degreesToSemicircles(point.lon),
      distance: point.distanceM,
      ...(point.elevationM === null ? {} : {enhancedAltitude: point.elevationM})
    });
    (pointsByRecord.get(index) || []).forEach((coursePoint) => {
      encoder.onMesg(Profile.MesgNum.COURSE_POINT, {
        messageIndex: coursePointIndex++, timestamp,
        positionLat: degreesToSemicircles(point.lat),
        positionLong: degreesToSemicircles(point.lon),
        distance: point.distanceM,
        type: coursePoint.type,
        name: coursePoint.name
      });
    });
  });

  const finish = records[records.length - 1];
  const endTime = new Date(startTime.getTime() + totalSeconds * 1000);
  encoder.onMesg(Profile.MesgNum.EVENT, {
    timestamp: endTime, event: 'timer', eventType: 'stopAll'
  });
  encoder.onMesg(Profile.MesgNum.LAP, {
    messageIndex: 0, timestamp: endTime, startTime,
    startPositionLat: degreesToSemicircles(records[0].lat),
    startPositionLong: degreesToSemicircles(records[0].lon),
    endPositionLat: degreesToSemicircles(finish.lat),
    endPositionLong: degreesToSemicircles(finish.lon),
    totalElapsedTime: totalSeconds, totalTimerTime: totalSeconds,
    totalDistance: totalDistanceM, sport, event: 'lap', eventType: 'stop'
  });

  return {bytes: encoder.close(), name, recordCount: records.length, coursePointCount: coursePointIndex};
}

export function inspectCourse(bytes) {
  const stream = Stream.fromByteArray(Array.from(bytes));
  const decoder = new Decoder(stream);
  const integrity = decoder.checkIntegrity();
  const decoded = decoder.read();
  return {integrity, errors: decoded.errors, messages: decoded.messages};
}
