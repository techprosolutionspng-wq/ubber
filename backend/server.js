const express = require('express'), http = require('http'), cors = require('cors');
const { Server } = require('socket.io');
const app = express(); app.use(cors(), express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const RATE = { base: 3, perKm: 1.2, perMin: 0.3, min: 5, currency: process.env.CURRENCY || 'USD' };
const OFFER_TIMEOUT_MS = 15000;
const drivers = new Map(); // socket.id -> {id,name,loc,online,busy}
const rides = new Map();   // rideId -> ride
let seq = 1;

const km = (a, b) => {
  const r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const quote = (p, d) => {
  const dist = km(p, d) * 1.3, mins = dist * 2; // ~30 km/h average
  const f = Math.max(RATE.min, RATE.base + RATE.perKm * dist + RATE.perMin * mins);
  return { distanceKm: +dist.toFixed(2), etaMin: Math.ceil(mins), fare: +f.toFixed(2), currency: RATE.currency };
};
const publicRide = r => ({ id: r.id, status: r.status, pickup: r.pickup, dropoff: r.dropoff, quote: r.quote,
  driver: r.driverId && drivers.get(r.driverId) ? { name: drivers.get(r.driverId).name, loc: drivers.get(r.driverId).loc } : null });
const push = r => [r.riderId, r.driverId].filter(Boolean).forEach(id => io.to(id).emit('ride:update', publicRide(r)));

function dispatch(ride) {
  const c = [...drivers.values()].filter(d => d.online && !d.busy && d.loc && !ride.declined.has(d.id))
    .sort((a, b) => km(a.loc, ride.pickup) - km(b.loc, ride.pickup));
  if (!c.length) { ride.status = 'no_drivers'; return push(ride); }
  ride.offeredTo = c[0].id;
  io.to(c[0].id).emit('ride:offer', { ...publicRide(ride), pickupKm: +km(c[0].loc, ride.pickup).toFixed(2) });
  clearTimeout(ride.timer);
  ride.timer = setTimeout(() => { if (ride.status === 'searching') { ride.declined.add(ride.offeredTo); io.to(ride.offeredTo).emit('ride:offer_expired'); dispatch(ride); } }, OFFER_TIMEOUT_MS);
}
const release = ride => { const d = drivers.get(ride.driverId); if (d) d.busy = false; clearTimeout(ride.timer); };

io.on('connection', socket => {
  socket.on('fare:quote', (p, ack) => ack && ack(quote(p.pickup, p.dropoff)));

  socket.on('driver:online', ({ name, loc }) => drivers.set(socket.id, { id: socket.id, name: name || 'Driver', loc, online: true, busy: false }));
  socket.on('driver:offline', () => { const d = drivers.get(socket.id); if (d) d.online = false; });
  socket.on('driver:location', loc => {
    const d = drivers.get(socket.id); if (!d) return; d.loc = loc;
    const r = [...rides.values()].find(r => r.driverId === socket.id && ['accepted', 'arrived', 'in_progress'].includes(r.status));
    if (r) io.to(r.riderId).emit('driver:location', loc);
  });

  socket.on('ride:request', ({ pickup, dropoff }, ack) => {
    const ride = { id: String(seq++), riderId: socket.id, pickup, dropoff, quote: quote(pickup, dropoff), status: 'searching', declined: new Set() };
    rides.set(ride.id, ride); ack && ack(publicRide(ride)); dispatch(ride);
  });
  socket.on('ride:accept', id => {
    const r = rides.get(id), d = drivers.get(socket.id);
    if (!r || !d || r.status !== 'searching' || r.offeredTo !== socket.id) return;
    clearTimeout(r.timer); r.status = 'accepted'; r.driverId = socket.id; d.busy = true; push(r);
  });
  socket.on('ride:decline', id => {
    const r = rides.get(id); if (!r || r.status !== 'searching' || r.offeredTo !== socket.id) return;
    r.declined.add(socket.id); dispatch(r);
  });
  const step = (evt, from, to) => socket.on(evt, id => {
    const r = rides.get(id); if (!r || r.driverId !== socket.id || r.status !== from) return;
    r.status = to; if (to === 'completed') release(r); push(r);
  });
  step('ride:arrived', 'accepted', 'arrived'); step('ride:start', 'arrived', 'in_progress'); step('ride:complete', 'in_progress', 'completed');
  socket.on('ride:cancel', id => {
    const r = rides.get(id); if (!r || ![r.riderId, r.driverId].includes(socket.id) || ['completed', 'cancelled'].includes(r.status)) return;
    r.status = 'cancelled'; release(r); push(r);
  });
  socket.on('disconnect', () => {
    drivers.delete(socket.id);
    rides.forEach(r => { if ([r.riderId, r.driverId].includes(socket.id) && !['completed', 'cancelled'].includes(r.status)) { r.status = 'cancelled'; release(r); push(r); } });
  });
});

app.get('/health', (_, res) => res.json({ ok: true, driversOnline: [...drivers.values()].filter(d => d.online).length }));
server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Ubber backend on :' + (process.env.PORT || 3000)));
