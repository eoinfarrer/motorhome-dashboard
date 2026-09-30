const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const backend = fs.readFileSync(__dirname + '/../marine-backend/getDashboardState.js', 'utf8');
const snowBackend = fs.readFileSync(__dirname + '/../marine-backend/SnowStatus.js', 'utf8');
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

test('SnowSure unavailable values remain null and season metadata is exposed', () => {
  const headers = new Array(56).fill('');
  const row = new Array(56).fill('');
  row[0] = 'Alta Badia';
  row[1] = 'alta-badia';
  row[4] = 1324;
  row[5] = true;
  row[31] = '';
  row[32] = 53;
  row[33] = '';
  row[34] = 95;
  row[39] = 'Live-production';
  row[40] = 'Closed for the season · reopens Dec 5';
  row[41] = false;
  row[42] = false;
  row[43] = '2026-12-05';
  row[46] = 'low';
  row[47] = 0.18;
  row[48] = 7;
  row[52] = 'https://example.com/webcam.jpg';
  row[53] = 'https://example.com/piste.pdf';
  row[54] = 'https://www.snowsure.ai/resorts/alta-badia';

  const snowSheet = {getDataRange: () => ({getValues: () => [headers, row]})};
  const ss = {getSheetByName: name => name === 'SnowStatus' ? snowSheet : null};
  const context = {console};
  vm.createContext(context);
  vm.runInContext([
    functionSource(backend, 'sheetNullableNumber_'),
    functionSource(backend, 'sheetNullableBoolean_'),
    functionSource(backend, 'buildSnowStatus_')
  ].join('\n'), context);

  const resort = context.buildSnowStatus_(ss).resorts[0];
  assert.equal(resort.snowDepthCm, null);
  assert.equal(resort.ssScore, null);
  assert.equal(resort.liftsOpen, null);
  assert.equal(resort.liftsTotal, 53);
  assert.equal(resort.isOpen, false);
  assert.equal(resort.seasonOpeningDate, '2026-12-05');
  assert.equal(resort.forecastConfidence, 'low');
  assert.match(resort.webcamUrl, /webcam/);
});

test('Snow depth trend stores one sample per day and keeps fourteen days', () => {
  const context = {
    Utilities: {formatDate: () => '2026-12-10'},
    Date,
    JSON
  };
  vm.createContext(context);
  vm.runInContext(functionSource(snowBackend, 'updateSnowDepthTrend_'), context);
  const old = JSON.stringify([
    {date: '2026-12-09', depthCm: 40},
    {date: '2026-12-10', depthCm: 42}
  ]);
  const trend = JSON.parse(context.updateSnowDepthTrend_(old, 45, 'Resort reported', '10/12/2026 09:00'));
  assert.equal(trend.length, 2);
  assert.equal(trend[1].date, '2026-12-10');
  assert.equal(trend[1].depthCm, 45);
});

const uiContext = {isFinite, Number, Math, Date};
vm.createContext(uiContext);
vm.runInContext([
  functionSource(frontend, 'snowHasNumber'),
  functionSource(frontend, 'snowDateLabel'),
  functionSource(frontend, 'getSkiDisplayMode'),
  functionSource(frontend, 'getDoSkiDecision'),
  functionSource(frontend, 'buildDoSkiOpportunity'),
  functionSource(frontend, 'buildSnowDepthTrend'),
  functionSource(frontend, 'buildSnowOutlookBanner')
].join('\n'), uiContext);

test('pre-trip resort opening switches Audrey into season watch', () => {
  const snow = {resorts: [{name: 'Alta Badia', isOpen: true}]};
  assert.equal(uiContext.getSkiDisplayMode({tripStatus: 'PRE_TRIP'}, snow), 'season-watch');
  assert.equal(uiContext.getSkiDisplayMode({tripStatus: 'ACTIVE'}, snow), 'live');
  assert.equal(uiContext.getSkiDisplayMode({tripStatus: 'PRE_TRIP'}, {resorts: [{isOpen: false}]}), 'outlook');
});

test('off-season null operations are not presented as zero open lifts', () => {
  const resort = {
    name: 'Alta Badia',
    isOpen: false,
    status: 'OFF_SEASON',
    statusLabel: 'Closed for the season · reopens Dec 5',
    seasonOpeningDate: '2026-12-05',
    liftsOpen: null,
    liftsTotal: 53,
    runsOpen: null,
    runsTotal: 95,
    snowDepthCm: null,
    ssScore: null
  };
  const decision = uiContext.getDoSkiDecision(resort);
  const html = uiContext.buildDoSkiOpportunity(resort, 0, decision);
  assert.equal(decision.status, 'SEASON WATCH');
  assert.doesNotMatch(html, /0\/53 lifts/);
  assert.doesNotMatch(html, /0cm base/);
  assert.match(html, /Closed for the season/);
});

test('More outlook explains that trends stay visible once resorts open', () => {
  const html = uiContext.buildSnowOutlookBanner({resorts: [
    {isOpen: true}, {isOpen: true}, {isOpen: false, seasonOpeningDate: '2026-12-12'}
  ]}, {tripStatus: 'PRE_TRIP'});
  assert.match(html, /Season watch/);
  assert.match(html, /2 saved resorts have opened/);
  assert.match(html, /planning mode/);
});
