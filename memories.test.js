const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const frontend = fs.readFileSync(__dirname + '/index.html', 'utf8');

function functionSource(name) {
  const start = frontend.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const open = frontend.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < frontend.length; index++) {
    if (frontend[index] === '{') depth++;
    if (frontend[index] === '}' && --depth === 0) return frontend.slice(start, index + 1);
  }
  throw new Error('unterminated function ' + name);
}

test('Moments uses one Home-only heart action and retains the dedicated deep link', () => {
  assert.match(frontend, /id="momentFab"/);
  assert.match(frontend, /classList\.toggle\('is-ready',currentAppView==='home'/);
  assert.doesNotMatch(frontend, /function buildHomeMoments/);
  assert.match(frontend, /get\('capture'\)==='moment'/);
});

test('Moment capture requests phone GPS but preserves an itinerary fallback', () => {
  assert.match(frontend, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(frontend, /currentLocationCoords/);
  assert.match(frontend, /Trip location fallback/);
});

test('Moment save carries trip, weather and activity context automatically', () => {
  assert.match(frontend, /'update_memory':'save_memory'/);
  assert.match(frontend, /tripName:currentData\.meta/);
  assert.match(frontend, /weatherSummary:currentMomentWeather\(\)/);
  assert.match(frontend, /activityId:activity&&activity\.id/);
});

test('Journey Review can edit and delete an existing Moment', () => {
  assert.match(frontend, /action:momentDraft\.editing\?'update_memory':'save_memory'/);
  assert.match(frontend, /action:'delete_memory'/);
  assert.match(frontend, /function openMomentEdit\(/);
  assert.match(frontend, /function deleteMoment\(/);
});

test('Moment capture exposes the native image picker and creates only a small JPEG thumbnail', () => {
  assert.match(frontend, /type="file" accept="image\/\*"/);
  assert.match(frontend, /canvas\.toBlob\(resolve,'image\/jpeg',0\.8\)/);
  assert.match(frontend, /momentThumbnailDimensions\([^,]+,[^,]+,300\)/);
  assert.match(frontend, /blob\.size>200\*1024/);
  assert.match(frontend, /The original stays in Apple Photos/);
});

test('thumbnail dimensions preserve aspect ratio and never upscale', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('momentThumbnailDimensions'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.momentThumbnailDimensions(1200, 600, 300))), {width: 300, height: 150});
  assert.deepEqual(JSON.parse(JSON.stringify(context.momentThumbnailDimensions(150, 100, 300))), {width: 150, height: 100});
});

test('photo persistence is a resilient second step after the Moment save', () => {
  const saveAt = frontend.indexOf("action:momentDraft.editing?'update_memory':'save_memory'");
  const uploadAt = frontend.indexOf("action:'upload_memory_thumbnail'");
  assert.ok(saveAt >= 0 && uploadAt > saveAt);
  assert.match(frontend, /Moment saved\.[\s\S]*Cover photo/);
  assert.match(frontend, /action:'remove_memory_thumbnail'/);
  assert.match(frontend, /action:'get_memory_thumbnail'/);
  assert.match(frontend, /Tap Save again to retry/);
});

test('duplicate thumbnail cards share one in-flight authenticated request', () => {
  assert.match(frontend, /momentThumbnailCache\[key\]=request/);
  assert.match(frontend, /delete momentThumbnailCache\[key\]/);
});
