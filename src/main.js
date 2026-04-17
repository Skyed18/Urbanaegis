import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadHotspotDatasets } from './dataLoader.js';
import { NATIONAL_HIGHWAY_CONTACTS, STATE_OPTIONS, getStateEmergencyContacts } from './emergencyContacts.js';
import { CITY_COORDINATES } from './cityCoordinates.js';

const app = document.querySelector('#app');
const DEFAULT_USER_LOCATION = { lat: 28.6139, lng: 77.209 };
const MAP_ROUTE_HASH = '#maps';
const DASHBOARD_ROUTE_HASH = '#dashboard';
const HELP_ROUTE_HASH = '#help';
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
let insightsDistrictDatasetPromise = null;
let insightsLiveTimer = null;
let insightsLiveContext = null;
let appLoadingOverlay = null;
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
              <h3>Live Safety Score</h3>
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
          <h2>Live Risk Indicator</h2>
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

          <div id="activityRecord" class="activity-record" aria-live="polite">Loading activity records...</div>
        </article>

        <article class="dashboard-card activity-graph-card">
          <h2>Individual Activities Graph</h2>
          <div id="activityGraph" class="activity-graph" aria-live="polite">Loading graph...</div>
        </article>

        <article class="dashboard-card city-ranking-card">
          <h2>City Rankings by Activity</h2>
          <div class="city-ranking-grid">
            <div class="ranking-section">
              <h3>Top Crime Cities</h3>
              <ul id="crimeRankingList" class="ranking-list" aria-live="polite">Loading rankings...</ul>
            </div>
            <div class="ranking-section">
              <h3>Top Accident Cities</h3>
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
  app.innerHTML = isMapPage
    ? createRiskMapPage()
    : isDashboardPage
      ? createDashboardPage()
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

  bindInsightsActions();
}

function getCurrentRoute() {
  if (window.location.hash === MAP_ROUTE_HASH || window.location.hash === '#risk-map') return 'map';
  if (window.location.hash === DASHBOARD_ROUTE_HASH) return 'dashboard';
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

function estimateDistrictStats(record) {
  const crime = Math.max(0, Math.round(record.crimeScore));
  const theft = Math.max(0, Math.round(record.theftScore));
  const accident = Math.max(0, Math.round(record.accidentScore));

  return {
    murder: Math.round(crime * 0.07),
    rape: Math.round(crime * 0.038),
    robbery: Math.round((crime + theft) * 0.14),
    assault: Math.round(crime * 0.1),
    hitRun: Math.round(accident * 0.28),
    accidents: accident,
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

  const markerNodes = timeline
    .map((point, index) => {
      const x = xFor(index);
      const y = yForRisk(point.riskScore);
      const riskLevel = getRiskLevelFromScore(point.riskScore);
      const isSafest = point.hour === safestPoint.hour;

      return `
        <circle class="timeline-point ${isSafest ? 'safest' : ''}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${isSafest ? 5.5 : 4}">
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
        <polyline class="timeline-line" points="${linePoints}" />
        ${markerNodes}
      </svg>
      <div class="timeline-xaxis">${xAxisLabels}</div>
    </div>
  `;
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

  const crimeRankings = Array.from(crimeMap.values())
    .sort((a, b) => b.crimeScore - a.crimeScore)
    .slice(0, 5);
  const accidentRankings = Array.from(accidentMap.values())
    .sort((a, b) => b.accidentScore - a.accidentScore)
    .slice(0, 5);

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
  const activityRecord = document.querySelector('#activityRecord');

  if (!stateSelect || !districtSelect || !activityRecord) return;

  activityRecord.textContent = 'Loading activity records...';

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
          activityRecord.innerHTML = '<p>No activity record found for the selected state.</p>';
          renderActivityGraph(null);
          renderSafetyTimeline(null, stateName, selectedDistrict);
          setDashboardGauge(0);
          return;
        }

        const record = selectedDistrict
          ? districtMap.get(selectedDistrict)
          : mergeActivityRecords(Array.from(districtMap.values()));

        if (!record || record.pointCount === 0) {
          activityRecord.innerHTML = '<p>No activity record found for the selected district.</p>';
          renderActivityGraph(null);
          renderSafetyTimeline(null, stateName, selectedDistrict);
          setDashboardGauge(0);
          return;
        }

        const averageRisk = record.pointCount ? (record.riskSum / record.pointCount).toFixed(1) : '0.0';
        setDashboardGauge(Number(averageRisk));
        renderActivityGraph(record);
        renderSafetyTimeline(record, stateName, selectedDistrict);

        activityRecord.innerHTML = `
          <p><strong>${stateName}${selectedDistrict ? ` / ${selectedDistrict}` : ''}</strong></p>
          <div class="activity-metrics">
            <article class="metric-chip"><h3>Crime</h3><p>${formatNumber(record.crimeScore)}</p></article>
            <article class="metric-chip"><h3>Theft</h3><p>${formatNumber(record.theftScore)}</p></article>
            <article class="metric-chip"><h3>Accident</h3><p>${formatNumber(record.accidentScore)}</p></article>
            <article class="metric-chip"><h3>Avg Risk</h3><p>${averageRisk}</p></article>
          </div>
          <p class="activity-meta">Records analyzed: ${formatNumber(record.pointCount)} hotspot points</p>
        `;
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
      activityRecord.textContent = 'Activity records are unavailable right now.';
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

async function bootstrapApp() {
  showAppLoader('Loading city safety intelligence...');

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
