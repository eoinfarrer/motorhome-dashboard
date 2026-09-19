const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/index.html', 'utf8');
const start = source.indexOf('function buildJourneyTrip(');
const end = source.indexOf('// ── AUDREY 2.0 HOME SCENES', start);
assert.ok(start >= 0 && end > start);
const context = {
  fmtDuration: minutes => `${minutes}m`
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

function check(name, meta, itinerary, days, stops) {
  test(name, () => {
    const html = context.buildJourneyTrip({meta, itinerary, runningTotal: {totalKm: 0}});
    assert.match(html, new RegExp(`journey-overview-value">${days}</div><div class="journey-overview-label">days`));
    assert.match(html, new RegExp(`journey-overview-value">${stops}</div><div class="journey-overview-label">stops`));
    assert.equal((html.match(/class="journey-point journey-trip-point /g) || []).length, itinerary.length);
    assert.match(html, /journey-leg-card/);
  });
}

check('Kefalonia: seven elapsed days, one hotel',
  {departDate:'2026-09-21', returnDate:'2026-09-28'},
  [
    {date:'2026-09-21',type:'DEPART',location:'Boston Spa'},
    {date:'2026-09-21',type:'DRIVE',location:'Leeds Bradford Airport'},
    {date:'2026-09-21',type:'FLIGHT',location:'Kefalonia Airport'},
    ...Array.from({length:8}, (_,i) => ({date:`2026-09-${String(21+i).padStart(2,'0')}`,type:'STAY',location:'White Rocks Hotel'})),
    {date:'2026-09-28',type:'FLIGHT',location:'Leeds Bradford Airport'},
    {date:'2026-09-28',type:'RETURN',location:'Boston Spa'}
  ], 7, 1);

check('Italy Winter: repeated stay days and flights count as one stop',
  {departDate:'2027-01-21', returnDate:'2027-02-05'},
  [
    {date:'2027-01-21',type:'DEPART',location:'Boston Spa'},
    {date:'2027-01-21',type:'FLIGHT',location:'Innsbruck Airport'},
    ...Array.from({length:15}, (_,i) => ({date:`2027-${i < 11 ? '01' : '02'}-${String(i < 11 ? 21+i : i-10).padStart(2,'0')}`,type:'STAY',location:'San Cassiano'})),
    {date:'2027-02-05',type:'RETURN',location:'Boston Spa'}
  ], 15, 1);

check('Tour: distinct overnight places, including stopovers',
  {departDate:'2027-06-29', returnDate:'2027-08-08'},
  [
    {date:'2027-06-29',type:'DEPART',location:'Boston Spa'},
    {date:'2027-06-29',type:'STOPOVER',location:'Hull'},
    {date:'2027-06-30',type:'ARRIVE',location:'Rotterdam'},
    {date:'2027-07-01',type:'STAY',location:'Armentarola'},
    {date:'2027-07-02',type:'STAY',location:'Armentarola'},
    {date:'2027-07-05',type:'DRIVE',location:'Venice'},
    {date:'2027-07-06',type:'STAY',location:'Camping Fusina'},
    {date:'2027-07-07',type:'STAY',location:' camping fusina '},
    {date:'2027-08-08',type:'FERRY',location:'Dover'},
    {date:'2027-08-08',type:'RETURN',location:'Boston Spa'}
  ], 40, 3);

check('A same-day trip is one day without an overnight stop',
  {departDate:'2027-05-03', returnDate:'2027-05-03'},
  [{date:'2027-05-03',type:'DEPART',location:'Home'},{date:'2027-05-03',type:'RETURN',location:'Home'}], 1, 0);
