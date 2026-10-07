const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/index.html', 'utf8');

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

const context = {
  Date,
  Number,
  String,
  Array,
  Math,
  formatActivityNumber: value => String(value),
  activityMetricParts: activity => activity.distanceKm ? [activity.distanceKm + ' km'] : [],
  activityIcon: activity => /ride/i.test(activity.sportType || '') ? '🚴' : '🥾',
  momentTypeInfo: type => type === 'food' ? ['🍽', 'Food'] : ['♥', 'Moment'],
  escapeDoHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
};
vm.createContext(context);
vm.runInContext([
  'tripDayNumber', 'dailyStoryLocation', 'dailyStoryActivityLabel',
  'dailyStoryModel', 'buildDailyStoryItems', 'buildDailyStoryPoint',
  'buildHomeDailyStory'
].map(functionSource).join('\n'), context);

const day = {
  meta: {departDate: '2026-10-05', returnDate: '2026-10-10'},
  itinerary: [{date: '2026-10-06', type: 'STAY', location: 'Volterra', isToday: true}],
  weather: [{date: '2026-10-06', location: 'Volterra', condition: 'Clear skies'}],
  activities: {tripItems: [{tripDate: '2026-10-06', name: 'Morning Ride', sportType: 'Ride', distanceKm: 42}]},
  memories: {items: [{tripDay: 2, type: 'food', title: 'Truffle pasta', rating: 5, favourite: true}]}
};

test('Daily Story combines itinerary, weather, activity and Moments deterministically', () => {
  const story = context.dailyStoryModel(day, '2026-10-06', day.itinerary);
  assert.equal(story.dayNumber, 2);
  assert.equal(story.location, 'Volterra');
  assert.match(story.copy, /Clear skies/i);
  assert.match(story.copy, /42 km ride/);
  assert.match(story.copy, /Truffle pasta/);
});

test('Journey renders one expandable Daily Story with activity and Moment rows', () => {
  const html = context.buildDailyStoryPoint(day, '2026-10-06', day.itinerary, false);
  assert.match(html, /Day 2 · Daily Story/);
  assert.match(html, /<details class="journey-story" open>/);
  assert.match(html, /Morning Ride/);
  assert.match(html, /Truffle pasta/);
  assert.match(html, /★★★★★/);
});

test('Home shows a compact Today so far card linked to the Journey story', () => {
  const html = context.buildHomeDailyStory(day);
  assert.match(html, /Today so far · Day 2/);
  assert.match(html, /Volterra/);
  assert.match(html, /1 activity/);
  assert.match(html, /1 Moment/);
  assert.match(html, /Open Daily Story/);
});
