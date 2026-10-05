import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';

const TILE_ZOOM = 14;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAX_ROUTE_TILES = 120;
const TILE_URL = 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function haversineM(left, right) {
  const lat1 = Number(left.lat) * Math.PI / 180;
  const lat2 = Number(right.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (Number(right.lon) - Number(left.lon)) * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function lonLatToTileFraction(lat, lon, zoom = TILE_ZOOM) {
  const scale = 2 ** zoom;
  const safeLat = clamp(Number(lat), -85.05112878, 85.05112878);
  const latRad = safeLat * Math.PI / 180;
  return {
    x: (Number(lon) + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * scale
  };
}

function addCorridorTiles(result, lat, lon, corridorM, zoom) {
  const point = lonLatToTileFraction(lat, lon, zoom);
  const scale = 2 ** zoom;
  const groundTileM = EARTH_CIRCUMFERENCE_M * Math.max(0.08, Math.cos(Number(lat) * Math.PI / 180)) / scale;
  const radiusTiles = Math.max(0.04, Number(corridorM || 500) / groundTileM);
  const minX = Math.floor(point.x - radiusTiles);
  const maxX = Math.floor(point.x + radiusTiles);
  const minY = Math.floor(point.y - radiusTiles);
  const maxY = Math.floor(point.y + radiusTiles);
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (x >= 0 && y >= 0 && x < scale && y < scale) result.set(`${zoom}/${x}/${y}`, {z: zoom, x, y});
    }
  }
}

export function routeTileIds(points, corridorM, options = {}) {
  const zoom = options.zoom || TILE_ZOOM;
  const maximum = options.maximum || MAX_ROUTE_TILES;
  const tiles = new Map();
  const valid = (points || []).filter(point => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)));
  for (let index = 0; index < valid.length; index++) {
    const current = valid[index];
    if (index === 0) addCorridorTiles(tiles, current.lat, current.lon, corridorM, zoom);
    else {
      const previous = valid[index - 1];
      const distanceM = haversineM(previous, current);
      const steps = Math.max(1, Math.ceil(distanceM / 500));
      for (let step = 1; step <= steps; step++) {
        const ratio = step / steps;
        addCorridorTiles(tiles,
          Number(previous.lat) + (Number(current.lat) - Number(previous.lat)) * ratio,
          Number(previous.lon) + (Number(current.lon) - Number(previous.lon)) * ratio,
          corridorM, zoom);
      }
    }
  }
  const all = Array.from(tiles.values());
  if (all.length <= maximum) return all;
  const sampled = [];
  const step = (all.length - 1) / (maximum - 1);
  for (let index = 0; index < maximum; index++) sampled.push(all[Math.round(index * step)]);
  return sampled;
}

export function isWantedPoiProperties(properties) {
  const amenity = properties.amenity || '';
  const shop = properties.shop || '';
  const tourism = properties.tourism || '';
  return /^(drinking_water|restaurant|fast_food|cafe|toilets|bicycle_repair_station|shelter|pharmacy)$/.test(amenity)
    || /^(supermarket|convenience|bakery|deli|bicycle)$/.test(shop)
    || /^(alpine_hut|viewpoint)$/.test(tourism);
}

export function decodePoiTile(buffer, tile) {
  const decoded = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const layer = decoded.layers.pois;
  if (!layer) return [];
  const features = [];
  for (let index = 0; index < layer.length; index++) {
    const feature = layer.feature(index);
    const properties = feature.properties || {};
    if (!isWantedPoiProperties(properties)) continue;
    const geojson = feature.toGeoJSON(tile.x, tile.y, tile.z);
    if (!geojson.geometry || geojson.geometry.type !== 'Point') continue;
    const coordinates = geojson.geometry.coordinates;
    features.push({
      osmId: `tile/${tile.z}/${tile.x}/${tile.y}/${index}`,
      lat: Number(coordinates[1]),
      lon: Number(coordinates[0]),
      tags: properties
    });
  }
  return features;
}

export async function fetchRoutePoiFeatures(points, corridorM, options = {}) {
  const tiles = routeTileIds(points, corridorM, options);
  const fetchImpl = options.fetch || fetch;
  const concurrency = Math.min(6, tiles.length);
  const results = new Array(tiles.length);
  let next = 0;
  let failures = 0;
  async function worker() {
    while (next < tiles.length) {
      const index = next++;
      const tile = tiles[index];
      const url = TILE_URL.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
      try {
        const response = await fetchImpl(url, {headers: {'Accept': 'application/vnd.mapbox-vector-tile'}});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        results[index] = decodePoiTile(await response.arrayBuffer(), tile);
      } catch (error) {
        failures++;
        results[index] = [];
      }
    }
  }
  await Promise.all(Array.from({length: concurrency}, worker));
  const features = results.flat();
  if (!features.length && failures === tiles.length && tiles.length) throw new Error('OpenStreetMap tiles unavailable');
  return {features, tileCount: tiles.length, partial: failures > 0};
}
