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
  functionSource('rankDoPlacesForReadiness')
].join('\n'), context);

test('shows current Garmin readiness without exposing a health dashboard', () => {
  const html = context.buildDoReadinessContext({travellerContext:{
    available:true,isToday:true,readinessBand:'Good',
    reasons:['Sleep duration was solid']
  }});
  assert.match(html, /Garmin traveller context/);
  assert.match(html, /Good/);
  assert.match(html, /Sleep duration was solid/);
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
