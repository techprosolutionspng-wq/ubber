import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, SafeAreaView, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { io } from 'socket.io-client';
import Constants from 'expo-constants';

// Backend URL is set in app.json -> expo.extra.serverUrl
const SERVER = Constants.expoConfig?.extra?.serverUrl;
const FALLBACK = { lat: -9.4438, lng: 147.1803 }; // Port Moresby
const STATUS = { searching: 'Finding a driver…', accepted: 'Driver on the way', arrived: 'Driver has arrived',
  in_progress: 'Trip in progress', completed: 'Trip complete', cancelled: 'Ride cancelled', no_drivers: 'No drivers available' };

// Free OpenStreetMap map via Leaflet (no Google key needed)
const HTML = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<style>html,body,#m{height:100%;margin:0}</style></head><body><div id="m"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
var map=L.map('m').setView([0,0],2);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
var layer=L.layerGroup().addTo(map);var fitted=false;
map.on('click',function(e){window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}));});
window.setMarkers=function(list,focus){
  layer.clearLayers();
  list.forEach(function(m){L.circleMarker([m.lat,m.lng],{radius:10,color:'#fff',weight:3,fillColor:m.color,fillOpacity:1}).bindTooltip(m.label||'').addTo(layer);});
  if(!fitted&&focus){map.setView([focus.lat,focus.lng],15);fitted=true;}
};
</script></body></html>`;

function MapWeb({ markers, focus, onTap }) {
  const ref = useRef(null), ready = useRef(false);
  const push = () => ref.current?.injectJavaScript(
    `window.setMarkers(${JSON.stringify(markers)},${JSON.stringify(focus)});true;`);
  useEffect(() => { if (ready.current) push(); }, [JSON.stringify(markers), focus?.lat, focus?.lng]);
  return (
    <WebView ref={ref} style={{ flex: 1 }} originWhitelist={['*']}
      source={{ html: HTML, baseUrl: SERVER }} javaScriptEnabled domStorageEnabled
      onLoadEnd={() => { ready.current = true; push(); }}
      onMessage={e => { try { onTap && onTap(JSON.parse(e.nativeEvent.data)); } catch (_) {} }} />
  );
}

function useSocket() {
  const ref = useRef(null);
  if (!ref.current) ref.current = io(SERVER, { transports: ['websocket'] });
  useEffect(() => () => ref.current.disconnect(), []);
  return ref.current;
}
function useMyLocation() {
  const [loc, setLoc] = useState(null);
  useEffect(() => { (async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return setLoc(FALLBACK);
      const p = await Location.getCurrentPositionAsync({});
      setLoc({ lat: p.coords.latitude, lng: p.coords.longitude });
    } catch (e) { setLoc(FALLBACK); }
  })(); }, []);
  return loc;
}
const Btn = ({ title, onPress, color = '#111', disabled }) => (
  <TouchableOpacity style={[s.btn, { backgroundColor: disabled ? '#aaa' : color }]} onPress={onPress} disabled={disabled}>
    <Text style={s.btnT}>{title}</Text></TouchableOpacity>);

function Rider({ socket }) {
  const loc = useMyLocation();
  const [dropoff, setDropoff] = useState(null), [quote, setQuote] = useState(null);
  const [ride, setRide] = useState(null), [driverLoc, setDriverLoc] = useState(null);
  useEffect(() => {
    socket.on('ride:update', setRide); socket.on('driver:location', setDriverLoc);
    return () => { socket.off('ride:update'); socket.off('driver:location'); };
  }, []);
  useEffect(() => { if (loc && dropoff) socket.emit('fare:quote', { pickup: loc, dropoff }, setQuote); }, [loc, dropoff]);
  if (!loc) return <Text style={s.center}>Locating…</Text>;
  const active = ride && !['completed', 'cancelled', 'no_drivers'].includes(ride.status);
  const reset = () => { setRide(null); setDropoff(null); setQuote(null); setDriverLoc(null); };
  const markers = [{ ...loc, color: '#2980b9', label: 'You' }];
  if (dropoff) markers.push({ ...dropoff, color: '#e74c3c', label: 'Drop-off' });
  const dl = driverLoc || ride?.driver?.loc;
  if (dl) markers.push({ ...dl, color: '#27ae60', label: 'Driver' });
  return (<View style={{ flex: 1 }}>
    <MapWeb markers={markers} focus={loc} onTap={p => !ride && setDropoff(p)} />
    <View style={s.panel}>
      {!ride && <>
        <Text style={s.h}>{dropoff ? 'Confirm ride' : 'Tap the map to set your drop-off'}</Text>
        {quote && <Text style={s.p}>{quote.distanceKm} km · ~{quote.etaMin} min · {quote.currency} {quote.fare.toFixed(2)}</Text>}
        <Btn title="Request ride" disabled={!quote} onPress={() => socket.emit('ride:request', { pickup: loc, dropoff }, setRide)} />
      </>}
      {ride && <>
        <Text style={s.h}>{STATUS[ride.status]}</Text>
        {ride.driver && <Text style={s.p}>Driver: {ride.driver.name}</Text>}
        <Text style={s.p}>Fare: {ride.quote.currency} {ride.quote.fare.toFixed(2)}</Text>
        {active ? <Btn title="Cancel" color="#c0392b" onPress={() => socket.emit('ride:cancel', ride.id)} /> : <Btn title="Done" onPress={reset} />}
      </>}
    </View></View>);
}

function Driver({ socket, name }) {
  const loc = useMyLocation();
  const [online, setOnline] = useState(false), [offer, setOffer] = useState(null), [ride, setRide] = useState(null);
  const watch = useRef(null);
  useEffect(() => {
    socket.on('ride:offer', setOffer); socket.on('ride:offer_expired', () => setOffer(null));
    socket.on('ride:update', r => { setRide(r); setOffer(null); });
    return () => { ['ride:offer', 'ride:offer_expired', 'ride:update'].forEach(e => socket.off(e)); watch.current?.remove(); };
  }, []);
  const toggle = async () => {
    if (!online) {
      socket.emit('driver:online', { name, loc });
      watch.current = await Location.watchPositionAsync({ distanceInterval: 10, timeInterval: 3000 },
        p => socket.emit('driver:location', { lat: p.coords.latitude, lng: p.coords.longitude }));
    } else { socket.emit('driver:offline'); watch.current?.remove(); }
    setOnline(!online);
  };
  if (!loc) return <Text style={s.center}>Locating…</Text>;
  const next = { accepted: ['I\'ve arrived', 'ride:arrived'], arrived: ['Start trip', 'ride:start'], in_progress: ['Complete trip', 'ride:complete'] }[ride?.status];
  const live = ride && !['completed', 'cancelled'].includes(ride.status);
  const markers = [{ ...loc, color: '#2980b9', label: 'You' }];
  if (ride) { markers.push({ ...ride.pickup, color: '#f39c12', label: 'Pickup' }); markers.push({ ...ride.dropoff, color: '#e74c3c', label: 'Drop-off' }); }
  return (<View style={{ flex: 1 }}>
    <MapWeb markers={markers} focus={loc} />
    <View style={s.panel}>
      {!live && !offer && <>
        <Text style={s.h}>{ride ? STATUS[ride.status] : online ? 'Waiting for ride requests…' : 'You are offline'}</Text>
        <Btn title={online ? 'Go offline' : 'Go online'} color={online ? '#c0392b' : '#27ae60'} onPress={toggle} />
        {ride && <Btn title="Dismiss" onPress={() => setRide(null)} />}
      </>}
      {offer && <>
        <Text style={s.h}>New ride request</Text>
        <Text style={s.p}>Pickup {offer.pickupKm} km away · {offer.quote.currency} {offer.quote.fare.toFixed(2)}</Text>
        <Btn title="Accept" color="#27ae60" onPress={() => socket.emit('ride:accept', offer.id)} />
        <Btn title="Decline" color="#c0392b" onPress={() => { socket.emit('ride:decline', offer.id); setOffer(null); }} />
      </>}
      {live && <>
        <Text style={s.h}>{STATUS[ride.status]}</Text>
        {next && <Btn title={next[0]} onPress={() => socket.emit(next[1], ride.id)} />}
        <Btn title="Cancel ride" color="#c0392b" onPress={() => socket.emit('ride:cancel', ride.id)} />
      </>}
    </View></View>);
}

export default function App() {
  const socket = useSocket();
  const [role, setRole] = useState(null), [name, setName] = useState('');
  return (<SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
    {!role ? (<View style={s.home}>
      <Text style={s.logo}>Ubber</Text>
      <TextInput style={s.input} placeholder="Your name" value={name} onChangeText={setName} />
      <Btn title="I need a ride" onPress={() => name.trim() ? setRole('rider') : Alert.alert('Enter your name')} />
      <Btn title="I'm a driver" color="#27ae60" onPress={() => name.trim() ? setRole('driver') : Alert.alert('Enter your name')} />
    </View>) : role === 'rider' ? <Rider socket={socket} /> : <Driver socket={socket} name={name} />}
  </SafeAreaView>);
}

const s = StyleSheet.create({
  home: { flex: 1, justifyContent: 'center', padding: 24 }, logo: { fontSize: 42, fontWeight: '800', textAlign: 'center', marginBottom: 24 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 14, marginBottom: 12, fontSize: 16 },
  btn: { padding: 16, borderRadius: 12, marginTop: 10, alignItems: 'center' }, btnT: { color: '#fff', fontWeight: '700', fontSize: 16 },
  panel: { padding: 18, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  h: { fontSize: 20, fontWeight: '700' }, p: { fontSize: 15, color: '#444', marginTop: 4 }, center: { textAlign: 'center', marginTop: 80 } });
