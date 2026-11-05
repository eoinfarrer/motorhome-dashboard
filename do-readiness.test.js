const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

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
  functionSource('escapeDoHtml'),
  functionSource('buildDoReadinessContext'),
  functionSource('applyDoReadinessToDecision'),
  functionSource('rankDoPlacesForReadiness'),
  functionSource('getDoWeatherForContext'),
  functionSource('describeDoWeather'),
  functionSource('doReadinessApplies'),
  functionSource('getDoTripMode'),
  functionSource('scoreDoOptionForToday'),
  functionSource('buildDoAdaptiveOptions'),
  functionSource('buildDoTodayRecommendation'),
  functionSource('rankDoPlacesForContext')
].join('\n'), context);

test('shows a provider-neutral readiness summary with useful body context', () => {
  const html = context.buildDoReadinessContext({travellerContext:{
    available:true,isToday:true,readinessBand:'Good',
    bodyBattery:61,reasons:['Sleep duration was solid']
  }});
  assert.match(html, /Today’s readiness/);
  assert.match(html, /Good/);
  assert.match(html, /Body Battery 61/);
  assert.match(html, /Sleep duration was solid/);
  assert.doesNotMatch(html, /Garmin traveller context/);
});

test('low readiness gently tempers an otherwise strong ski decision', () => {
  const result = context.applyDoReadinessToDecision(
    {level:'go',status:'GO',why:'Bluebird conditions.',when:'Open detail.'},
    {available:true,isToday:true,readinessBand:'Low'}
  );
  assert.equal(result.level, 'possible');
  assert.equal(result.status, 'POSSIBLE');
  assert.match(result.why, /flexible/);
});

test('readiness reorders local ideas softly while preserving stable ties', () => {
  const places = [
    {name:'Summit walk',group:'outdoors'},
    {name:'Museum',group:'mustSee'},
    {name:'Lunch',group:'food'},
    {name:'Second museum',group:'mustSee'}
  ];
  const low = context.rankDoPlacesForReadiness(places,{available:true,isToday:true,readinessBand:'Low'});
  assert.deepEqual(low.map(item=>item.name), ['Lunch','Museum','Second museum','Summit walk']);
  const excellent = context.rankDoPlacesForReadiness(places,{available:true,isToday:true,readinessBand:'Excellent'});
  assert.equal(excellent[0].name, 'Summit walk');
});

test('wet weather and low readiness favour a sheltered local option', () => {
  const data = {
    weather:[{date:'2026-10-23',isToday:true,condition:'Heavy rain',precipMm:8,gustKmh:25}],
    travellerContext:{available:true,isToday:true,readinessBand:'Low'}
  };
  const result = {context:{date:'2026-10-23',mode:'current'},places:[
    {name:'Ridge walk',group:'outdoors',category:'outdoors',distanceKm:1},
    {name:'Local museum',group:'mustSee',category:'culture',distanceKm:2}
  ],events:[]};
  const pick = context.buildDoTodayRecommendation(data,result);
  assert.equal(pick.title,'Local museum');
  assert.match(pick.reasons.join(' '),/Adverse weather/);
  assert.match(pick.reasons.join(' '),/Low readiness/);
});

test('dry weather and excellent readiness lift an outdoor option with local routes', () => {
  const data = {
    weather:[{date:'2026-10-23',isToday:true,condition:'Clear',precipMm:0,gustKmh:12,maxTempC:18}],
    travellerContext:{available:true,isToday:true,readinessBand:'Excellent'}
  };
  const result = {context:{date:'2026-10-23',mode:'current'},places:[
    {name:'Cafe',group:'food',category:'food',distanceKm:.5},
    {name:'Riverside viewpoint',group:'outdoors',category:'viewpoint',distanceKm:1,nearby:{walkingRoutes:2,cyclingRoutes:1}}
  ],events:[]};
  const pick = context.buildDoTodayRecommendation(data,result);
  assert.equal(pick.title,'Riverside viewpoint');
  assert.match(pick.reasons.join(' '),/local routes nearby/);
});

test('current readiness is not applied to a future itinerary stop', () => {
  const data = {
    weather:[
      {date:'2026-10-23',isToday:true,condition:'Clear',precipMm:0,gustKmh:5},
      {date:'2026-12-24',isToday:false,condition:'Cloudy',precipMm:0,gustKmh:10}
    ],
    travellerContext:{available:true,isToday:true,readinessBand:'Low'}
  };
  const result = {context:{date:'2026-12-24',mode:'planning'},places:[
    {name:'Park',group:'outdoors',category:'outdoors',distanceKm:1}
  ],events:[]};
  const pick = context.buildDoTodayRecommendation(data,result);
  assert.doesNotMatch(pick.reasons.join(' '),/Low readiness/);
  assert.equal(pick.label,'Audrey’s pick for this stop');
});

test('adaptive choices separate easy outdoor options from sheltered food and drink', () => {
  const data = {weather:[], travellerContext:{available:true,isToday:false,readinessBand:'Excellent'}};
  const result = {context:{mode:'planning',date:'2026-12-24'},places:[
    {name:'The Moot Hall',group:'mustSee',category:'culture',distanceKm:.4},
    {name:'Dog and Gun',group:'food',category:'food',distanceKm:.7},
    {name:'Friars Crag Viewpoint',group:'outdoors',category:'outdoors',distanceKm:1.1}
  ],events:[]};
  const pick = context.buildDoTodayRecommendation(data,result);
  const alternatives = Object.fromEntries(pick.adaptive.map(option=>[option.kind,option]));
  assert.equal(alternatives.sheltered.title,'Dog and Gun');
  assert.equal(alternatives.outdoor.title,'Friars Crag Viewpoint');
  assert.notEqual(alternatives.easy.title,'Dog and Gun');
});

test('trip mode gives cycling routes a useful lift over hiking routes', () => {
  const data = {meta:{tripName:'Maratona cycling trip'},weather:[],savedRoutes:[],itinerary:[]};
  const result = {context:{mode:'planning',date:'2027-07-06'},places:[],events:[]};
  const profile = context.describeDoWeather(null);
  const cycling = context.scoreDoOptionForToday({type:'cycling',distanceKm:8},0,'route',data,result,profile);
  const hiking = context.scoreDoOptionForToday({type:'hiking',distanceKm:8},1,'route',data,result,profile);
  assert.equal(context.getDoTripMode(data),'cycling');
  assert.ok(cycling>hiking);
});
