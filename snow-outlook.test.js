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

test('SnowSure unavailable values remain null and enriched intelligence is exposed', () => {
  const headers = new Array(68).fill('');
  const row = new Array(68).fill('');
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
  row[56] = 'Firm pistes soften through the afternoon.';
  row[57] = JSON.stringify({forecast: 'Little fresh snow expected.'});
  row[58] = 'Seven forecast models agree.';
  row[59] = JSON.stringify({base: {cm: 3}, mid: {cm: 7}, summit: {cm: 12}});
  row[60] = JSON.stringify({
    base: {temperature: {celsius: -1}, windSpeed: 9},
    mid: {temperature: {celsius: -4}, windSpeed: 18},
    summit: {temperature: {celsius: -8}, windSpeed: 31}
  });
  row[62] = '90 inches / 229 cm';
  row[63] = '8.5 km / 5.3 mi';
  row[64] = 1500;
  row[65] = 'Open-Meteo + resort reports';

  const snowSheet = {getDataRange: () => ({getValues: () => [headers, row]})};
  const passSheet = {getDataRange: () => ({getValues: () => [
    ['Pass', 'Status', 'Updated', 'Detail', 'Source URL', 'Source'],
    ['Gardena Pass', '✅ Open', '2026-12-10 08:00', 'Keine Beschränkungen.', 'https://example.com/pass', 'Official traffic centre']
  ]})};
  const ss = {getSheetByName: name => name === 'SnowStatus' ? snowSheet : name === 'PassStatus' ? passSheet : null};
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
  assert.equal(resort.ssAiSummary, 'Firm pistes soften through the afternoon.');
  assert.equal(resort.ssAiReasoning.forecast, 'Little fresh snow expected.');
  assert.equal(resort.forecastConfidenceBasis, 'Seven forecast models agree.');
  assert.equal(resort.modelDepth.base.cm, 3);
  assert.equal(resort.topTempC, -8);
  assert.equal(resort.topWindKh, 31);
  assert.equal(resort.skiableAcres, 1500);
  assert.match(resort.webcamUrl, /webcam/);
  const pass = context.buildSnowStatus_(ss).passes[0];
  assert.equal(pass.name, 'Gardena Pass');
  assert.match(pass.detail, /Keine/);
  assert.match(pass.sourceUrl, /^https:/);
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
  functionSource(frontend, 'escapeDoHtml'),
  functionSource(frontend, 'snowHasNumber'),
  functionSource(frontend, 'snowBaseDepth'),
  functionSource(frontend, 'snowDateLabel'),
  functionSource(frontend, 'getSkiDisplayMode'),
  functionSource(frontend, 'getDoSkiDecision'),
  functionSource(frontend, 'buildDoSkiOpportunity'),
  functionSource(frontend, 'buildSnowDepthTrend'),
  functionSource(frontend, 'buildSnowOutlookBanner'),
  functionSource(frontend, 'buildDoSkiSummary'),
  functionSource(frontend, 'buildDoSkiDepth'),
  functionSource(frontend, 'buildDoSkiSnowHistory'),
  functionSource(frontend, 'buildSkiForecast'),
  functionSource(frontend, 'buildSkiResortDetail')
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
    snowCm: 0,
    snow7dCm: 0,
    ssScore: null
  };
  const decision = uiContext.getDoSkiDecision(resort);
  const html = uiContext.buildDoSkiOpportunity(resort, 0, decision);
  assert.equal(decision.status, 'SEASON WATCH');
  assert.doesNotMatch(html, /0\/53 lifts/);
  assert.doesNotMatch(html, /0cm base/);
  assert.doesNotMatch(html, /0cm in 7d/);
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

test('Do resort intelligence restores AI summary, winds and the snow depth line', () => {
  const html = uiContext.buildSkiResortDetail({
    name: 'Alta Badia', isOpen: true, statusLabel: 'Open', elevationM: 1324,
    liftsOpen: 40, liftsTotal: 53, runsOpen: 70, runsTotal: 95,
    snowDepthCm: 62, depthSource: 'Resort reported', ssScore: 78,
    ssTagline: 'Excellent cover across the area',
    ssAiSummary: 'Cold, settled pistes with a little fresh snow later in the week.',
    botTempC: -1, botWindKh: 9, midTempC: -4, midWindKh: 18, topTempC: -8, topWindKh: 31,
    snow24hCm: 2, snow7dCm: 18, seasonTotalCm: 323,
    forecastLowCm: 4, forecastHighCm: 9, forecastHorizonDays: 7,
    forecastConfidence: 'high', forecastConfidenceBasis: 'Seven models agree.',
    forecast3d: [{date: '2026-12-10', desc: 'Light snow', snowfall: 2, tempMin: -8, tempMax: -3, wind: 31, flMax: 1400}]
  }, {});
  assert.match(html, /SnowSure AI summary/);
  assert.match(html, /Cold, settled pistes/);
  assert.match(html, /Snow depth/);
  assert.match(html, /Resort reported/);
  assert.match(html, /Wind 31 km\/h/);
  assert.match(html, /Freeze 1,400m/);
  assert.match(html, /Seven models agree/);
});

test('modelled snow is labelled and never presented as reported depth', () => {
  const html = uiContext.buildDoSkiDepth({snowDepthCm: null, modelDepth: {base: {cm: 3}}});
  assert.match(html, /3cm/);
  assert.match(html, /Modelled base/);
  assert.doesNotMatch(html, /Reported base/);
});
