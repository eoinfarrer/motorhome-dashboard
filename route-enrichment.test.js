const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/../marine-backend/RouteEnrichment.js', 'utf8');
const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');
const secureBuilder = fs.readFileSync(__dirname + '/worker/build-secure.mjs', 'utf8');

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
  assert.equal(context.categoriseRoutePoi_({natural: 'peak'}), 'viewpoint');
  assert.equal(context.categoriseRoutePoi_({natural: 'saddle'}), 'viewpoint');
  assert.equal(context.categoriseRoutePoi_({mountain_pass: 'yes'}), 'viewpoint');
});

test('summits and mountain passes export as Garmin summit course points', () => {
  const route = context.normaliseEnrichmentRoute_({
    points: [{lat: 54.44, lon: -3.1}, {lat: 54.45, lon: -3.08}]
  });
  const summit = context.buildRoutePoiCandidate_({
    osmId: 'node/3', lat: 54.445, lon: -3.09,
    tags: {natural: 'peak', name: 'Example Pike'}
  }, route.points, 'hiking');
  const pass = context.buildRoutePoiCandidate_({
    osmId: 'node/4', lat: 54.445, lon: -3.09,
    tags: {mountain_pass: 'yes', name: 'Example Pass'}
  }, route.points, 'cycling');
  assert.equal(summit.categoryLabel, 'Summit');
  assert.equal(summit.fitType, 'summit');
  assert.match(summit.coursePointName, /^SUMMIT /);
  assert.equal(pass.categoryLabel, 'Mountain pass');
  assert.equal(pass.fitType, 'summit');
  assert.match(pass.coursePointName, /^PASS /);
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
  assert.match(query, /mountain_pass/);
  assert.match(query, /saddle/);
  assert.equal((query.match(/around:/g) || []).length, 1);
});

test('long routes are bounded to one eighty-point Overpass corridor', () => {
  const points = Array.from({length: 500}, (_, index) => ({lat: 50 + index / 10000, lon: -1, distanceM: index * 10}));
  const sampled = context.sampleRouteForOverpass_(points, 80);
  assert.equal(sampled.length, 80);
  assert.equal(sampled[0].distanceM, 0);
  assert.equal(sampled[79].distanceM, 4990);
});

test('browser map search divides long routes into bounded overlapping corridors', () => {
  const browserChunks = {};
  vm.createContext(browserChunks);
  vm.runInContext([
    frontendFunctionSource('routePointDistanceM'),
    frontendFunctionSource('routeOverpassChunks')
  ].join('\n'), browserChunks);
  const points = Array.from({length: 61}, (_, index) => ({lat: 0, lon: index / 100}));
  const chunks = browserChunks.routeOverpassChunks({route: {points}});
  assert.ok(chunks.length >= 6);
  assert.equal(chunks.every(chunk => chunk.length >= 2 && chunk.length <= 12), true);
  for (let index = 1; index < chunks.length; index++) {
    assert.deepEqual(chunks[index - 1].at(-1), chunks[index][0]);
  }
});

test('route enrichment queries OpenStreetMap directly and sends read-only ranking to its direct backend', () => {
  const loader = frontendFunctionSource('loadRouteEnrichment');
  const lookup = frontendFunctionSource('fetchRouteMapFeatures');
  const fallbackLookup = frontendFunctionSource('fetchRouteMapFeaturesOverpass');
  const browserQuery = {};
  vm.createContext(browserQuery);
  vm.runInContext([frontendFunctionSource('routeBoundingBox'), frontendFunctionSource('routeOverpassQuery')].join('\n'), browserQuery);
  const query = browserQuery.routeOverpassQuery({
    route: {points: [{lat: 54.44, lon: -3.1}, {lat: 54.45, lon: -3.08}]},
    settings: {corridorM: 400}
  });
  assert.match(query, /mountain_pass/);
  assert.match(query, /saddle/);
  assert.equal((query.match(/around:/g) || []).length, 0);
  assert.equal((query.match(/\(-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6},-?\d+\.\d{6}\);/g) || []).length, 5);
  assert.match(query, /54\.436/);
  assert.match(query, /-3\.106/);
  assert.doesNotMatch(query, /\[~"\^\(amenity/);
  assert.match(lookup, /AudreyOsmTiles\.fetchRoutePoiFeatures/);
  assert.match(lookup, /fetchRouteSummitFeatures/);
  assert.match(lookup, /fetchRouteMapFeaturesOverpass/);
  assert.match(fallbackLookup, /fetchOverpassJson\(routeOverpassQuery\(payload,chunks\[index\]\),15000\)/);
  assert.match(fallbackLookup, /Math\.min\(2,chunks\.length\)/);
  assert.match(loader, /action:'rank_route_pois'/);
  assert.match(loader, /fetch\(ROUTE_ENRICHMENT_API_URL/);
  assert.match(loader, /credentials:'same-origin'/);
  assert.doesNotMatch(loader, /credentials:'omit'/);
  assert.doesNotMatch(frontend, /maps\.mail\.ru/);
});

test('secure hosting sends only Audrey origin so Overpass permits browser requests', () => {
  assert.match(secureBuilder, /Referrer-Policy: strict-origin-when-cross-origin/);
  assert.doesNotMatch(secureBuilder, /Referrer-Policy: no-referrer/);
});

test('trip editor POST retains the Cloudflare Access session', () => {
  const saver = frontendFunctionSource('saveTripEditor');
  assert.match(saver, /credentials:'same-origin'/);
  assert.doesNotMatch(saver, /credentials:'omit'/);
});

test('POI rows separate the name from metadata and avoid duplicate fallback labels', () => {
  const ui = {
    actRouteEnrichment: {
      pois: [{name: 'Toilets', categoryLabel: 'Toilets', routeDistanceM: 8200, offsetM: 9, estimatedDetourM: 17, selected: false}],
      attribution: 'Map data'
    },
    actSelectedRoute: null,
    actAnalysisResults: null,
    actFitExportStatus: ''
  };
  vm.createContext(ui);
  vm.runInContext([
    frontendFunctionSource('escapeDoHtml'),
    frontendFunctionSource('routeWeatherCoursePoints'),
    frontendFunctionSource('buildRouteEnrichmentCard')
  ].join('\n'), ui);
  const html = ui.buildRouteEnrichmentCard();
  assert.match(html, /route-poi-name">Toilets<\/span><span class="route-poi-meta">9m off route/);
  assert.doesNotMatch(html, /Toilets · 9m off route/);
  assert.doesNotMatch(frontend, /Download alert GPX/);
});

test('weather risks become Garmin danger course points for the combined FIT', () => {
  const ui = {
    actSelectedRoute: {segments: [
      {type: 'start', distanceKm: 0, overallRisk: 'caution'},
      {type: 'summit', distanceKm: 4.3, overallRisk: 'caution'}
    ]},
    actAnalysisResults: {segments: [
      {risks: [{type: 'wind', label: '⚠ Strong crosswind'}]},
      {overallRisk: 'caution', risks: [{type: 'wind', label: '⚠ Strong crosswind'}]}
    ]}
  };
  vm.createContext(ui);
  vm.runInContext(frontendFunctionSource('routeWeatherCoursePoints'), ui);
  const points = ui.routeWeatherCoursePoints();
  assert.equal(points.length, 1);
  assert.equal(points[0].fitType, 'danger');
  assert.equal(points[0].routeDistanceM, 4300);
  assert.match(points[0].coursePointName, /^WIND STRONG CROSSWIND/);
});
