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
  Date, Number, String, Array, Math, Object, encodeURIComponent,
  escapeDoHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  formatActivityNumber: value => Number(value).toFixed(1).replace(/\.0$/, ''),
  fmtDuration: minutes => minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm',
  momentTypeInfo: type => ({food:['🍽','Food'],pub:['🍺','Pub'],walk:['🥾','Walk'],favourite:['♥','Favourite Moment']})[type] || ['♥','Moment']
};
vm.createContext(context);
vm.runInContext([
  'tripDayNumber', 'tripReviewActivityCategory', 'tripReviewModel',
  'tripReviewMemoryRow', 'buildTripReview'
].map(functionSource).join('\n'), context);

const christmasTrip = {
  meta: {tripName: 'Christmas in Yorkshire', departDate: '2026-12-23', returnDate: '2026-12-28'},
  itinerary: [
    {date: '2026-12-23', type: 'DRIVE', location: 'York', distanceKm: 120, durationMin: 150},
    {date: '2026-12-24', type: 'STAY', location: 'York'},
    {date: '2026-12-25', type: 'STAY', location: 'York'}
  ],
  activities: {tripItems: [
    {tripDate: '2026-12-24', name: 'City walls', sportType: 'Walk', distanceKm: 6.2, movingMinutes: 90},
    {tripDate: '2026-12-25', name: 'Christmas walk', sportType: 'Hike', distanceKm: 8.1, movingMinutes: 125}
  ]},
  memories: {items: [
    {memoryId: 'pub-1', tripDay: 2, type: 'pub', title: 'Pub · York', comment: 'Warm fire', rating: 5, favourite: true, locationName: 'York', thumbnailDriveId: 'private-drive-id', thumbnailUpdatedAt: '2026-12-24T18:00:00Z', photoCount: 1},
    {memoryId: 'food-1', tripDay: 3, type: 'food', title: 'Food · York', comment: 'Christmas lunch', rating: 5, locationName: 'York'}
  ]}
};

test('Trip Review summarises a UK Christmas trip deterministically', () => {
  const review = context.tripReviewModel(christmasTrip);
  assert.equal(review.distanceKm, 120);
  assert.equal(review.activities.length, 2);
  assert.equal(review.memories.length, 2);
  assert.equal(review.averageRating, 5);
  assert.equal(review.activityCategories[0].label, 'Walks & hikes');
  assert.equal(review.activityCategories[0].count, 2);
  assert.equal(review.favourites.length, 2);
  assert.equal(review.places.length, 1);
  assert.match(review.insights.map(item => item.title).join(' '), /Highest rated category/);
});

test('Journey Review renders overview, favourites, activities and Moment management', () => {
  const html = context.buildTripReview(christmasTrip);
  assert.match(html, /Trip Review/);
  assert.match(html, /Christmas in Yorkshire/);
  assert.match(html, /120 km/);
  assert.match(html, /Favourite Moments/);
  assert.match(html, /Walks &amp; hikes|Walks & hikes/);
  assert.match(html, /Places worth returning to/);
  assert.match(html, /Audrey Insights/);
  assert.match(html, /Manage Moments/);
  assert.match(html, /openMomentEdit/);
  assert.match(html, /data-memory-thumbnail="pub-1"/);
  assert.doesNotMatch(html, /private-drive-id/);
});

test('Trip Review has useful empty states before the Christmas trip begins', () => {
  const html = context.buildTripReview({meta:{tripName:'Christmas break'},itinerary:[],activities:{tripItems:[]},memories:{items:[]}});
  assert.match(html, /Your five-star and favourite Moments will appear here/);
  assert.match(html, /Save your first Moment/);
  assert.match(html, /Insights will appear/);
});
