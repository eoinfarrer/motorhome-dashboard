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
  Array, String,
  escapeDoHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
};
vm.createContext(context);
vm.runInContext(functionSource('buildHomeFloodSafety'), context);

test('Home hides flood safety when there are no active official warnings', () => {
  assert.equal(context.buildHomeFloodSafety({monitoring:true, alerts:[]}), '');
});

test('Home renders warning severity, affected stop and official link', () => {
  const html = context.buildHomeFloodSafety({monitoring:true, alerts:[{
    severity:'warning', title:'River Derwent at Keswick', riverOrSea:'River Derwent',
    targets:[{label:'Keswick campsite'}], url:'https://environment.data.gov.uk/flood-monitoring/id/floods/123'
  }]});
  assert.match(html, /Flood warning/);
  assert.match(html, /Keswick campsite/);
  assert.match(html, /Official warning details/);
  assert.match(html, /home-flood-warning/);
});

test('Home displays German source attribution, update time and licence', () => {
  const html = context.buildHomeFloodSafety({monitoring:true, alerts:[{
    severity:'alert', title:'Flood watch · Test district', riverOrSea:'Test district',
    provider:'Länderübergreifendes Hochwasserportal (LHP)',
    sourceUpdated:'2026-10-29T21:32:47+01:00', licence:'CC BY 4.0',
    targets:[{label:'Bavaria'}], url:'https://www.hochwasserzentralen.de/'
  }]});
  assert.match(html, /Länderübergreifendes Hochwasserportal/);
  assert.match(html, /2026-10-29T21:32:47/);
  assert.match(html, /CC BY 4.0/);
});
