const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/../marine-backend/RouteEnrichment.js', 'utf8');
const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');

function functionSource(name) {
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

function frontendFunctionSource(name) {
  const start = frontend.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing frontend function ' + name);
  const open = frontend.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < frontend.length; i++) {
    if (frontend[i] === '{') depth++;
    if (frontend[i] === '}' && --depth === 0) return frontend.slice(start, i + 1);
  }
  throw new Error('unterminated frontend function ' + name);
}

const context = {
  ROUTE_ENRICH_MAX_INPUT_POINTS: 1200,
  ROUTE_ENRICH_CATEGORY: {
    water: {label: 'Drinking water', fitType: 'water', weight: 30},
    food: {label: 'Food', fitType: 'food', weight: 21},
    cafe: {label: 'Cafe', fitType: 'food', weight: 20},
    toilets: {label: 'Toilets', fitType: 'toilet', weight: 24},
    bike_repair: {label: 'Bike repair', fitType: 'service', weight: 28},
    shelter: {label: 'Shelter', fitType: 'shelter', weight: 25},
    viewpoint: {label: 'Viewpoint', fitType: 'overlook', weight: 16},
    pharmacy: {label: 'Pharmacy', fitType: 'firstAid', weight: 15}
  }
};
vm.createContext(context);
vm.runInContext([
  'routeHaversineM_', 'normaliseEnrichmentRoute_', 'projectPointToRoute_',
  'sampleRouteForOverpass_',
  'categoriseRoutePoi_', 'routeCoursePointName_', 'scoreRoutePoi_',
  'buildRoutePoiCandidate_', 'normaliseRoutePoiName_', 'rankRoutePois_',
  'buildRouteOverpassQuery_'
].map(functionSource).join('\n'), context);

test('normalises cycling and hiking routes with cumulative distance', () => {
  const cycling = context.normaliseEnrichmentRoute_({
    name: 'Coast ride', activityType: 'cycling',
    points: [{lat: 0, lon: 0}, {lat: 0, lon: 0.01}, {lat: 0, lon: 0.02}]
  });
  assert.equal(cycling.activityType, 'cycling');
  assert.ok(cycling.distanceM > 2200 && cycling.distanceM < 2230);
  assert.ok(cycling.points[2].distanceM > cycling.points[1].distanceM);

  const hiking = context.normaliseEnrichmentRoute_({
    activityType: 'trail', points: [{lat: 51, lon: -1}, {lat: 51.01, lon: -1}]
  });
  assert.equal(hiking.activityType, 'hiking');
});

test('projects a POI to the nearest route position and estimates its offset', () => {
  const route = context.normaliseEnrichmentRoute_({
    points: [{lat: 0, lon: 0}, {lat: 0, lon: 0.01}]
  });
  const projection = context.projectPointToRoute_(0.001, 0.005, route.points);
  assert.ok(projection.routeDistanceM > 550 && projection.routeDistanceM < 563);
  assert.ok(projection.offsetM > 109 && projection.offsetM < 112);
  assert.equal(projection.segmentIndex, 0);
});

test('maps useful OpenStreetMap tags into export categories', () => {
  assert.equal(context.categoriseRoutePoi_({amenity: 'drinking_water'}), 'water');
  assert.equal(context.categoriseRoutePoi_({shop: 'bicycle'}), 'bike_repair');
  assert.equal(context.categoriseRoutePoi_({amenity: 'toilets'}), 'toilets');
  assert.equal(context.categoriseRoutePoi_({tourism: 'viewpoint'}), 'viewpoint');
});

test('excludes private POIs and prepares public POIs for later FIT export', () => {
  const route = context.normaliseEnrichmentRoute_({
    points: [{lat: 0, lon: 0}, {lat: 0, lon: 0.01}]
  });
  const privatePoi = context.buildRoutePoiCandidate_({
    osmId: 'node/1', lat: 0.0001, lon: 0.005,
    tags: {amenity: 'drinking_water', access: 'private'}
  }, route.points, 'cycling');
  assert.equal(privatePoi, null);

  const publicPoi = context.buildRoutePoiCandidate_({
    osmId: 'node/2', lat: 0.0001, lon: 0.005,
    tags: {amenity: 'drinking_water', name: 'Village Fountain'}
  }, route.points, 'cycling');
  assert.equal(publicPoi.category, 'water');
  assert.equal(publicPoi.fitType, 'water');
  assert.match(publicPoi.coursePointName, /^WATER /);
  assert.equal(publicPoi.estimatedDetourM, publicPoi.offsetM * 2);
});

test('ranking removes nearby name duplicates and returns POIs in route order', () => {
  const pois = [
    {name: 'Cafe Uno', category: 'cafe', routeDistanceM: 800, score: 20},
    {name: 'Cafe Uno', category: 'cafe', routeDistanceM: 900, score: 18},
    {name: 'Water', category: 'water', routeDistanceM: 200, score: 30}
  ];
  const ranked = context.rankRoutePois_(pois, ['water', 'cafe'], 30);
  assert.equal(ranked.map(p => p.routeDistanceM).join(','), '200,800');
});

test('Overpass query follows the supplied route corridor', () => {
  const query = context.buildRouteOverpassQuery_([
    {lat: 38.15164, lon: 20.4853}, {lat: 38.16, lon: 20.49}
  ], ['water', 'bike_repair', 'viewpoint'], 750);
  assert.match(query, /around:750,38\.151640,20\.485300,38\.160000,20\.490000/);
  assert.match(query, /drinking_water/);
  assert.match(query, /bicycle/);
  assert.match(query, /viewpoint/);
  assert.equal((query.match(/around:/g) || []).length, 1);
});

test('long routes are bounded to one eighty-point Overpass corridor', () => {
  const points = Array.from({length: 500}, (_, index) => ({lat: 50 + index / 10000, lon: -1, distanceM: index * 10}));
  const sampled = context.sampleRouteForOverpass_(points, 80);
  assert.equal(sampled.length, 80);
  assert.equal(sampled[0].distanceM, 0);
  assert.equal(sampled[79].distanceM, 4990);
});

test('POI rows separate the name from metadata and avoid duplicate fallback labels', () => {
  const ui = {
    actRouteEnrichment: {
      pois: [{name: 'Toilets', categoryLabel: 'Toilets', routeDistanceM: 8200, offsetM: 9, estimatedDetourM: 17, selected: false}],
      attribution: 'Map data'
    },
    actSelectedRoute: null,
    actFitExportStatus: ''
  };
  vm.createContext(ui);
  vm.runInContext([
    frontendFunctionSource('escapeDoHtml'),
    frontendFunctionSource('buildRouteEnrichmentCard')
  ].join('\n'), ui);
  const html = ui.buildRouteEnrichmentCard();
  assert.match(html, /route-poi-name">Toilets<\/span><span class="route-poi-meta">9m off route/);
  assert.doesNotMatch(html, /Toilets · 9m off route/);
});
