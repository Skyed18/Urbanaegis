import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadHotspotDatasets, normalizeCrimeStateName } from './dataLoader.js';
import { NATIONAL_HIGHWAY_CONTACTS, STATE_OPTIONS, getStateEmergencyContacts } from './emergencyContacts.js';
import { CITY_COORDINATES } from './cityCoordinates.js';
import { auth, db, storage } from './firebase.js';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

const app = document.querySelector('#app');
const DEFAULT_USER_LOCATION = { lat: 12.9716, lng: 77.5946 };
const MAP_ROUTE_HASH = '#maps';
const DASHBOARD_ROUTE_HASH = '#dashboard';
const HELP_ROUTE_HASH = '#help';
const REPORT_ROUTE_HASH = '#report';
const LOGIN_ROUTE_HASH = '#login';
const CRIME_NEWS_LINKS = [
  {
    title: 'Deccan Herald',
    url: 'https://www.deccanherald.com/bengaluru-crime',
  },
  {
    title: 'NDTV',
    url: 'https://www.ndtv.com/topic/crime',
  },
  {
    title: 'The Hindu',
    url: 'https://www.bing.com/search?q=crime%20news&qs=n&form=QBRE&sp=-1&ghc=1&lq=0&pq=crime%20new&sc=12-9&sk=&cvid=64071EDD618E4522A29AB20A547585F7',
  },
  {
    title: 'Times Now',
    url: 'https://www.timesnownews.com/',
  },
];
const INDIA_BOUNDS = [
  [6.2, 68.1],
  [37.7, 98.7],
];

const safeZones = [
  { name: 'Central Safe Zone Hub', lat: 28.6139, lng: 77.209 },
  { name: 'North Safe Operations Center', lat: 28.7041, lng: 77.1025 },
  { name: 'West Safe Mobility Point', lat: 28.5355, lng: 77.391 },
  { name: 'South Emergency Coordination Node', lat: 12.9716, lng: 77.5946 },
  { name: 'East Resilience Support Hub', lat: 22.5726, lng: 88.3639 },
];

const emergencyServices = [
  { type: 'Police Station', name: 'City Central Police', lat: 28.6328, lng: 77.2197 },
  { type: 'Hospital', name: 'Metro Emergency Hospital', lat: 28.6228, lng: 77.2323 },
  { type: 'Fire Station', name: 'Civic Fire Response', lat: 28.6449, lng: 77.2167 },
  { type: 'Police Station', name: 'Riverfront Police Unit', lat: 22.5665, lng: 88.3476 },
  { type: 'Hospital', name: 'Urban Trauma Center', lat: 19.0826, lng: 72.877 },
  { type: 'Fire Station', name: 'Rapid Fire Control', lat: 12.9838, lng: 77.5838 },
];

let currentMap = null;
let hotspotsPromise = null;
let currentEmergencyPanel = null;
let currentEmergencyFeedback = null;
let currentNearestServicesList = null;
let currentSosFab = null;
let activityIndexPromise = null;
let districtDemographicsIndexPromise = null;
let insightsDistrictDatasetPromise = null;
let insightsLiveTimer = null;
let insightsLiveContext = null;
let appLoadingOverlay = null;
let currentAuthUser = null;
let authObserverInitialized = false;
let authStateReady = false;
let resolveAuthStateReady = null;
const authStateReadyPromise = new Promise((resolve) => {
  resolveAuthStateReady = resolve;
});
const helpPlacesCache = new Map();
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function showAppLoader(message = 'Preparing UrbanAegis...') {
  if (appLoadingOverlay) {
    const status = appLoadingOverlay.querySelector('#appLoaderStatus');
    if (status) status.textContent = message;
    return;
  }

  appLoadingOverlay = document.createElement('div');
  appLoadingOverlay.className = 'app-loader visible';
  appLoadingOverlay.innerHTML = `
    <div class="app-loader-card" role="status" aria-live="polite" aria-label="Loading application">
      <span class="app-loader-spinner" aria-hidden="true"></span>
      <p class="app-loader-title">UrbanAegis</p>
      <p class="app-loader-text" id="appLoaderStatus">${message}</p>
    </div>
  `;

  document.body.appendChild(appLoadingOverlay);
}

function hideAppLoader() {
  if (!appLoadingOverlay) return;

  const overlay = appLoadingOverlay;
  appLoadingOverlay = null;
  overlay.classList.remove('visible');

  window.setTimeout(() => {
    overlay.remove();
  }, 240);
}

function formatDistanceKm(value) {
  return `${value.toFixed(1)} km`;
}

function haversineDistanceKm(pointA, pointB) {
  const earthRadiusKm = 6371;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(pointB.lat - pointA.lat);
  const dLng = toRad(pointB.lng - pointA.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(pointA.lat)) *
      Math.cos(toRad(pointB.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function getNearestLocations(fromLocation, list, count = 3) {
  return [...list]
    .map((item) => ({
      ...item,
      distanceKm: haversineDistanceKm(fromLocation, item),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, count);
}

function createNav(activeRoute) {
  const loginMenuItem = currentAuthUser
    ? `<li><a href="${LOGIN_ROUTE_HASH}" data-route-link="login" class="nav-user-avatar ${activeRoute === 'login' ? 'active' : ''}" aria-label="Account">👤</a></li>`
    : `<li><a href="${LOGIN_ROUTE_HASH}" data-route-link="login" class="${activeRoute === 'login' ? 'active' : ''}">Login</a></li>`;

  return `
    <header class="nav-shell" id="home">
      <nav class="nav-glass">
        <a class="brand" href="#home" aria-label="UrbanAegis home">
          <span class="brand-icon" aria-hidden="true">🛡</span>
          <span>UrbanAegis</span>
        </a>
        <ul class="menu">
          <li><a href="#home" data-route-link="home" class="${activeRoute === 'home' ? 'active' : ''}">Home</a></li>
          <li><a href="${DASHBOARD_ROUTE_HASH}" data-route-link="dashboard" class="${activeRoute === 'dashboard' ? 'active' : ''}">Dashboard</a></li>
          <li><a href="${MAP_ROUTE_HASH}" data-route-link="map" class="${activeRoute === 'map' ? 'active' : ''}">Risk Map</a></li>
          <li><a href="${REPORT_ROUTE_HASH}" data-route-link="report" class="${activeRoute === 'report' ? 'active' : ''}">Report</a></li>
          ${loginMenuItem}
          <li><a href="${HELP_ROUTE_HASH}" data-route-link="help" class="${activeRoute === 'help' ? 'active' : ''}">Help</a></li>
        </ul>
      </nav>
    </header>`;
}

function createInsightsSection() {
  return `
    <section class="section" id="insights">
      <div class="insights-shell card">
        <h2>NEWS Insights</h2>
        <div class="insights-content">
          <div class="news-layout">
            <aside class="news-list" id="insightsNewsList"></aside>
            <div class="news-viewer" id="insightsNewsViewer">
              <iframe id="insightsNewsFrame" class="news-iframe" title="Crime news viewer"></iframe>
            </div>
          </div>
        </div>

        <div class="insights-risk" id="insightsRiskDashboard">
          <div class="insights-risk-header">
            <div>
              <h3>Safety Score</h3>
              <p id="insightsRiskMeta">Allow location access to compare your area risk level in real time.</p>
            </div>
            <button type="button" class="btn btn-secondary insights-locate-btn" id="insightsUseLocation">Use My Location</button>
          </div>

          <div class="insights-risk-grid">
            <article class="insights-risk-card">
              <p class="insights-kicker">Area Safety Score</p>
              <p class="insights-score" id="insightsAreaScore">--</p>
              <p class="insights-level" id="insightsAreaRiskLevel">Waiting for location...</p>
              <p class="insights-location" id="insightsAreaLocation">—</p>
              <p class="insights-note" id="insightsAreaNote">No comparison data yet.</p>
            </article>

            <article class="insights-risk-card">
              <p class="insights-kicker">Score Breakdown</p>
              <div class="insights-bar-row"><span>Crime Risk</span><span id="insightsCrimeRiskText">0%</span></div>
              <div class="insights-bar-track"><div id="insightsCrimeRiskBar" class="insights-bar-fill danger"></div></div>

              <div class="insights-bar-row"><span>Accident Risk</span><span id="insightsAccidentRiskText">0%</span></div>
              <div class="insights-bar-track"><div id="insightsAccidentRiskBar" class="insights-bar-fill warning"></div></div>

              <div class="insights-bar-row"><span>Daytime Factor</span><span id="insightsDayFactorText">0%</span></div>
              <div class="insights-bar-track"><div id="insightsDayFactorBar" class="insights-bar-fill info"></div></div>
            </article>

            <article class="insights-risk-card">
              <p class="insights-kicker" id="insightsDistrictTitle">Your District</p>
              <div class="insights-stat-grid">
                <div><span>Murder</span><strong id="insightsMurder">0</strong></div>
                <div><span>Rape</span><strong id="insightsRape">0</strong></div>
                <div><span>Robbery</span><strong id="insightsRobbery">0</strong></div>
                <div><span>Assault</span><strong id="insightsAssault">0</strong></div>
                <div><span>Hit & Run</span><strong id="insightsHitRun">0</strong></div>
                <div><span>Accidents</span><strong id="insightsAccidents">0</strong></div>
              </div>
              <p class="insights-note" id="insightsDistrictCompare">Comparison will appear after location is detected.</p>
            </article>
          </div>
        </div>
      </div>
    </section>
  `;
}

function createHomePage() {
  return `
    <main class="landing">
      ${createNav('home')}
      <section class="hero" id="hero" aria-label="Smart city risk map overview">
        <div class="hero-map-overlay" aria-hidden="true">
          <span class="node n1"></span>
          <span class="node n2"></span>
          <span class="node n3"></span>
          <span class="node n4"></span>
          <span class="node n5"></span>
          <span class="node n6"></span>
        </div>
        <div class="hero-content">
          <p class="eyebrow">Smart City Control Center</p>
          <h1>Predict. Prevent. Protect.</h1>
          <p class="subheading">UrbanAegis intelligence for safer cities</p>
          <div class="hero-cta">
            <a href="${MAP_ROUTE_HASH}" class="btn btn-primary" data-open-map>Open Risk Map</a>
            <a href="${DASHBOARD_ROUTE_HASH}" class="btn btn-secondary" data-route-link="dashboard">Open Dashboard</a>
          </div>
        </div>
      </section>

      ${createInsightsSection()}

      <footer class="section footer" id="contact">
        <p>UrbanAegis · Control · Awareness · Preparedness</p>
      </footer>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function createDashboardPage() {
  const stateOptions = STATE_OPTIONS.map((stateName) => `<option value="${stateName}">${stateName}</option>`).join('');

  return `
    <main class="dashboard-page">
      ${createNav('dashboard')}

      <section class="section dashboard-layout" id="dashboard">
        <article class="risk-panel dashboard-card">
          <h2>Risk Indicator</h2>
          <p class="risk-text">Current City Risk Level: <strong id="dashboardRiskLevel">Moderate</strong></p>
          <div id="dashboardGauge" class="gauge" role="img" aria-label="Current city risk level moderate"></div>
        </article>

        <article class="dashboard-card activity-card">
          <h2>State & District Activity Record</h2>
          <div class="dashboard-form-grid">
            <div>
              <label class="field-label" for="activityStateSelect">Select state</label>
              <div class="select-wrap">
                <select id="activityStateSelect" class="select-field">
                  ${stateOptions}
                </select>
              </div>
            </div>
            <div>
              <label class="field-label" for="activityDistrictSelect">Select district</label>
              <div class="select-wrap">
                <select id="activityDistrictSelect" class="select-field"></select>
              </div>
            </div>
          </div>

          <h3>Individual Activities Graph</h3>
          <div id="activityGraph" class="activity-graph" aria-live="polite">Loading graph...</div>
        </article>

        <article class="dashboard-card city-ranking-card">
          <h2>State Rankings by Activity</h2>
          <div class="city-ranking-grid">
            <div class="ranking-section">
              <h3>All Crime States</h3>
              <ul id="crimeRankingList" class="ranking-list" aria-live="polite">Loading rankings...</ul>
            </div>
            <div class="ranking-section">
              <h3>All Accident States</h3>
              <ul id="accidentRankingList" class="ranking-list" aria-live="polite">Loading rankings...</ul>
            </div>
          </div>
        </article>

        <article class="dashboard-card timeline-card">
          <h2>24-Hour Safety Timeline</h2>
          <p class="timeline-subtext" id="timelineSummary">Calculating safest time window...</p>
          <div id="safetyTimeline" class="safety-timeline" aria-live="polite">Loading timeline...</div>
        </article>
      </section>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function createHelpPage() {
  const cityOptions = Object.keys(CITY_COORDINATES)
    .sort((a, b) => a.localeCompare(b))
    .map((cityName) => `<option value="${cityName}">${cityName}</option>`)
    .join('');

  return `
    <main class="help-page">
      ${createNav('help')}

      <section class="section help-layout" id="help">
        <article class="dashboard-card help-card help-card-wide">
          <h2>City Emergency Help</h2>
          <p class="help-intro">Select a city to view the nearest hospitals and police stations.</p>

          <div class="dashboard-form-grid help-form-grid">
            <div>
              <label class="field-label" for="helpCitySelect">Select city</label>
              <div class="select-wrap">
                <select id="helpCitySelect" class="select-field">
                  ${cityOptions}
                </select>
              </div>
            </div>
          </div>

          <p class="help-meta" id="helpMeta">Choose a city to load nearest emergency services.</p>
        </article>

        <article class="dashboard-card help-card">
          <h2>Nearest Hospitals</h2>
          <ul id="helpHospitalList" class="help-service-list" aria-live="polite"></ul>
        </article>

        <article class="dashboard-card help-card">
          <h2>Nearest Police Stations</h2>
          <ul id="helpPoliceList" class="help-service-list" aria-live="polite"></ul>
        </article>
      </section>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function createReportPage() {
  return `
    <main class="report-page">
      ${createNav('report')}

      <section class="section report-layout" id="report">
        <article class="dashboard-card report-card">
          <h2>Incident Report</h2>
          <p class="report-intro">Submit verified incident details with evidence. Reports are securely stored for review.</p>

          <form id="incidentReportForm" class="report-form" novalidate>
            <div class="dashboard-form-grid report-grid">
              <div>
                <label class="field-label" for="reportImage">Incident Image</label>
                <input id="reportImage" name="image" type="file" accept="image/*" class="file-field" required />
                <img id="reportImagePreview" class="report-preview" alt="Incident preview" />
              </div>

              <div>
                <label class="field-label" for="reportLocation">Incident Location</label>
                <input
                  id="reportLocation"
                  name="location"
                  type="text"
                  class="text-field"
                  placeholder="Enter location, landmark, or address"
                />
                <button type="button" class="btn btn-secondary report-location-btn" id="reportUseLocation">Use My Current Location</button>
              </div>
            </div>

            <div class="report-description-wrap">
              <label class="field-label" for="reportDescription">Incident Description</label>
              <textarea
                id="reportDescription"
                name="description"
                class="text-area-field"
                rows="6"
                maxlength="2000"
                placeholder="Describe what happened, when it happened, and any critical details"
                required
              ></textarea>
            </div>

            <div class="report-actions">
              <button type="submit" class="btn btn-primary" id="reportSubmitButton">Submit Report</button>
              <p class="report-feedback" id="reportFeedback" aria-live="polite">Your report will be sent once submitted.</p>
            </div>
          </form>
        </article>
      </section>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function createLoginPage() {
  return `
    <main class="login-page">
      ${createNav('login')}

      <section class="section login-layout" id="login">
        <article class="dashboard-card login-card">
          <h2>Account Access</h2>
          <p class="login-intro">Sign in to your account or create one to securely submit incident reports.</p>

          <div class="login-toggle" role="tablist" aria-label="Choose authentication mode">
            <button type="button" class="btn btn-secondary active" id="loginModeButton" data-mode="login">Login</button>
            <button type="button" class="btn btn-secondary" id="signupModeButton" data-mode="signup">Sign Up</button>
          </div>

          <form id="authForm" class="login-form" novalidate>
            <div>
              <label class="field-label" for="authEmail">Email</label>
              <input id="authEmail" type="email" class="text-field" placeholder="you@example.com" required />
            </div>

            <div>
              <label class="field-label" for="authPassword">Password</label>
              <input id="authPassword" type="password" class="text-field" minlength="6" placeholder="Enter password" required />
            </div>

            <div id="confirmPasswordWrap" class="login-confirm hidden">
              <label class="field-label" for="authConfirmPassword">Confirm Password</label>
              <input id="authConfirmPassword" type="password" class="text-field" minlength="6" placeholder="Re-enter password" />
            </div>

            <div class="login-actions">
              <button type="submit" class="btn btn-primary" id="authSubmitButton">Login</button>
              <button type="button" class="btn btn-secondary login-logout hidden" id="authLogoutButton">Logout</button>
            </div>

            <p class="login-status" id="authStatus" aria-live="polite">Checking authentication status...</p>
          </form>
        </article>
      </section>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function createEmergencyOverlay() {
  return `
    <button class="sos-fab" id="sosFab" type="button" aria-label="Open emergency assistance panel">
      <span class="sos-icon" aria-hidden="true">🛡 SOS</span>
    </button>

    <aside class="emergency-panel" id="emergencyPanel" aria-hidden="true">
      <header>
        <h3>Emergency Assistance</h3>
        <button id="closeEmergency" type="button" aria-label="Close emergency assistance panel">✕</button>
      </header>
      <p class="status"><span class="status-dot"></span>Connected to emergency services</p>
      <div class="emergency-actions">
        <button type="button" data-action="call-police">Call Police</button>
        <button type="button" data-action="call-ambulance">Call Ambulance</button>
        <button type="button" data-action="call-fire">Call Fire Services</button>
        <button type="button" data-action="share-location">Share Live Location</button>
        <button type="button" data-action="navigate-safe-zone">Navigate to Nearest Safe Zone</button>
      </div>
      <p class="emergency-feedback" id="emergencyFeedback" aria-live="polite">Emergency actions are ready.</p>
      <div class="mini-map" aria-label="Nearest hospitals and police stations mini map">
        <p class="mini-map-title">Nearby priority services</p>
        <ul id="nearestServices"></ul>
      </div>
    </aside>`;
}

function createRiskMapPage() {
  const stateOptions = STATE_OPTIONS.map((stateName) => `<option value="${stateName}">${stateName}</option>`).join('');

  const highwayContacts = NATIONAL_HIGHWAY_CONTACTS.map(
    (contact) => `
      <article class="contact-chip">
        <strong>${contact.label}</strong>
        <a href="tel:${contact.number}">${contact.number}</a>
        <p>${contact.description}</p>
      </article>`,
  ).join('');

  return `
    <main class="map-page">
      ${createNav('map')}
      <section class="map-hero">
        <div>
          <h1>India's Risk Map</h1>
        </div>
        <div class="map-hero-actions">
          <a class="btn btn-secondary" href="#home">Back to Home</a>
        </div>
      </section>

      <section class="map-layout">
        <div class="map-frame card" aria-label="India risk map">
          <div class="map-loading" id="mapLoading">Loading hotspot layers...</div>
          <div id="indiaMap" class="india-map"></div>
        </div>

        <aside class="map-sidebar card" id="contact-panel">
          <div class="sidebar-block">
            <h2>State Emergency Contacts</h2>
            <label class="field-label" for="stateSelect">Select state</label>
            <div class="select-wrap">
              <select id="stateSelect" class="select-field">
                ${stateOptions}
              </select>
            </div>
            <div class="state-summary" id="stateSummary"></div>
            <div class="contact-list" id="stateContactList"></div>
          </div>

          <div class="sidebar-block">
            <h2>National Highway Security</h2>
            <div class="contact-list contact-list-tight">
              ${highwayContacts}
            </div>
          </div>

          <div class="sidebar-block">
            <h2>Map Legend</h2>
            <div class="legend-grid">
              <span><i class="legend-dot legend-crime"></i> Crime</span>
              <span><i class="legend-dot legend-theft"></i> Theft</span>
              <span><i class="legend-dot legend-accident"></i> Accident</span>
              <span><i class="legend-dot legend-traffic"></i> Traffic</span>
              <span><i class="legend-dot legend-casualty"></i> Casualty</span>
            </div>
          </div>
        </aside>
      </section>

      ${createEmergencyOverlay()}
    </main>
  `;
}

function setActiveRoute(route) {
  if (insightsLiveTimer) {
    window.clearInterval(insightsLiveTimer);
    insightsLiveTimer = null;
  }

  const isMapPage = route === 'map';
  const isDashboardPage = route === 'dashboard';
  const isHelpPage = route === 'help';
  const isReportPage = route === 'report';
  const isLoginPage = route === 'login';
  app.innerHTML = isMapPage
    ? createRiskMapPage()
    : isDashboardPage
      ? createDashboardPage()
      : isLoginPage
        ? createLoginPage()
      : isReportPage
        ? createReportPage()
      : isHelpPage
        ? createHelpPage()
        : createHomePage();

  if (currentMap) {
    currentMap.remove();
    currentMap = null;
  }

  bindCommonActions();

  if (isMapPage) {
    bindMapActions();
    initRiskMap();
    return;
  }

  if (isDashboardPage) {
    bindDashboardActions();
    return;
  }

  if (isHelpPage) {
    bindHelpActions();
    return;
  }

  if (isReportPage) {
    bindReportActions();
    return;
  }

  if (isLoginPage) {
    bindLoginActions();
    return;
  }

  bindInsightsActions();
}

function getCurrentRoute() {
  if (window.location.hash === MAP_ROUTE_HASH || window.location.hash === '#risk-map') return 'map';
  if (window.location.hash === DASHBOARD_ROUTE_HASH) return 'dashboard';
  if (window.location.hash === REPORT_ROUTE_HASH) return 'report';
  if (window.location.hash === LOGIN_ROUTE_HASH) return 'login';
  if (window.location.hash === HELP_ROUTE_HASH) return 'help';
  return 'home';
}

function toggleEmergencyPanel(forceState) {
  if (!currentEmergencyPanel || !currentSosFab) return;

  const shouldOpen = forceState ?? !currentEmergencyPanel.classList.contains('open');
  currentEmergencyPanel.classList.toggle('open', shouldOpen);
  currentEmergencyPanel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
  currentSosFab.classList.add('sos-feedback');

  if (navigator.vibrate) {
    navigator.vibrate(35);
  }

  window.setTimeout(() => {
    currentSosFab.classList.remove('sos-feedback');
  }, 220);
}

function setEmergencyFeedback(message) {
  if (currentEmergencyFeedback) {
    currentEmergencyFeedback.textContent = message;
  }
}

function getCurrentLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ location: DEFAULT_USER_LOCATION, accurate: false });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          location: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
          accurate: true,
        });
      },
      () => {
        resolve({ location: DEFAULT_USER_LOCATION, accurate: false });
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 20000 },
    );
  });
}

function renderNearestServices(fromLocation) {
  if (!currentNearestServicesList) return;

  const nearest = getNearestLocations(fromLocation, emergencyServices, 3);
  currentNearestServicesList.innerHTML = nearest
    .map(
      (service) =>
        `<li><strong>${service.type}:</strong> ${service.name} · ${formatDistanceKm(service.distanceKm)}</li>`,
    )
    .join('');
}

function openDial(number, label) {
  setEmergencyFeedback(`Connecting to ${label}...`);
  window.location.href = `tel:${number}`;
}

async function shareLiveLocation() {
  setEmergencyFeedback('Preparing live location...');
  const { location, accurate } = await getCurrentLocation();
  const locationUrl = `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=16/${location.lat}/${location.lng}`;
  const text = `My live location: ${locationUrl}`;

  if (navigator.share) {
    await navigator.share({
      title: 'Emergency Live Location',
      text,
      url: locationUrl,
    });
    setEmergencyFeedback(accurate ? 'Live location shared.' : 'Shared fallback location.');
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    setEmergencyFeedback('Live location copied to clipboard.');
    return;
  }

  setEmergencyFeedback('Sharing is not available on this browser.');
}

async function navigateToNearestSafeZone() {
  setEmergencyFeedback('Locating nearest safe zone...');
  const { location, accurate } = await getCurrentLocation();
  const [nearestZone] = getNearestLocations(location, safeZones, 1);

  const routeUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${location.lat}%2C${location.lng}%3B${nearestZone.lat}%2C${nearestZone.lng}`;
  window.open(routeUrl, '_blank', 'noopener,noreferrer');

  setEmergencyFeedback(
    `Routing to ${nearestZone.name} (${formatDistanceKm(nearestZone.distanceKm)}).${
      accurate ? '' : ' Using fallback location.'
    }`,
  );
}

async function handleEmergencyAction(action) {
  if (navigator.vibrate) {
    navigator.vibrate([12, 24, 12]);
  }

  try {
    if (action === 'call-police') {
      openDial('112', 'Police (112)');
      return;
    }

    if (action === 'call-ambulance') {
      openDial('108', 'Ambulance (108)');
      return;
    }

    if (action === 'call-fire') {
      openDial('101', 'Fire Services (101)');
      return;
    }

    if (action === 'share-location') {
      await shareLiveLocation();
      return;
    }

    if (action === 'navigate-safe-zone') {
      await navigateToNearestSafeZone();
    }
  } catch (error) {
    console.error(error);
    setEmergencyFeedback('Action could not be completed. Please try again.');
  }
}

function bindCommonActions() {
  currentSosFab = document.querySelector('#sosFab');
  currentEmergencyPanel = document.querySelector('#emergencyPanel');
  currentEmergencyFeedback = document.querySelector('#emergencyFeedback');
  currentNearestServicesList = document.querySelector('#nearestServices');

  if (currentSosFab) {
    currentSosFab.addEventListener('click', () => toggleEmergencyPanel());
  }

  const closeEmergencyButton = document.querySelector('#closeEmergency');
  if (closeEmergencyButton) {
    closeEmergencyButton.addEventListener('click', () => toggleEmergencyPanel(false));
  }

  const emergencyActions = document.querySelector('.emergency-actions');
  if (emergencyActions) {
    emergencyActions.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;

      const action = button.getAttribute('data-action');
      await handleEmergencyAction(action);
    });
  }

  const routeLinks = document.querySelectorAll('[data-route-link], [data-open-map]');
  routeLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();

      if (link.hasAttribute('data-open-map')) {
        window.location.hash = MAP_ROUTE_HASH;
        return;
      }

      const route = link.getAttribute('data-route-link');
      if (route === 'home') {
        window.location.hash = '#home';
        return;
      }

      if (route === 'insights') {
        if (getCurrentRoute() !== 'home') {
          window.location.hash = '#home';
          window.setTimeout(() => {
            document.querySelector('#insights')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 100);
          return;
        }

        document.querySelector('#insights')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      if (route === 'dashboard') {
        window.location.hash = DASHBOARD_ROUTE_HASH;
        return;
      }

      if (route === 'map') {
        window.location.hash = MAP_ROUTE_HASH;
        return;
      }

      if (route === 'report') {
        window.location.hash = REPORT_ROUTE_HASH;
        return;
      }

      if (route === 'login') {
        window.location.hash = LOGIN_ROUTE_HASH;
        return;
      }

      if (route === 'help') {
        window.location.hash = HELP_ROUTE_HASH;
      }
    });
  });

  renderNearestServices(DEFAULT_USER_LOCATION);
}

function renderHelpServiceList(listElement, services, emptyText) {
  if (!listElement) return;

  if (!services.length) {
    listElement.innerHTML = `<li class="help-service-empty">${emptyText}</li>`;
    return;
  }

  listElement.innerHTML = services
    .map((service) => {
      const phoneText = service.phone ? String(service.phone).trim() : '';
      const dialNumber = phoneText.replace(/[^\d+]/g, '');
      const hasCallableNumber = Boolean(phoneText && dialNumber);

      return `
        <li class="help-service-item">
          <strong>${service.name}</strong>
          <span>${formatDistanceKm(service.distanceKm)} away</span>
          <span class="help-service-phone">Contact: ${phoneText || 'Not listed'}</span>
          ${hasCallableNumber ? `<a class="help-service-call" href="tel:${dialNumber}">Call</a>` : ''}
        </li>
      `;
    })
    .join('');
}

function normalizeOverpassElements(elements, cityLocation) {
  return (elements ?? [])
    .map((element) => {
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const tags = element.tags ?? {};
      const amenity = String(tags.amenity ?? '').trim();
      if (amenity !== 'hospital' && amenity !== 'police') return null;

      const nameFallback = amenity === 'hospital' ? 'Unnamed Hospital' : 'Unnamed Police Station';
      const name = String(tags.name ?? '').trim() || nameFallback;
      const phone = String(tags.phone ?? tags['contact:phone'] ?? tags['contact:mobile'] ?? '').trim() || null;

      return {
        amenity,
        name,
        phone,
        lat,
        lng,
        distanceKm: haversineDistanceKm(cityLocation, { lat, lng }),
      };
    })
    .filter(Boolean);
}

async function fetchNearbyEmergencyPlaces(cityLocation, cityName, maxResultsPerType = 5) {
  const cacheKey = `${cityName}::emergency`;
  if (helpPlacesCache.has(cacheKey)) {
    return helpPlacesCache.get(cacheKey);
  }

  const radiusMeters = 45000;
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(hospital|police)$"](around:${radiusMeters},${cityLocation.lat},${cityLocation.lng});
      way["amenity"~"^(hospital|police)$"](around:${radiusMeters},${cityLocation.lat},${cityLocation.lng});
      relation["amenity"~"^(hospital|police)$"](around:${radiusMeters},${cityLocation.lat},${cityLocation.lng});
    );
    out center tags;
  `;

  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 18000);

    try {
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const normalized = normalizeOverpassElements(payload.elements, cityLocation);
      const hospitals = normalized
        .filter((item) => item.amenity === 'hospital')
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, maxResultsPerType);
      const policeStations = normalized
        .filter((item) => item.amenity === 'police')
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, maxResultsPerType);

      const result = { hospitals, policeStations };
      helpPlacesCache.set(cacheKey, result);
      return result;
    } catch (error) {
      lastError = error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('Unable to fetch emergency places from Overpass endpoints.');
}

function bindHelpActions() {
  const citySelect = document.querySelector('#helpCitySelect');
  const hospitalList = document.querySelector('#helpHospitalList');
  const policeList = document.querySelector('#helpPoliceList');
  const helpMeta = document.querySelector('#helpMeta');

  if (!citySelect || !hospitalList || !policeList || !helpMeta) return;

  const renderForCity = async (cityName) => {
    const cityLocation = CITY_COORDINATES[cityName];
    if (!cityLocation) {
      helpMeta.textContent = 'Selected city coordinates are unavailable.';
      renderHelpServiceList(hospitalList, [], 'No hospitals available.');
      renderHelpServiceList(policeList, [], 'No police stations available.');
      return;
    }

    helpMeta.textContent = `Loading live emergency places for ${cityName}...`;
    citySelect.disabled = true;

    renderHelpServiceList(hospitalList, [], 'Loading hospitals...');
    renderHelpServiceList(policeList, [], 'Loading police stations...');

    try {
      const { hospitals: nearestHospitals, policeStations: nearestPoliceStations } = await fetchNearbyEmergencyPlaces(
        cityLocation,
        cityName,
        5,
      );

      renderHelpServiceList(hospitalList, nearestHospitals, 'No hospitals found nearby.');
      renderHelpServiceList(policeList, nearestPoliceStations, 'No police stations found nearby.');

      const countLabel = `${nearestHospitals.length} hospitals and ${nearestPoliceStations.length} police stations`;
      helpMeta.textContent = `Showing up to 5 nearest live results for ${cityName} (${countLabel}).`;
      renderNearestServices(cityLocation);
    } catch (error) {
      console.error(error);
      helpMeta.textContent = `Unable to fetch live place details for ${cityName} right now. Please try again.`;
      renderHelpServiceList(hospitalList, [], 'Could not load hospitals from live data.');
      renderHelpServiceList(policeList, [], 'Could not load police stations from live data.');
    } finally {
      citySelect.disabled = false;
    }
  };

  citySelect.addEventListener('change', () => {
    renderForCity(citySelect.value);
  });

  const firstCity = citySelect.value || citySelect.options[0]?.value;
  if (firstCity) {
    citySelect.value = firstCity;
    renderForCity(firstCity);
  }
}

function bindReportActions() {
  const form = document.querySelector('#incidentReportForm');
  const imageInput = document.querySelector('#reportImage');
  const imagePreview = document.querySelector('#reportImagePreview');
  const locationInput = document.querySelector('#reportLocation');
  const descriptionInput = document.querySelector('#reportDescription');
  const locationButton = document.querySelector('#reportUseLocation');
  const feedback = document.querySelector('#reportFeedback');
  const submitButton = document.querySelector('#reportSubmitButton');

  if (!form || !imageInput || !imagePreview || !locationInput || !descriptionInput || !locationButton || !feedback || !submitButton) {
    return;
  }

  const setFeedback = (message) => {
    feedback.textContent = message;
  };

  if (!authStateReady) {
    setFeedback('Checking login status...');
  } else if (!currentAuthUser) {
    setFeedback('Login required. Please sign in from the Login tab before submitting a report.');
  }

  imageInput.addEventListener('change', () => {
    const [file] = imageInput.files ?? [];
    if (!file) {
      imagePreview.removeAttribute('src');
      imagePreview.classList.remove('visible');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    imagePreview.src = objectUrl;
    imagePreview.classList.add('visible');
  });

  locationButton.addEventListener('click', async () => {
    locationButton.disabled = true;
    setFeedback('Detecting your current location...');

    try {
      const { location, accurate } = await getCurrentLocation();
      const coordsText = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
      locationInput.value = coordsText;
      setFeedback(accurate ? 'Current location added.' : 'Fallback location added.');
    } catch (error) {
      console.error(error);
      setFeedback('Unable to detect current location right now.');
    } finally {
      locationButton.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!authStateReady) {
      setFeedback('Finalizing login session check...');
      await authStateReadyPromise;
    }

    const [imageFile] = imageInput.files ?? [];
    const description = descriptionInput.value.trim();
    const location = locationInput.value.trim();

    if (!imageFile) {
      setFeedback('Please upload an incident image.');
      return;
    }

    if (!description) {
      setFeedback('Please add a description of the incident.');
      return;
    }

    if (!currentAuthUser) {
      setFeedback('You must be logged in to submit a report.');
      return;
    }

    submitButton.disabled = true;
    setFeedback('Uploading evidence image to Firebase Storage...');

    try {
      const safeName = imageFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `incidentReports/${currentAuthUser.uid}/${Date.now()}_${safeName}`;
      const storageRef = ref(storage, filePath);

      await uploadBytes(storageRef, imageFile);
      const imageUrl = await getDownloadURL(storageRef);
      setFeedback('Image uploaded. Saving report to Firestore...');

      const reportRef = await addDoc(collection(db, 'incidentReports'), {
        description,
        location,
        imageUrl,
        imagePath: filePath,
        userId: currentAuthUser.uid,
        userEmail: currentAuthUser.email ?? null,
        createdAt: serverTimestamp(),
        status: 'submitted',
      });

      form.reset();
      imagePreview.removeAttribute('src');
      imagePreview.classList.remove('visible');
      setFeedback(`Incident report submitted successfully. Report ID: ${reportRef.id}`);
    } catch (error) {
      console.error(error);
      const code = String(error?.code ?? '');
      const details =
        code === 'storage/unauthorized' || code === 'permission-denied'
          ? 'Permission denied by Firebase rules. Please update Firestore/Storage rules for authenticated users.'
          : code === 'storage/canceled'
            ? 'Upload canceled.'
            : code === 'storage/unknown'
              ? 'Storage error. Check Firebase Storage setup and bucket rules.'
              : error?.message ?? 'Unknown error.';
      setFeedback(`Unable to submit report: ${details}`);
    } finally {
      submitButton.disabled = false;
    }
  });
}

function bindLoginActions() {
  const form = document.querySelector('#authForm');
  const emailInput = document.querySelector('#authEmail');
  const passwordInput = document.querySelector('#authPassword');
  const confirmWrap = document.querySelector('#confirmPasswordWrap');
  const confirmInput = document.querySelector('#authConfirmPassword');
  const submitButton = document.querySelector('#authSubmitButton');
  const logoutButton = document.querySelector('#authLogoutButton');
  const status = document.querySelector('#authStatus');
  const loginModeButton = document.querySelector('#loginModeButton');
  const signupModeButton = document.querySelector('#signupModeButton');

  if (!form || !emailInput || !passwordInput || !confirmWrap || !confirmInput || !submitButton || !logoutButton || !status || !loginModeButton || !signupModeButton) {
    return;
  }

  let mode = 'login';

  const renderMode = () => {
    const isSignup = mode === 'signup';
    const isLoggedIn = Boolean(currentAuthUser);

    confirmWrap.classList.toggle('hidden', !isSignup);
    confirmInput.required = isSignup;

    logoutButton.classList.toggle('hidden', !isLoggedIn);
    submitButton.disabled = isLoggedIn;
    submitButton.textContent = isLoggedIn ? 'Logged In' : isSignup ? 'Create Account' : 'Login';

    loginModeButton.classList.toggle('active', !isSignup);
    signupModeButton.classList.toggle('active', isSignup);
    loginModeButton.disabled = isLoggedIn;
    signupModeButton.disabled = isLoggedIn;

    if (isLoggedIn) {
      status.textContent = `Signed in as ${currentAuthUser.email ?? 'user'}. You can now submit reports.`;
      return;
    }

    status.textContent = isSignup
      ? 'Create a new account to start reporting incidents.'
      : 'Login to submit reports.';
  };

  const setMode = (nextMode) => {
    mode = nextMode;
    renderMode();
  };

  loginModeButton.addEventListener('click', () => setMode('login'));
  signupModeButton.addEventListener('click', () => setMode('signup'));

  logoutButton.addEventListener('click', async () => {
    try {
      await signOut(auth);
      status.textContent = 'Logged out successfully.';
    } catch (error) {
      console.error(error);
      status.textContent = 'Unable to logout right now.';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmInput.value;

    if (!email || !password) {
      status.textContent = 'Please provide email and password.';
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      status.textContent = 'Password and confirm password do not match.';
      return;
    }

    submitButton.disabled = true;
    status.textContent = mode === 'signup' ? 'Creating account...' : 'Logging in...';

    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email, password);
        status.textContent = 'Account created and logged in successfully.';
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        status.textContent = 'Logged in successfully.';
      }

      form.reset();
      renderMode();
    } catch (error) {
      console.error(error);
      status.textContent = error?.message ? `Auth error: ${error.message}` : 'Authentication failed.';
    } finally {
      submitButton.disabled = false;
    }
  });

  renderMode();
}

function getCrimeNewsLinks() {
  const fromWindow = Array.isArray(window.CRIME_NEWS_LINKS) ? window.CRIME_NEWS_LINKS : [];
  const source = fromWindow.length ? fromWindow : CRIME_NEWS_LINKS;

  return source
    .map((item) => {
      if (typeof item === 'string') {
        return { title: item, url: item };
      }

      return {
        title: String(item?.title ?? item?.url ?? '').trim(),
        url: String(item?.url ?? '').trim(),
      };
    })
    .filter((item) => item.url);
}

function bindInsightsActions() {
  const newsList = document.querySelector('#insightsNewsList');
  const newsFrame = document.querySelector('#insightsNewsFrame');
  if (!newsList || !newsFrame) return;

  const links = getCrimeNewsLinks();
  if (!links.length) {
    newsList.innerHTML = '<p class="news-empty">Waiting for your crime news links.</p>';
    newsFrame.removeAttribute('src');
    newsFrame.classList.remove('visible');
    return;
  }

  const openLink = (url, button) => {
    newsFrame.src = url;
    newsFrame.classList.add('visible');
    newsList.querySelectorAll('.news-item').forEach((node) => node.classList.remove('active'));
    button.classList.add('active');
  };

  newsList.innerHTML = links
    .map(
      (item, index) =>
        `<button type="button" class="news-item ${index === 0 ? 'active' : ''}" data-url="${item.url}">${item.title || item.url}</button>`,
    )
    .join('');

  newsList.addEventListener('click', (event) => {
    const button = event.target.closest('.news-item');
    if (!button) return;

    openLink(button.dataset.url, button);
  });

  openLink(links[0].url, newsList.querySelector('.news-item'));

  bindInsightsRiskDashboard();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDaytimeFactorByHour(hour) {
  if (hour >= 6 && hour <= 10) return 72;
  if (hour >= 11 && hour <= 16) return 78;
  if (hour >= 17 && hour <= 20) return 58;
  return 34;
}

function getNightMultiplierByHour(hour) {
  if (hour >= 21 || hour < 5) return 30;
  if (hour >= 18 && hour < 21) return 22;
  if (hour >= 5 && hour < 8) return 18;
  return 12;
}

function readNumericField(row, field) {
  const value = Number(row?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function sumFieldsFromRow(row, fields) {
  return fields.reduce((total, field) => total + readNumericField(row, field), 0);
}

function createDistrictSummary() {
  return {
    rows: 0,
    latestYear: 0,
    murder: 0,
    rape: 0,
    kidnapping: 0,
    assaultOnWomen: 0,
    robbery: 0,
    hitAndRun: 0,
    accidents: 0,
    otherAccidents: 0,
  };
}

function getDistrictSummaryTotal(summary) {
  if (!summary) return 0;
  return summary.murder + summary.rape + summary.kidnapping + summary.assaultOnWomen + summary.robbery + summary.hitAndRun + summary.otherAccidents;
}

function normalizeStateLookupKey(stateName) {
  return String(stateName ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDistrictLookupKey(districtName) {
  return String(districtName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveDemographicsStateName(demographicsIndex, stateName) {
  const directMatch = demographicsIndex.get(stateName);
  if (directMatch) return stateName;

  const normalizedTarget = normalizeStateLookupKey(stateName);
  if (!normalizedTarget) return null;

  for (const key of demographicsIndex.keys()) {
    if (normalizeStateLookupKey(key) === normalizedTarget) {
      return key;
    }
  }

  return null;
}

function resolveDemographicsDistrictName(stateMap, districtName) {
  if (!stateMap || !districtName) return null;

  const directMatch = stateMap.get(districtName);
  if (directMatch) return districtName;

  const normalizedTarget = normalizeDistrictLookupKey(districtName);
  if (!normalizedTarget) return null;

  for (const key of stateMap.keys()) {
    if (normalizeDistrictLookupKey(key) === normalizedTarget) {
      return key;
    }
  }

  return null;
}

function buildDistrictDemographicsIndex(rows) {
  const stateMap = new Map();

  for (const row of rows ?? []) {
    const stateName = normalizeCrimeStateName(row.state_name, row.district_name);
    const districtName = String(row.district_name ?? '').trim();
    if (!stateName || !districtName) continue;

    if (!stateMap.has(stateName)) {
      stateMap.set(stateName, new Map());
    }

    const districtMap = stateMap.get(stateName);
    if (!districtMap.has(districtName)) {
      districtMap.set(districtName, createDistrictSummary());
    }

    const summary = districtMap.get(districtName);
    summary.rows += 1;
    summary.latestYear = Math.max(summary.latestYear, Number(row.year) || 0);
    summary.murder += readNumericField(row, 'murder');
    summary.rape += readNumericField(row, 'rape');
    summary.kidnapping += sumFieldsFromRow(row, [
      'missing_child_kidnpd',
      'other_kidnp_abduc',
      'kidnp_abdctn_begging',
      'kidnp_abdctn_murder',
      'kidnapping_for_ransom',
      'kidnp_abdctn_marrg',
      'proc_minor_girls',
      'import_girls_frgn_cntry',
      'other_kidnp_abduc_sec_365_369',
      'human_trafficking',
      'exp_traf_person',
      'sell_minors_prost',
      'buy_minors_prost',
    ]);
    summary.assaultOnWomen += readNumericField(row, 'assault_on_women') + sumFieldsFromRow(row, [
      'sex_hrrsmt_work_office_prms',
      'sex_hrrsmt_pub_trnsprt_sys',
      'sex_hrrsmt_shelter_homes',
      'sex_hrrsmt_other_places',
      'intnt_disrbe',
      'voyeurism',
      'stalking',
    ]);
    summary.robbery += sumFieldsFromRow(row, ['robbery', 'atmpt_dacoity_robbery', 'dacoity', 'dacoity_with_murder']);
    summary.hitAndRun += readNumericField(row, 'hit_and_run');
    summary.accidents += readNumericField(row, 'hit_and_run') + readNumericField(row, 'acdnt_other_than_hit_and_run_');
    summary.otherAccidents += readNumericField(row, 'acdnt_other_than_hit_and_run_');
  }

  return stateMap;
}

function getDistrictSummaryForSelection(demographicsIndex, stateName, districtName) {
  const stateMap = demographicsIndex.get(stateName);
  if (!stateMap) return null;

  if (districtName) {
    const resolvedDistrictName = resolveDemographicsDistrictName(stateMap, districtName);
    return resolvedDistrictName ? stateMap.get(resolvedDistrictName) : null;
  }

  const combined = createDistrictSummary();
  stateMap.forEach((summary) => {
    combined.rows += summary.rows;
    combined.latestYear = Math.max(combined.latestYear, summary.latestYear);
    combined.murder += summary.murder;
    combined.rape += summary.rape;
    combined.kidnapping += summary.kidnapping;
    combined.assaultOnWomen += summary.assaultOnWomen;
    combined.robbery += summary.robbery;
    combined.hitAndRun += summary.hitAndRun;
    combined.accidents += summary.accidents;
    combined.otherAccidents += summary.otherAccidents;
  });

  return combined.rows > 0 ? combined : null;
}

function estimateDistrictStats(record) {
  const crime = Math.max(0, Math.round(record.crimeScore));
  const theft = Math.max(0, Math.round(record.theftScore));
  const accident = Math.max(0, Math.round(record.accidentScore));
  const baseRisk = record.pointCount ? clamp(record.riskSum / record.pointCount, 0, 100) : 0;
  const nightMultiplier = getNightMultiplierByHour(new Date().getHours());

  return {
    baseRisk,
    nightMultiplier,
    nightAdjustedRisk: clamp(baseRisk * (nightMultiplier / 100), 0, 100),
    crimeScore: crime + theft,
    murder: Math.round(crime * 0.07),
    rape: Math.round(crime * 0.038),
    kidnapping: Math.round(crime * 0.0025),
    assaultWomen: Math.round(crime * 0.091),
    robbery: Math.round((crime + theft) * 0.14),
    dacoity: Math.round(crime * 0.004),
    assault: Math.round(crime * 0.1),
    hitRun: Math.round(accident * 0.28),
    accidents: accident,
    otherAccidents: Math.max(0, accident - Math.round(accident * 0.28)),
  };
}

function getInsightsDistrictDatasetPromise() {
  if (!insightsDistrictDatasetPromise) {
    insightsDistrictDatasetPromise = (hotspotsPromise ??= loadHotspotDatasets()).then((datasets) => {
      const byDistrict = new Map();

      const pushPoint = (point, category) => {
        const state = String(point?.stats?.state ?? '').trim();
        const district = String(point?.stats?.district ?? '').trim();
        if (!state || !district || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return;

        const key = `${state}||${district}`;
        if (!byDistrict.has(key)) {
          byDistrict.set(key, {
            state,
            district,
            latSum: 0,
            lngSum: 0,
            geoCount: 0,
            riskSum: 0,
            pointCount: 0,
            crimeScore: 0,
            theftScore: 0,
            accidentScore: 0,
          });
        }

        const item = byDistrict.get(key);
        item.latSum += point.lat;
        item.lngSum += point.lng;
        item.geoCount += 1;
        item.riskSum += Number(point.riskScore) || 0;
        item.pointCount += 1;

        const score = Number(point?.stats?.score) || 0;
        if (category === 'crime') item.crimeScore += score;
        if (category === 'theft') item.theftScore += score;
        if (category === 'accident') item.accidentScore += score;
      };

      (datasets.crimePoints ?? []).forEach((point) => pushPoint(point, 'crime'));
      (datasets.theftPoints ?? []).forEach((point) => pushPoint(point, 'theft'));
      (datasets.accidentPoints ?? []).forEach((point) => pushPoint(point, 'accident'));

      return Array.from(byDistrict.values())
        .filter((item) => item.geoCount > 0)
        .map((item) => ({
          ...item,
          lat: item.latSum / item.geoCount,
          lng: item.lngSum / item.geoCount,
          averageRisk: item.pointCount ? item.riskSum / item.pointCount : 0,
        }));
    });
  }

  return insightsDistrictDatasetPromise;
}

function updateInsightsRiskDashboard(record, dataset, locationResult) {
  const areaScore = document.querySelector('#insightsAreaScore');
  const areaRiskLevel = document.querySelector('#insightsAreaRiskLevel');
  const areaLocation = document.querySelector('#insightsAreaLocation');
  const areaNote = document.querySelector('#insightsAreaNote');
  const riskMeta = document.querySelector('#insightsRiskMeta');
  const crimeRiskText = document.querySelector('#insightsCrimeRiskText');
  const accidentRiskText = document.querySelector('#insightsAccidentRiskText');
  const dayFactorText = document.querySelector('#insightsDayFactorText');
  const crimeRiskBar = document.querySelector('#insightsCrimeRiskBar');
  const accidentRiskBar = document.querySelector('#insightsAccidentRiskBar');
  const dayFactorBar = document.querySelector('#insightsDayFactorBar');
  const districtTitle = document.querySelector('#insightsDistrictTitle');
  const districtCompare = document.querySelector('#insightsDistrictCompare');

  if (!areaScore || !areaRiskLevel || !areaLocation || !areaNote) return;

  const now = new Date();
  const hour = now.getHours();
  const daytimeFactor = getDaytimeFactorByHour(hour);

  const totalScore = Math.max(1, record.crimeScore + record.theftScore + record.accidentScore);
  const crimeShare = (record.crimeScore + record.theftScore * 0.7) / totalScore;
  const accidentShare = record.accidentScore / totalScore;

  const crimeRisk = clamp(record.averageRisk * (0.55 + 0.45 * crimeShare), 8, 95);
  const accidentRisk = clamp(record.averageRisk * (0.45 + 0.55 * accidentShare), 5, 90);
  const daylightRiskOffset = clamp((100 - daytimeFactor) * 0.35, 4, 24);
  const liveRisk = clamp((crimeRisk * 0.5 + accidentRisk * 0.3 + daylightRiskOffset * 0.2), 5, 98);
  const safetyScore = Math.round(100 - liveRisk);

  const riskLabel = liveRisk <= 40 ? 'Low Risk' : liveRisk <= 70 ? 'Moderate Risk' : 'High Risk';

  const rank = dataset
    .map((item) => item.averageRisk)
    .sort((a, b) => b - a)
    .findIndex((value) => value <= record.averageRisk);
  const percentile = Math.round(((rank + 1) / Math.max(1, dataset.length)) * 100);

  areaScore.textContent = `${safetyScore}`;
  areaRiskLevel.textContent = riskLabel;
  areaLocation.textContent = `${record.district}, ${record.state}`;
  areaNote.textContent = liveRisk > 70 ? 'Elevated risk detected in your area. Stay alert.' : 'Current area trend appears relatively stable.';

  if (riskMeta) {
    const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    riskMeta.textContent = `Live comparison updated at ${timeLabel}${locationResult?.accurate ? '' : ' (fallback location)'}.`;
  }

  if (crimeRiskText) crimeRiskText.textContent = `${Math.round(crimeRisk)}%`;
  if (accidentRiskText) accidentRiskText.textContent = `${Math.round(accidentRisk)}%`;
  if (dayFactorText) dayFactorText.textContent = `${Math.round(daytimeFactor)}%`;
  if (crimeRiskBar) crimeRiskBar.style.width = `${Math.round(crimeRisk)}%`;
  if (accidentRiskBar) accidentRiskBar.style.width = `${Math.round(accidentRisk)}%`;
  if (dayFactorBar) dayFactorBar.style.width = `${Math.round(daytimeFactor)}%`;

  if (districtTitle) districtTitle.textContent = `Your District — ${record.district}`;
  if (districtCompare) districtCompare.textContent = `Riskier than ${percentile}% of compared districts`;

  const stats = estimateDistrictStats(record);
  const setText = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = formatNumber(value);
  };

  setText('#insightsMurder', stats.murder);
  setText('#insightsRape', stats.rape);
  setText('#insightsRobbery', stats.robbery);
  setText('#insightsAssault', stats.assault);
  setText('#insightsHitRun', stats.hitRun);
  setText('#insightsAccidents', stats.accidents);

  insightsLiveContext = {
    record,
    dataset,
    locationResult,
  };
}

function bindInsightsRiskDashboard() {
  const useLocationButton = document.querySelector('#insightsUseLocation');
  if (!useLocationButton) return;

  const applyNearestDistrict = async (forceFreshLocation = false) => {
    useLocationButton.disabled = true;
    useLocationButton.textContent = 'Detecting...';

    try {
      const [dataset, locationResult] = await Promise.all([
        getInsightsDistrictDatasetPromise(),
        getCurrentLocation(),
      ]);

      if (!dataset.length) {
        const meta = document.querySelector('#insightsRiskMeta');
        if (meta) meta.textContent = 'No district activity data available for comparison yet.';
        return;
      }

      const nearest = [...dataset]
        .map((item) => ({
          ...item,
          distanceKm: haversineDistanceKm(locationResult.location, { lat: item.lat, lng: item.lng }),
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];

      updateInsightsRiskDashboard(nearest, dataset, locationResult);

      if (insightsLiveTimer) {
        window.clearInterval(insightsLiveTimer);
      }

      insightsLiveTimer = window.setInterval(() => {
        if (insightsLiveContext) {
          updateInsightsRiskDashboard(insightsLiveContext.record, insightsLiveContext.dataset, insightsLiveContext.locationResult);
        }
      }, 60_000);
    } catch (error) {
      console.error(error);
      const meta = document.querySelector('#insightsRiskMeta');
      if (meta) meta.textContent = 'Unable to detect location right now. Please try again.';
    } finally {
      useLocationButton.disabled = false;
      useLocationButton.textContent = 'Use My Location';
    }
  };

  useLocationButton.addEventListener('click', () => {
    applyNearestDistrict(true);
  });

  applyNearestDistrict();
}

function bindMapActions() {
  const stateSelect = document.querySelector('#stateSelect');
  const stateSummary = document.querySelector('#stateSummary');
  const stateContactList = document.querySelector('#stateContactList');

  const renderStateContacts = () => {
    if (!stateSelect || !stateSummary || !stateContactList) return;

    const selectedState = stateSelect.value;
    const contacts = getStateEmergencyContacts(selectedState);

    stateSummary.innerHTML = `
      <p><strong>${contacts.state}</strong></p>
      <p>State-level emergency bundle with national response and district support lines.</p>
    `;

    stateContactList.innerHTML = contacts.contacts
      .map(
        (contact) => `
          <article class="contact-chip">
            <strong>${contact.label}</strong>
            <a href="tel:${contact.number}">${contact.number}</a>
            <p>${contact.description}</p>
          </article>`,
      )
      .join('');
  };

  if (stateSelect) {
    stateSelect.addEventListener('change', renderStateContacts);
    renderStateContacts();
  }

}

function createEmptyActivityRecord() {
  return {
    crimeScore: 0,
    theftScore: 0,
    accidentScore: 0,
    riskSum: 0,
    pointCount: 0,
  };
}

function addActivityPoint(recordMap, point, category) {
  const state = String(point?.stats?.state ?? '').trim();
  const district = String(point?.stats?.district ?? '').trim();
  if (!state || !district) return;

  if (!recordMap.has(state)) {
    recordMap.set(state, new Map());
  }

  const districtMap = recordMap.get(state);
  if (!districtMap.has(district)) {
    districtMap.set(district, createEmptyActivityRecord());
  }

  const record = districtMap.get(district);
  const score = Number(point?.stats?.score) || 0;
  const risk = Number(point?.riskScore) || 0;

  if (category === 'crime') record.crimeScore += score;
  if (category === 'theft') record.theftScore += score;
  if (category === 'accident') record.accidentScore += score;

  record.riskSum += risk;
  record.pointCount += 1;
}

function getActivityIndexPromise() {
  if (!activityIndexPromise) {
    activityIndexPromise = (hotspotsPromise ??= loadHotspotDatasets()).then((datasets) => {
      const records = new Map();

      (datasets.crimePoints ?? []).forEach((point) => addActivityPoint(records, point, 'crime'));
      (datasets.theftPoints ?? []).forEach((point) => addActivityPoint(records, point, 'theft'));
      (datasets.accidentPoints ?? []).forEach((point) => addActivityPoint(records, point, 'accident'));

      return records;
    });
  }

  return activityIndexPromise;
}

function getDistrictDemographicsIndexPromise() {
  if (!districtDemographicsIndexPromise) {
    districtDemographicsIndexPromise = (hotspotsPromise ??= loadHotspotDatasets()).then((datasets) =>
      buildDistrictDemographicsIndex(datasets.districtCrimeRows ?? []),
    );
  }

  return districtDemographicsIndexPromise;
}

function mergeActivityRecords(records) {
  return records.reduce(
    (acc, record) => {
      acc.crimeScore += record.crimeScore;
      acc.theftScore += record.theftScore;
      acc.accidentScore += record.accidentScore;
      acc.riskSum += record.riskSum;
      acc.pointCount += record.pointCount;
      return acc;
    },
    createEmptyActivityRecord(),
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-IN').format(Math.round(value));
}

function getRiskLevelFromScore(riskScore) {
  if (riskScore <= 40) return 'Safe';
  if (riskScore <= 70) return 'Moderate';
  return 'High';
}

function setDashboardGauge(riskScore) {
  const gauge = document.querySelector('#dashboardGauge');
  const level = document.querySelector('#dashboardRiskLevel');
  if (!gauge || !level) return;

  const normalizedScore = Math.max(0, Math.min(100, Number(riskScore) || 0));
  const fillDegrees = Math.round((normalizedScore / 100) * 360);
  const riskLabel = getRiskLevelFromScore(normalizedScore);

  level.textContent = `${riskLabel} (${normalizedScore.toFixed(1)})`;
  gauge.setAttribute('aria-label', `Current city risk level ${riskLabel}`);
  gauge.style.background = `
    radial-gradient(circle at center, rgba(6, 20, 34, 1) 41%, rgba(6, 20, 34, 0) 42%),
    conic-gradient(var(--cyan) 0deg ${fillDegrees}deg, rgba(83, 231, 234, 0.12) ${fillDegrees}deg 360deg)
  `;
}

function renderActivityGraph(record) {
  const graph = document.querySelector('#activityGraph');
  if (!graph) return;

  if (!record || record.pointCount === 0) {
    graph.innerHTML = '<p>No activity data available to plot.</p>';
    return;
  }

  const points = [
    { label: 'Crime', value: record.crimeScore, color: '#ff5f6d' },
    { label: 'Theft', value: record.theftScore, color: '#ffb703' },
    { label: 'Accident', value: record.accidentScore, color: '#ff7f50' },
  ];

  const maxValue = Math.max(...points.map((item) => item.value), 1);

  graph.innerHTML = points
    .map((item) => {
      const widthPercent = Math.max(3, (item.value / maxValue) * 100);
      return `
        <div class="graph-row">
          <div class="graph-label">${item.label}</div>
          <div class="graph-track">
            <div class="graph-fill" style="width:${widthPercent}%; background:${item.color};"></div>
          </div>
          <div class="graph-value">${formatNumber(item.value)}</div>
        </div>
      `;
    })
    .join('');
}

function renderDistrictDemographics(stateName, districtName, demographicsIndex) {
  const profile = document.querySelector('#districtProfile');
  if (!profile) return;

  const normalizedState = normalizeCrimeStateName(stateName, districtName);
  const resolvedStateName = resolveDemographicsStateName(demographicsIndex, normalizedState);
  const summary = getDistrictSummaryForSelection(demographicsIndex, resolvedStateName, '');

  if (!summary) {
    profile.innerHTML = '<p>No state profile available for the selected state.</p>';
    return;
  }

  const crimeScore = Math.round(
    getDistrictSummaryTotal(summary),
  );
  const baseRisk = crimeScore > 0 ? Math.min(100, Math.round(Math.log10(crimeScore + 1) * 25)) : 0;
  const nightMultiplier = getNightMultiplierByHour(new Date().getHours());
  const riskLevel = getRiskLevelFromScore(baseRisk);

  const stateSummaries = Array.from(demographicsIndex.entries())
    .map(([name, map]) => {
      const combinedSummary = createDistrictSummary();
      map.forEach((item) => {
        combinedSummary.rows += item.rows;
        combinedSummary.latestYear = Math.max(combinedSummary.latestYear, item.latestYear);
        combinedSummary.murder += item.murder;
        combinedSummary.rape += item.rape;
        combinedSummary.kidnapping += item.kidnapping;
        combinedSummary.assaultOnWomen += item.assaultOnWomen;
        combinedSummary.robbery += item.robbery;
        combinedSummary.hitAndRun += item.hitAndRun;
        combinedSummary.accidents += item.accidents;
        combinedSummary.otherAccidents += item.otherAccidents;
      });

      return { name, summary: combinedSummary };
    })
    .filter((item) => item.summary.rows > 0);

  const percentile = stateSummaries.length
    ? Math.min(
        100,
        Math.round(
          ((stateSummaries.filter((item) => getDistrictSummaryTotal(item.summary) <= crimeScore).length + 1) / stateSummaries.length) * 100,
        ),
      )
    : 0;

  const categoryRows = [
    { label: 'Murder', value: summary.murder, color: '#ff5f6d' },
    { label: 'Rape', value: summary.rape, color: '#ff7a59' },
    { label: 'Kidnapping', value: summary.kidnapping, color: '#ff9a4a' },
    { label: 'Assault on Women', value: summary.assaultOnWomen, color: '#ffb703' },
    { label: 'Robbery', value: summary.robbery, color: '#f2c14e' },
    { label: 'Hit & Run', value: summary.hitAndRun, color: '#4bb3fd' },
    { label: 'Other Accidents', value: summary.otherAccidents, color: '#2f8fff' },
  ];

  const maxCategory = Math.max(...categoryRows.map((item) => item.value), 1);

  profile.innerHTML = `
    <div class="district-profile-head">
      <div>
        <h3>${stateName}</h3>
      </div>
      <div class="district-profile-risk">
        <span class="district-profile-label">Risk Level</span>
        <strong class="district-profile-pill ${riskLevel.toLowerCase()}">${riskLevel.toUpperCase()}</strong>
      </div>
    </div>

    <div class="district-profile-grid">
      <article class="district-profile-stat">
        <span>Base Risk</span>
        <strong>${baseRisk}%</strong>
      </article>
      <article class="district-profile-stat">
        <span>Crime Score</span>
        <strong>${formatNumber(crimeScore)}</strong>
      </article>
      <article class="district-profile-stat"><span>State Percentile</span><strong>${percentile}th</strong></article>
    </div>

    <div class="district-profile-bars">
      ${categoryRows
        .map(
          (item) => `
            <div class="district-bar-row">
              <div class="district-bar-labels">
                <span>${item.label}</span>
                <strong>${formatNumber(item.value)}</strong>
              </div>
              <div class="district-bar-track">
                <div class="district-bar-fill" style="width:${Math.max(3, (item.value / maxCategory) * 100)}%; background:${item.color};"></div>
              </div>
            </div>
          `,
        )
        .join('')}
    </div>

    <p class="district-profile-note">
      <strong>${stateName}</strong> ranks in the <strong>${percentile}th percentile</strong> of mapped states by crime risk · Night multiplier: <strong>${nightMultiplier}%</strong>
    </p>
  `;
}

function formatHourLabel(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const hour12 = normalized % 12 || 12;
  return `${hour12}${suffix}`;
}

function gaussian(hour, center, width) {
  const distance = Math.min(Math.abs(hour - center), 24 - Math.abs(hour - center));
  return Math.exp(-(distance ** 2) / (2 * width ** 2));
}

function buildSafetyTimeline(record) {
  if (!record || record.pointCount === 0) return [];

  const avgRisk = record.riskSum / record.pointCount;
  const total = Math.max(1, record.crimeScore + record.theftScore + record.accidentScore);
  const crimeShare = record.crimeScore / total;
  const theftShare = record.theftScore / total;
  const accidentShare = record.accidentScore / total;

  const baselineRisk = Math.max(10, Math.min(92, avgRisk));

  return Array.from({ length: 24 }, (_, hour) => {
    const crimePeak = gaussian(hour, 22, 3.2) + 0.45 * gaussian(hour, 1, 2.5);
    const theftPeak = 0.7 * gaussian(hour, 20, 3.5) + 0.5 * gaussian(hour, 14, 4);
    const accidentPeak = 0.9 * gaussian(hour, 9, 2.8) + 0.95 * gaussian(hour, 18, 2.8);
    const middaySafeBoost = gaussian(hour, 13, 3.2);

    const dynamicRisk =
      baselineRisk * (0.58 + 0.42 * (crimeShare * crimePeak + theftShare * theftPeak + accidentShare * accidentPeak)) -
      14 * middaySafeBoost;

    const riskScore = Math.max(5, Math.min(98, dynamicRisk));
    const safetyScore = Math.max(2, Math.min(98, 100 - riskScore));

    return {
      hour,
      hourLabel: formatHourLabel(hour),
      riskScore,
      safetyScore,
    };
  });
}

function renderSafetyTimeline(record, stateName, districtName) {
  const timelineContainer = document.querySelector('#safetyTimeline');
  const timelineSummary = document.querySelector('#timelineSummary');
  if (!timelineContainer || !timelineSummary) return;

  const timeline = buildSafetyTimeline(record);
  if (!timeline.length) {
    timelineContainer.innerHTML = '<p>No timeline can be generated for this selection.</p>';
    timelineSummary.textContent = 'Select a location with available activity records.';
    return;
  }

  const safestPoint = timeline.reduce((best, point) => (point.riskScore < best.riskScore ? point : best), timeline[0]);
  const currentHour = new Date().getHours();
  const currentPoint = timeline.find((point) => point.hour === currentHour) ?? safestPoint;

  timelineSummary.textContent = `Safest predicted time for ${stateName}${districtName ? ` / ${districtName}` : ''}: ${safestPoint.hourLabel}`;

  const chartWidth = 1200;
  const chartHeight = 260;
  const paddingLeft = 34;
  const paddingRight = 24;
  const paddingTop = 20;
  const paddingBottom = 36;
  const usableWidth = chartWidth - paddingLeft - paddingRight;
  const usableHeight = chartHeight - paddingTop - paddingBottom;

  const xFor = (index) => paddingLeft + (index / (timeline.length - 1)) * usableWidth;
  const yForRisk = (risk) => paddingTop + (risk / 100) * usableHeight;

  const linePoints = timeline
    .map((point, index) => `${xFor(index).toFixed(2)},${yForRisk(point.riskScore).toFixed(2)}`)
    .join(' ');

  const currentX = xFor(currentHour).toFixed(2);
  const currentY = yForRisk(currentPoint.riskScore).toFixed(2);

  const markerNodes = timeline
    .map((point, index) => {
      const x = xFor(index);
      const y = yForRisk(point.riskScore);
      const riskLevel = getRiskLevelFromScore(point.riskScore);
      const isSafest = point.hour === safestPoint.hour;

      return `
        <circle
          class="timeline-point ${isSafest ? 'safest' : ''}"
          cx="${x.toFixed(2)}"
          cy="${y.toFixed(2)}"
          r="${isSafest ? 5.5 : 4}"
          tabindex="0"
          role="img"
          aria-label="${point.hourLabel}, risk index ${point.riskScore.toFixed(1)}, safety index ${point.safetyScore.toFixed(1)}"
          data-hour-label="${point.hourLabel}"
          data-risk-score="${point.riskScore.toFixed(1)}"
          data-safety-score="${point.safetyScore.toFixed(1)}"
          data-risk-level="${riskLevel}"
        >
          <title>${point.hourLabel} · Risk: ${riskLevel} (${point.riskScore.toFixed(1)})</title>
        </circle>
      `;
    })
    .join('');

  const xAxisLabels = timeline
    .filter((point) => point.hour % 2 === 0)
    .map((point) => `<span>${point.hourLabel}</span>`)
    .join('');

  timelineContainer.innerHTML = `
    <div class="timeline-chart-shell">
      <svg class="timeline-svg" viewBox="0 0 ${chartWidth} ${chartHeight}" preserveAspectRatio="none" role="img" aria-label="24 hour risk timeline graph">
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${chartHeight - paddingBottom}" class="timeline-axis" />
        <line x1="${paddingLeft}" y1="${chartHeight - paddingBottom}" x2="${chartWidth - paddingRight}" y2="${chartHeight - paddingBottom}" class="timeline-axis" />
        <line x1="${currentX}" y1="${paddingTop}" x2="${currentX}" y2="${chartHeight - paddingBottom}" class="timeline-current-line" />
        <circle cx="${currentX}" cy="${currentY}" r="6.5" class="timeline-current-marker" />
        <polyline class="timeline-line" points="${linePoints}" />
        ${markerNodes}
      </svg>
      <div class="timeline-xaxis">${xAxisLabels}</div>
    </div>
  `;

  const points = timelineContainer.querySelectorAll('.timeline-point');

  const showPointDetails = (point) => {
    if (!point) return;
    timelineSummary.textContent = `${point.dataset.hourLabel} · Risk index ${point.dataset.riskScore} · Safety index ${point.dataset.safetyScore} · ${point.dataset.riskLevel}`;
  };

  showPointDetails(currentPoint);

  points.forEach((point) => {
    point.addEventListener('pointerenter', () => showPointDetails(point));
    point.addEventListener('focus', () => showPointDetails(point));
    point.addEventListener('pointerleave', () => showPointDetails(currentPoint));
    point.addEventListener('blur', () => showPointDetails(currentPoint));
  });
}

function computeCityRankings(activityIndex) {
  const crimeMap = new Map();
  const accidentMap = new Map();

  activityIndex.forEach((districtMap, stateName) => {
    districtMap.forEach((record) => {
      const crimeKey = stateName;
      const accidentKey = stateName;

      if (!crimeMap.has(crimeKey)) {
        crimeMap.set(crimeKey, { state: stateName, crimeScore: 0, count: 0 });
      }
      if (!accidentMap.has(accidentKey)) {
        accidentMap.set(accidentKey, { state: stateName, accidentScore: 0, count: 0 });
      }

      const crimeRecord = crimeMap.get(crimeKey);
      const accidentRecord = accidentMap.get(accidentKey);

      crimeRecord.crimeScore += record.crimeScore;
      crimeRecord.count += 1;
      accidentRecord.accidentScore += record.accidentScore;
      accidentRecord.count += 1;
    });
  });

  const crimeRankings = Array.from(crimeMap.values()).sort((a, b) => b.crimeScore - a.crimeScore);
  const accidentRankings = Array.from(accidentMap.values()).sort((a, b) => b.accidentScore - a.accidentScore);

  return { crimeRankings, accidentRankings };
}

function renderCityRankings(crimeRankings, accidentRankings) {
  const crimeList = document.querySelector('#crimeRankingList');
  const accidentList = document.querySelector('#accidentRankingList');

  if (crimeList) {
    crimeList.innerHTML = crimeRankings
      .map(
        (item, index) =>
          `<li class="ranking-item"><span class="rank">#${index + 1}</span><strong>${item.state}</strong><span class="score">${formatNumber(item.crimeScore)}</span></li>`,
      )
      .join('');
  }

  if (accidentList) {
    accidentList.innerHTML = accidentRankings
      .map(
        (item, index) =>
          `<li class="ranking-item"><span class="rank">#${index + 1}</span><strong>${item.state}</strong><span class="score">${formatNumber(item.accidentScore)}</span></li>`,
      )
      .join('');
  }
}

function bindDashboardActions() {
  const stateSelect = document.querySelector('#activityStateSelect');
  const districtSelect = document.querySelector('#activityDistrictSelect');

  if (!stateSelect || !districtSelect) return;

  getActivityIndexPromise()
    .then((activityIndex) => {
      const { crimeRankings, accidentRankings } = computeCityRankings(activityIndex);
      renderCityRankings(crimeRankings, accidentRankings);
      const renderDistrictOptions = (stateName) => {
        const districts = Array.from(activityIndex.get(stateName)?.keys() ?? []).sort((a, b) => a.localeCompare(b));
        districtSelect.innerHTML = ['<option value="">All Districts</option>', ...districts.map((district) => `<option value="${district}">${district}</option>`)].join('');
      };

      const renderRecord = () => {
        const stateName = stateSelect.value;
        const selectedDistrict = districtSelect.value;
        const districtMap = activityIndex.get(stateName);

        if (!districtMap || !districtMap.size) {
          renderActivityGraph(null);
          renderSafetyTimeline(null, stateName, selectedDistrict);
          setDashboardGauge(0);
          return;
        }

        const record = selectedDistrict
          ? districtMap.get(selectedDistrict)
          : mergeActivityRecords(Array.from(districtMap.values()));

        if (!record || record.pointCount === 0) {
          renderActivityGraph(null);
          renderSafetyTimeline(null, stateName, selectedDistrict);
          setDashboardGauge(0);
          return;
        }

        const averageRisk = record.pointCount ? (record.riskSum / record.pointCount).toFixed(1) : '0.0';
        setDashboardGauge(Number(averageRisk));
        renderActivityGraph(record);
        renderSafetyTimeline(record, stateName, selectedDistrict);
      };

      const onStateChange = () => {
        renderDistrictOptions(stateSelect.value);
        renderRecord();
      };

      stateSelect.addEventListener('change', onStateChange);
      districtSelect.addEventListener('change', renderRecord);

      onStateChange();
    })
    .catch((error) => {
      console.error(error);
      setDashboardGauge(0);
      renderActivityGraph(null);
      renderSafetyTimeline(null, '', '');
    });
}

function getCategoryStyle(category) {
  if (category === 'crime') return { color: '#ff5f6d', fillColor: '#ff5f6d' };
  if (category === 'crime-state') return { color: '#ff4d6d', fillColor: '#ff4d6d' };
  if (category === 'theft') return { color: '#ffb703', fillColor: '#ffb703' };
  if (category === 'accident') return { color: '#ff7f50', fillColor: '#ff7f50' };
  if (category === 'traffic') return { color: '#7cdbff', fillColor: '#7cdbff' };
  if (category === 'casualty') return { color: '#9b5de5', fillColor: '#9b5de5' };
  return { color: '#53e7ea', fillColor: '#53e7ea' };
}

function addPointLayer(map, points, category, labelPrefix) {
  if (!points.length) return 0;

  const style = getCategoryStyle(category);
  let plotted = 0;

  points.forEach((point) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;

    const score = Math.max(4, Math.min(26, 6 + (point.riskScore ?? 50) / 4));
    const opacity = 0.1;
    const circle = L.circleMarker([point.lat, point.lng], {
      radius: score,
      color: style.color,
      fillColor: style.fillColor,
      fillOpacity: opacity,
      opacity: 0.14,
      weight: 1,
    });

    const stats = point.stats ?? {};
    circle.bindPopup(`
      <strong>${labelPrefix}</strong><br />
      ${point.label ?? 'Unnamed hotspot'}<br />
      Risk score: ${point.riskScore ?? 'N/A'}<br />
      ${stats.state ? `State: ${stats.state}<br />` : ''}
      ${stats.district ? `District: ${stats.district}<br />` : ''}
      ${stats.score ? `Activity score: ${stats.score}<br />` : ''}
    `);
    circle.addTo(map);
    plotted += 1;
  });

  return plotted;
}

function initRiskMap() {
  const mapElement = document.querySelector('#indiaMap');
  const loadingElement = document.querySelector('#mapLoading');

  if (!mapElement) return;

  currentMap = L.map(mapElement, {
    zoomControl: true,
    minZoom: 4,
    maxZoom: 11,
  });

  currentMap.fitBounds(INDIA_BOUNDS);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(currentMap);

  requestAnimationFrame(() => {
    currentMap?.invalidateSize();
  });

  if (loadingElement) {
    loadingElement.textContent = 'Loading hotspot layers...';
  }

  const layerPromise = hotspotsPromise ??= loadHotspotDatasets();

  layerPromise
    .then((datasets) => {
      const plottedCrime = addPointLayer(currentMap, datasets.crimePoints, 'crime', 'Crime hotspot');
      const plottedCrimeState = addPointLayer(currentMap, datasets.crimeStatePoints ?? [], 'crime-state', 'Crime state hotspot');
      const plottedTheft = addPointLayer(currentMap, datasets.theftPoints, 'theft', 'Theft hotspot');
      const plottedAccident = addPointLayer(currentMap, datasets.accidentPoints, 'accident', 'Accident hotspot');
      const plottedTrafficState = addPointLayer(currentMap, datasets.trafficStatePoints, 'traffic', 'Traffic state hotspot');
      const plottedTrafficCity = addPointLayer(currentMap, datasets.trafficCityPoints, 'traffic', 'Traffic city hotspot');
      const plottedCasualties = addPointLayer(currentMap, datasets.casualtyPoints, 'casualty', 'Casualty hotspot');
      const totalPlotted =
        plottedCrime + plottedCrimeState + plottedTheft + plottedAccident + plottedTrafficState + plottedTrafficCity + plottedCasualties;

      if (loadingElement) {
        loadingElement.textContent =
          totalPlotted > 0
            ? `Plotted ${totalPlotted} transparent circles across India.`
            : 'No hotspot points were found in the loaded files.';
        loadingElement.classList.add('loaded');
      }

      if (datasets.meta?.loadWarnings?.length) {
        const warnings = datasets.meta.loadWarnings.join(' · ');
        const warningBox = document.createElement('div');
        warningBox.className = 'map-warning';
        warningBox.textContent = warnings;
        mapElement.parentElement?.appendChild(warningBox);
      }

      window.setTimeout(() => {
        currentMap?.invalidateSize();
      }, 60);
    })
    .catch((error) => {
      console.error(error);
      if (loadingElement) {
        loadingElement.textContent = 'Hotspot layers could not be loaded. The base India map is still available.';
        loadingElement.classList.add('loaded');
      }
    });
}

function renderRoute() {
  setActiveRoute(getCurrentRoute());
}

function initializeAuthObserver() {
  if (authObserverInitialized) return;
  authObserverInitialized = true;

  onAuthStateChanged(auth, (user) => {
    currentAuthUser = user ?? null;
    if (!authStateReady) {
      authStateReady = true;
      resolveAuthStateReady?.();
    }
    renderRoute();
  });
}

async function bootstrapApp() {
  showAppLoader('Loading city safety intelligence...');
  initializeAuthObserver();

  try {
    hotspotsPromise ??= loadHotspotDatasets();
    await hotspotsPromise;
  } catch (error) {
    console.error(error);
    hotspotsPromise = null;
  } finally {
    renderRoute();
    requestAnimationFrame(() => {
      hideAppLoader();
    });
  }
}

window.addEventListener('hashchange', renderRoute);

bootstrapApp();
