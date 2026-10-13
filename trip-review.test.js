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
  'tripDayNumber', 'dailyStoryLocation', 'dailyStoryActivityLabel', 'dailyStoryModel',
  'tripReviewActivityCategory', 'isFavouriteMoment', 'momentMeaningScore',
  'tripReviewThemes', 'tripReviewCoordinates', 'tripReviewMapLegMode', 'tripReviewMapModel',
  'buildTripReviewMapFallback', 'buildTripReviewMap', 'travelogueWorldPoint',
  'travelogueMapFitView', 'travelogueMapTileUrl', 'travelogueMapPointerDown',
  'tripReviewModel', 'tripReviewMemoryRow', 'buildTripReview',
  'storybookDateLabel', 'storybookHeroKey', 'storybookHeroAsset', 'storybookImageDimensions', 'storybookModel', 'storybookStat',
  'storybookPageNumber', 'storybookMomentTitle', 'storybookMomentImage',
  'buildStorybookMap', 'buildStorybookCover', 'buildStorybookMoments',
  'buildStorybookDays', 'buildStorybookReflection', 'buildStorybook'
].map(functionSource).join('\n'), context);

const christmasTrip = {
  meta: {tripName: 'Christmas in Yorkshire', departDate: '2026-12-23', returnDate: '2026-12-28'},
  itinerary: [
    {date: '2026-12-23', type: 'DEPART', location: 'Boston Spa', distanceKm: 120, durationMin: 150, lat:53.9041, lng:-1.3419},
    {date: '2026-12-23', type: 'ARRIVE', location: 'York', lat:53.96, lng:-1.08},
    {date: '2026-12-24', type: 'STAY', location: 'York', lat:53.96, lng:-1.08},
    {date: '2026-12-25', type: 'STAY', location: 'York', lat:53.96, lng:-1.08}
  ],
  activities: {tripItems: [
    {tripDate: '2026-12-24', start:'2026-12-24T10:00:00', name: 'City walls', sportType: 'Walk', distanceKm: 6.2, movingMinutes: 90, startLat:53.962, startLon:-1.082},
    {tripDate: '2026-12-25', name: 'Christmas walk', sportType: 'Hike', distanceKm: 8.1, movingMinutes: 125}
  ]},
  memories: {items: [
    {memoryId: 'pub-1', tripDay: 2, type: 'pub', title: 'Pub · York', comment: 'Warm fire', rating: 5, favourite: true, locationName: 'York', lat:53.96, lng:-1.08, thumbnailDriveId: 'private-drive-id', thumbnailUpdatedAt: '2026-12-24T18:00:00Z', photoCount: 1},
    {memoryId: 'food-1', tripDay: 3, type: 'food', title: 'Food · York', comment: 'Christmas lunch', rating: 5, locationName: 'York', lat:53.961, lng:-1.079}
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
  assert.equal(review.highlights.length, 2);
  assert.equal(review.definingMoments.length, 2);
  assert.equal(review.themes[0].title, 'Food & drink');
  assert.equal(review.map.points.length, 7);
  assert.equal(review.map.route.length, 2);
  assert.equal(review.map.routeSegments.length, 1);
  assert.equal(review.map.routeSegments[0].mode, 'road');
  assert.deepEqual(Array.from(review.map.route, point => point.label), ['Boston Spa', 'York']);
  assert.equal(review.map.points.filter(point => point.kind === 'activity').length, 1);
  assert.match(review.insights.map(item => item.title).join(' '), /Most meaningful category/);
});

test('Journey Review renders overview, favourites, activities and Moment management', () => {
  const html = context.buildTripReview(christmasTrip);
  assert.match(html, /Trip Review/);
  assert.match(html, /Christmas in Yorkshire/);
  assert.match(html, /120 km/);
  assert.match(html, /Favourite Moments/);
  assert.match(html, /Walks &amp; hikes|Walks & hikes/);
  assert.match(html, /Trip Highlights/);
  assert.match(html, /Defining Moments/);
  assert.match(html, /What Made This Trip Special/);
  assert.match(html, /Journey Map/);
  assert.match(html, /trip-review-map-svg/);
  assert.match(html, /data-map-route="itinerary"/);
  assert.match(html, /data-travelogue-map/);
  assert.match(html, /Fit trip/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.doesNotMatch(html, /Places worth returning to|Strongest return signal|You should/);
  assert.match(html, /Audrey Insights/);
  assert.match(html, /Manage Moments/);
  assert.match(html, /openMomentEdit/);
  assert.match(html, /data-memory-thumbnail="pub-1"/);
  assert.doesNotMatch(html, /private-drive-id/);
  assert.match(html, /Preview Storybook/);
});

test('Christmas trip produces a compact print-ready Storybook', () => {
  const model = context.storybookModel(christmasTrip);
  assert.equal(model.name, 'Christmas in Yorkshire');
  assert.equal(model.days, 6);
  assert.equal(model.hero, 'assets/scenes/home.jpg');
  assert.ok(model.selectedStories.length <= 3);
  const html = context.buildStorybook(christmasTrip);
  assert.match(html, /Audrey Travel Storybook/);
  assert.match(html, /Christmas in Yorkshire/);
  assert.match(html, /The journey in places/);
  assert.match(html, /tile\.openstreetmap\.org/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /Defining Moments/);
  assert.match(html, /storybook-photo-frame/);
  assert.match(html, /The journey, closely remembered/);
  assert.match(html, /Day 2/);
  assert.match(html, /What made this journey ours/);
  assert.ok((html.match(/class="storybook-page/g) || []).length >= 4);
  assert.doesNotMatch(html, /private-drive-id/);
});

test('Storybook supports a private high quality hero and square map tiles', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(context.storybookImageDimensions(4000, 3000, 2000, 1400))), {width: 1867, height: 1400});
  assert.deepEqual(JSON.parse(JSON.stringify(context.storybookImageDimensions(800, 600, 2000, 1400))), {width: 800, height: 600});
  assert.match(source, /id="storybookHeroInput" type="file" accept="image\/\*"/);
  assert.match(source, /action:'upload_storybook_hero'/);
  assert.match(source, /action:'get_storybook_hero'/);
  assert.match(source, /action:'remove_storybook_hero'/);
  assert.match(source, /canvas\.toBlob\(resolve,'image\/jpeg',0\.88\)/);
  assert.match(source, /\.storybook-map-frame\{[^}]*aspect-ratio:50\/34/);
  assert.doesNotMatch(source, /\.storybook-map-frame\{height:560px\}/);
});

test('Journey Map projection, fitting and tile URLs are deterministic', () => {
  const york = context.travelogueWorldPoint(53.96, -1.08, 10);
  assert.ok(Number.isFinite(york.x));
  assert.ok(Number.isFinite(york.y));
  const view = context.travelogueMapFitView([
    {lat:53.9041,lng:-1.3419}, {lat:53.96,lng:-1.08}
  ], 320, 280);
  assert.ok(view.zoom >= 9 && view.zoom <= 17);
  assert.match(context.travelogueMapTileUrl(10, 508, 330), /^https:\/\/tile\.openstreetmap\.org\/10\/508\/330\.png$/);
});

test('Journey Map controls and pins do not start a pan or capture their pointer', () => {
  let captures = 0;
  context.travelogueMapView = {
    centerWorld: {x: 100, y: 200},
    drag: null,
    canvas: {
      setPointerCapture: () => captures++,
      classList: {add: () => assert.fail('control press must not start dragging')}
    }
  };
  ['button', '[data-map-index]'].forEach((interactiveTarget, index) => {
    context.travelogueMapPointerDown({
      pointerId: 4 + index,
      button: 0,
      clientX: 20,
      clientY: 30,
      target: {closest: selector => selector.includes(interactiveTarget) ? {} : null}
    });
  });
  assert.equal(captures, 0);
  assert.equal(context.travelogueMapView.drag, null);
});

test('Journey Map distinguishes flight and ferry itinerary legs', () => {
  assert.equal(context.tripReviewMapLegMode({type:'FLIGHT'},{type:'ARRIVE'}), 'flight');
  assert.equal(context.tripReviewMapLegMode({type:'DEPART'},{type:'FERRY'}), 'ferry');
  assert.equal(context.tripReviewMapLegMode({type:'DRIVE'},{type:'STAY'}), 'road');
});

test('Journey Map never joins Moment pins into a false route', () => {
  const map = context.tripReviewMapModel({itinerary:[]}, [
    {type:'food', title:'Lunch', timestamp:'2026-12-24T12:00:00Z', lat:53.9, lng:-1.3},
    {type:'pub', title:'Evening', timestamp:'2026-12-24T19:00:00Z', lat:54.0, lng:-1.1}
  ], []);
  const html = context.buildTripReviewMap(map);
  assert.equal(map.route.length, 0);
  assert.equal(map.routeSegments.length, 0);
  assert.doesNotMatch(html, /<polyline/);
  assert.equal((html.match(/data-map-point="moment"/g) || []).length, 2);
});

test('Journey Map does not bridge over an itinerary stop with missing coordinates', () => {
  const map = context.tripReviewMapModel({itinerary:[
    {date:'2026-12-23',type:'DEPART',location:'Boston Spa',lat:53.9,lng:-1.34},
    {date:'2026-12-23',type:'STOPOVER',location:'Unknown stop'},
    {date:'2026-12-23',type:'ARRIVE',location:'York',lat:53.96,lng:-1.08}
  ]}, [], []);
  assert.equal(map.routeSegments.length, 0);
  assert.doesNotMatch(context.buildTripReviewMap(map), /<polyline/);
});

test('Trip Review has useful empty states before the Christmas trip begins', () => {
  const html = context.buildTripReview({meta:{tripName:'Christmas break'},itinerary:[],activities:{tripItems:[]},memories:{items:[]}});
  assert.match(html, /Your five-star and favourite Moments will appear here/);
  assert.match(html, /Save your first Moment/);
  assert.match(html, /Insights will appear/);
});
