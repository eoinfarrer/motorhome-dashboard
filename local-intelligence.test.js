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
  'selectDiverseDoPlaces_'
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

test('architecture alone is not labelled must see', () => {
  assert.equal(context.groupDoPlace_('architecture,churches', {}), 'other');
  assert.equal(context.isReligiousDoPlace_(place('St Mary Church', 'architecture,churches', 0.2, 3)), true);
});
