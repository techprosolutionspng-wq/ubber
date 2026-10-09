# Ubber (MVP)
React Native (Expo) app + Node.js/Socket.io backend.

## 1. Deploy backend (Render)
Push this folder to GitHub -> Render > New > Blueprint (uses render.yaml). Copy the https URL.
Check `<url>/health` returns {"ok":true,...}.

## 2. Configure app (app/app.json)
- extra.serverUrl = your Render URL
- android.config.googleMaps.apiKey = Google Maps SDK for Android key

## 3. Build the APK
cd app && npm install
npm i -g eas-cli && eas login
eas build:configure   (accept defaults; keep eas.json)
eas build -p android --profile preview
Download the .apk from the link EAS prints and install it on the phone (allow "install unknown apps").
