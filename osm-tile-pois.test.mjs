import assert from 'node:assert/strict';
import test from 'node:test';
import {isWantedPoiProperties, lonLatToTileFraction, routeTileIds} from './src/osm-tile-pois.mjs';

test('route tile selection follows a route corridor without unbounded downloads', () => {
  const route = [
    {lat: 53.928, lon: -1.386},
    {lat: 53.904, lon: -1.326},
    {lat: 53.883, lon: -1.264}
  ];
  const tiles = routeTileIds(route, 400);
  assert.ok(tiles.length >= 8);
  assert.ok(tiles.length < 40);
  assert.equal(new Set(tiles.map(tile => `${tile.z}/${tile.x}/${tile.y}`)).size, tiles.length);
  assert.equal(tiles.every(tile => tile.z === 14), true);
});

test('route tile selection caps exceptionally long routes', () => {
  const points = Array.from({length: 300}, (_, index) => ({lat: 45, lon: index / 50}));
  assert.equal(routeTileIds(points, 750).length, 120);
});

test('official Shortbread POIs cover Audrey useful-stop categories', () => {
  assert.equal(isWantedPoiProperties({amenity: 'drinking_water'}), true);
  assert.equal(isWantedPoiProperties({amenity: 'toilets'}), true);
  assert.equal(isWantedPoiProperties({shop: 'bicycle'}), true);
  assert.equal(isWantedPoiProperties({tourism: 'alpine_hut'}), true);
  assert.equal(isWantedPoiProperties({amenity: 'place_of_worship'}), false);
});

test('tile projection is stable at known coordinates', () => {
  const tile = lonLatToTileFraction(51.5074, -0.1278, 14);
  assert.equal(Math.floor(tile.x), 8186);
  assert.equal(Math.floor(tile.y), 5448);
});
