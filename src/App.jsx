import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { loadHotspotDatasets } from './dataLoader.js';
import {
  NATIONAL_HIGHWAY_CONTACTS,
  STATE_OPTIONS,
  getStateEmergencyContacts,
} from './emergencyContacts.js';

const actions = [
  { id: 'police', label: 'Call Police', href: 'tel:112', tone: 'bg-red-500/20 border-red-400/50' },
  { id: 'ambulance', label: 'Call Ambulance', href: 'tel:108', tone: 'bg-red-500/20 border-red-400/50' },
  { id: 'fire', label: 'Call Fire Services', href: 'tel:101', tone: 'bg-red-500/20 border-red-400/50' },
  { id: 'highway', label: 'Call Highway Helpline (1033)', href: 'tel:1033', tone: 'bg-red-500/20 border-red-400/50' },
  { id: 'share', label: 'Share Live Location', href: '#', tone: 'bg-red-500/15 border-red-300/40' },
  { id: 'safe', label: 'Navigate to Nearest Safe Zone', href: '#', tone: 'bg-red-500/15 border-red-300/40' },
];

const panelMotion = {
  hidden: { opacity: 0, y: 36, scale: 0.88 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 340, damping: 25, mass: 0.8 },
  },
  exit: {
    opacity: 0,
    y: 22,
    scale: 0.92,
    transition: { duration: 0.2, ease: 'easeInOut' },
  },
};

const RISK_LEVELS = {
  SAFE: 'Safe',
  POTENTIAL: 'Potential Risk',
  VERY_HIGH: 'Very High Risk',
};

const CRIME_COLORS = {
  [RISK_LEVELS.SAFE]: '#34d399',
  [RISK_LEVELS.POTENTIAL]: '#f59e0b',
  [RISK_LEVELS.VERY_HIGH]: '#ef4444',
};

const TRAFFIC_COLORS = {
  [RISK_LEVELS.SAFE]: '#22d3ee',
  [RISK_LEVELS.POTENTIAL]: '#fb923c',
  [RISK_LEVELS.VERY_HIGH]: '#c084fc',
};

const DASHBOARD_CATEGORY_ORDER = ['crime', 'theft', 'accident', 'traffic', 'casualty'];

const DASHBOARD_CATEGORY_COLORS = {
  crime: '#ef4444',
  theft: '#38bdf8',
  accident: '#f97316',
  traffic: '#a855f7',
  casualty: '#14b8a6',
};

const DASHBOARD_CATEGORY_LABELS = {
  crime: 'Crime',
  theft: 'Theft',
  accident: 'Accident',
  traffic: 'Traffic',
  casualty: 'Casualty',
};

const DASHBOARD_DISTANCE_BINS = [
  { label: '0-10 km', min: 0, max: 10 },
  { label: '10-25 km', min: 10, max: 25 },
  { label: '25-50 km', min: 25, max: 50 },
  { label: '50-75 km', min: 50, max: 75 },
];

const CATEGORY_RISK_WEIGHTS = {
  crime: 1,
  theft: 0.84,
  accident: 0.92,
  traffic: 0.76,
  casualty: 0.8,
};

function createCategoryTotals() {
  return DASHBOARD_CATEGORY_ORDER.reduce((acc, category) => {
    acc[category] = 0;
    return acc;
  }, {});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatHour(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const h = normalized % 12 || 12;
  return `${h} ${suffix}`;
}

async function reverseGeocodeLocation(lat, lng) {
  const endpoint = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Reverse geocoding failed: ${response.status}`);
  }

  const payload = await response.json();
  const address = payload.address ?? {};

  const localArea =
    address.neighbourhood ||
    address.suburb ||
    address.village ||
    address.town ||
    address.city_district ||
    address.city ||
    address.hamlet ||
    '';

  const district = address.state_district || address.county || '';
  const state = address.state || '';
  const country = address.country || '';

  return {
    displayName: [localArea, district, state, country].filter(Boolean).join(', ') || payload.display_name || 'Unknown place',
    localArea,
    district,
    state,
    country,
    rawDisplayName: payload.display_name || '',
  };
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function dashboardCategory(point) {
  if (!point?.source) return 'crime';
  if (point.source === 'theft') return 'theft';
  if (point.source === 'accident') return 'accident';
  if (point.source === 'traffic-city' || point.source === 'traffic-state') return 'traffic';
  if (point.source === 'casualty-city' || point.source === 'casualty-state') return 'casualty';
  return 'crime';
}

function getRiskLevel(value = 0) {
  if (value <= 40) return RISK_LEVELS.SAFE;
  if (value <= 70) return RISK_LEVELS.POTENTIAL;
  return RISK_LEVELS.VERY_HIGH;
}

function getPointColor(point) {
  const level = getRiskLevel(point.riskScore ?? point.weight);
  if (point.source === 'theft') {
    return {
      [RISK_LEVELS.SAFE]: '#38bdf8',
      [RISK_LEVELS.POTENTIAL]: '#f59e0b',
      [RISK_LEVELS.VERY_HIGH]: '#ef4444',
    }[level];
  }
  if (point.source === 'accident' || point.source === 'traffic-city' || point.source === 'traffic-state' || point.source === 'casualty-city' || point.source === 'casualty-state') {
    return {
      [RISK_LEVELS.SAFE]: '#22d3ee',
      [RISK_LEVELS.POTENTIAL]: '#fb923c',
      [RISK_LEVELS.VERY_HIGH]: '#a855f7',
    }[level];
  }
  return CRIME_COLORS[level];
}

function getPointType(point) {
  if (point.source === 'theft') return 'Theft';
  if (point.source === 'accident' || point.source === 'traffic-city' || point.source === 'traffic-state' || point.source === 'casualty-city' || point.source === 'casualty-state') return 'Accident';
  return 'Crime';
}

function getPointSymbol(point) {
  if (point.source === 'theft') return '💠';
  if (point.source === 'accident') return '⚠';
  return '🛡';
}

function toLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (firstChar) => firstChar.toUpperCase())
    .trim();
}

function popupHtml(point) {
  const risk = getRiskLevel(point.riskScore ?? point.weight);
  const statLines = Object.entries(point.stats ?? {})
    .map(([key, value]) => `<div><strong>${toLabel(key)}:</strong> ${value}</div>`)
    .join('');

  return `
    <div style="min-width:220px;">
      <h4 style="margin:0 0 6px;font-size:14px;">${point.label ?? 'Hotspot Point'}</h4>
      <div style="font-size:12px;margin-bottom:6px;"><strong>Type:</strong> ${getPointType(point)}</div>
      <div style="font-size:12px;margin-bottom:6px;"><strong>Risk:</strong> ${risk}</div>
      <div style="font-size:12px;line-height:1.4;">${statLines}</div>
    </div>
  `;
}

function tooltipHtml(point) {
  const risk = getRiskLevel(point.riskScore ?? point.weight);
  const statLines = Object.entries(point.stats ?? {})
    .slice(0, 4)
    .map(([key, value]) => `<div><strong>${toLabel(key)}:</strong> ${value}</div>`)
    .join('');

  return `
    <div style="min-width:180px;">
      <div style="font-size:12px;margin-bottom:4px;"><strong>${point.label ?? 'Hotspot Point'}</strong></div>
      <div style="font-size:11px;margin-bottom:4px;"><strong>Type:</strong> ${getPointType(point)} · <strong>Risk:</strong> ${risk}</div>
      <div style="font-size:11px;line-height:1.35;">${statLines}</div>
    </div>
  `;
}

function getMarkerSizes(point) {
  const weight = point.weight ?? 1;
  const outerRadius = Math.max(14, 12 + weight * 5.2);
  const innerRadius = Math.max(6, 6 + weight * 2.1);

  return { outerRadius, innerRadius };
}

export default function App() {
  const defaultState = STATE_OPTIONS.includes('Delhi') ? 'Delhi' : STATE_OPTIONS[0];
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('Emergency actions are ready.');
  const [mappingMeta, setMappingMeta] = useState(null);
  const [mappingError, setMappingError] = useState('');
  const [mappingWarnings, setMappingWarnings] = useState([]);
  const [userLocation, setUserLocation] = useState(null);
  const [userPlace, setUserPlace] = useState(null);
  const [isResolvingPlace, setIsResolvingPlace] = useState(false);
  const [activityPoints, setActivityPoints] = useState([]);
  const [selectedState, setSelectedState] = useState(defaultState);
  const [isHighwayMode, setIsHighwayMode] = useState(false);
  const mapContainerRef = useRef(null);
  const leafletMapRef = useRef(null);
  const userLocationLayerRef = useRef(null);

  const selectedStateDirectory = getStateEmergencyContacts(selectedState);
  const selectedContacts = selectedStateDirectory.contacts;
        setMappingWarnings(data.meta?.loadWarnings ?? []);

  const localDashboard = useMemo(() => {
    if (!userLocation || !activityPoints.length) {
      return null;
    }

    const withDistance = activityPoints
      .map((point) => ({
        ...point,
        distance: distanceKm(userLocation.lat, userLocation.lng, point.lat, point.lng),
        category: dashboardCategory(point),
        pointRiskScore: clamp(point.riskScore ?? (point.weight ?? 1) * 22, 0, 100),
      }))
      .filter((point) => Number.isFinite(point.distance) && point.distance <= 75);

    if (!withDistance.length) {
      return {
        totalNearby: 0,
        bands: DASHBOARD_DISTANCE_BINS.map((bin) => ({
          ...bin,
          total: 0,
          categories: createCategoryTotals(),
        })),
        categoryTotals: createCategoryTotals(),
        topCategory: null,
        riskIndex: 0,
        safetyScore: 100,
        averageDistanceKm: 0,
        averageRiskScore: 0,
      };
    }

    const categoryTotals = createCategoryTotals();

    const bands = DASHBOARD_DISTANCE_BINS.map((bin) => {
      const pointsInBin = withDistance.filter((point) => point.distance >= bin.min && point.distance < bin.max);
      const categories = createCategoryTotals();

      pointsInBin.forEach((point) => {
        const category = point.category;
        categories[category] += 1;
        categoryTotals[category] += 1;
      });

      return {
        ...bin,
        total: pointsInBin.length,
        categories,
      };
    });

    const topCategory = DASHBOARD_CATEGORY_ORDER.reduce((winner, category) => {
      if (!winner || categoryTotals[category] > winner.count) {
        return { category, count: categoryTotals[category] };
      }
      return winner;
    }, null);

    const averageDistanceKm = withDistance.reduce((sum, point) => sum + point.distance, 0) / withDistance.length;
    const averageRiskScore = withDistance.reduce((sum, point) => sum + point.pointRiskScore, 0) / withDistance.length;

    const weightedRiskSignal = withDistance.reduce((sum, point) => {
      const distanceFactor = 1 - Math.min(point.distance, 75) / 90;
      const categoryWeight = CATEGORY_RISK_WEIGHTS[point.category] ?? 1;
      return sum + (point.pointRiskScore / 100) * distanceFactor * categoryWeight;
    }, 0);

    const riskIndex = clamp((weightedRiskSignal / withDistance.length) * 175, 0, 100);
    const safetyScore = Math.round(clamp(100 - riskIndex, 0, 100));

    return {
      totalNearby: withDistance.length,
      bands,
      categoryTotals,
      topCategory: topCategory?.count ? topCategory : null,
      riskIndex: Math.round(riskIndex),
      safetyScore,
      averageDistanceKm,
      averageRiskScore,
    };
  }, [activityPoints, userLocation]);

  const safetyTimeline = useMemo(() => {
    if (!localDashboard || !userLocation) {
      return null;
    }

    const total = Math.max(1, localDashboard.totalNearby);
    const categoryShare = Object.fromEntries(
      DASHBOARD_CATEGORY_ORDER.map((category) => [
        category,
        (localDashboard.categoryTotals?.[category] ?? 0) / total,
      ]),
    );

    const baselineRisk = (localDashboard.riskIndex ?? 0) / 100;

    const points = Array.from({ length: 24 }, (_, hour) => {
      const nightFactor = hour >= 22 || hour <= 4 ? 1 : hour === 5 || hour === 21 ? 0.6 : 0;
      const commuteFactor = (hour >= 8 && hour <= 10) || (hour >= 18 && hour <= 21) ? 1 : hour === 7 || hour === 11 || hour === 17 ? 0.5 : 0;
      const middayCalm = hour >= 12 && hour <= 15 ? 1 : 0;

      const crimePressure = (categoryShare.crime * 15 + categoryShare.theft * 9) * nightFactor;
      const mobilityPressure = (categoryShare.traffic * 11 + categoryShare.accident * 10) * commuteFactor;
      const harmonicSignal = Math.sin((hour / 24) * Math.PI * 2) * 3 + Math.cos((hour / 24) * Math.PI * 4) * 1.6;

      const predictedRisk = clamp(18 + baselineRisk * 52 + crimePressure + mobilityPressure - middayCalm * 5 + harmonicSignal, 4, 98);
      const safety = Math.round(100 - predictedRisk);

      return {
        hour,
        label: formatHour(hour),
        safety,
        predictedRisk: Math.round(predictedRisk),
      };
    });

    const riskHours = points
      .filter((point) => point.safety <= 45)
      .sort((a, b) => a.safety - b.safety)
      .slice(0, 6);

    const confidence = Math.round(clamp(58 + Math.sqrt(total) * 8, 58, 96));

    return {
      points,
      riskHours,
      confidence,
    };
  }, [localDashboard, userLocation]);

  useEffect(() => {
    if (!userLocation) {
      setUserPlace(null);
      setIsResolvingPlace(false);
      return;
    }

    let active = true;
    setIsResolvingPlace(true);

    reverseGeocodeLocation(userLocation.lat, userLocation.lng)
      .then((place) => {
        if (!active) return;
        setUserPlace(place);
      })
      .catch(() => {
        if (!active) return;
        setUserPlace({
          displayName: 'Unable to resolve exact place name',
          localArea: '',
          district: '',
          state: '',
          country: '',
          rawDisplayName: '',
        });
      })
      .finally(() => {
        if (!active) return;
        setIsResolvingPlace(false);
      });

    return () => {
      active = false;
    };
  }, [userLocation]);

  function sanitizePhoneNumber(number) {
    return String(number).replace(/[^0-9+]/g, '');
  }

  function dialContact(contact) {
    window.location.href = `tel:${sanitizePhoneNumber(contact.number)}`;
    setMessage(`Connecting to ${contact.label} (${selectedState})`);
  }

  function getContactById(contactId) {
    return selectedContacts.find((contact) => contact.id === contactId);
  }

  function dialHighwayContact(contact) {
    window.location.href = `tel:${sanitizePhoneNumber(contact.number)}`;
    setMessage(`Connecting to ${contact.label} (National Highways).`);
  }

  useEffect(() => {
    if (!mapContainerRef.current || leafletMapRef.current) return undefined;

    const map = L.map(mapContainerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: true,
    });

    leafletMapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    const crimeLayer = L.layerGroup().addTo(map);
    const crimeStateLayer = L.layerGroup().addTo(map);
    const theftLayer = L.layerGroup().addTo(map);
    const accidentLayer = L.layerGroup().addTo(map);
    const userLocationLayer = L.layerGroup().addTo(map);
    userLocationLayerRef.current = userLocationLayer;

    const resizeMap = () => {
      map.invalidateSize();
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          resizeMap();
        })
      : null;

    if (resizeObserver) {
      resizeObserver.observe(mapContainerRef.current);
    }

    window.requestAnimationFrame(resizeMap);
    window.setTimeout(resizeMap, 120);

    let active = true;

    function addCirclePoint(layer, point, { fillOpacity = 0.12, dashArray } = {}) {
      const color = getPointColor(point);
      const { outerRadius } = getMarkerSizes(point);
      const risk = getRiskLevel(point.riskScore ?? point.weight);
      const riskFillOpacity = {
        [RISK_LEVELS.SAFE]: 0.08,
        [RISK_LEVELS.POTENTIAL]: 0.14,
        [RISK_LEVELS.VERY_HIGH]: 0.2,
      }[risk];

      const marker = L.circleMarker([point.lat, point.lng], {
        radius: outerRadius,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: Math.max(fillOpacity, riskFillOpacity),
        opacity: 0.6,
        dashArray,
      });

      marker.bindPopup(popupHtml(point));
      marker.addTo(layer);
    }

    async function loadHotspots() {
      try {
        const data = await loadHotspotDatasets();
        if (!active) return;

        setMappingMeta(data.meta);
        setActivityPoints([
          ...(data.crimePoints ?? []),
          ...(data.theftPoints ?? []),
          ...(data.accidentPoints ?? []),
          ...(data.trafficStatePoints ?? []),
          ...(data.trafficCityPoints ?? []),
          ...(data.casualtyPoints ?? []),
        ]);

        crimeLayer.clearLayers();
        crimeStateLayer.clearLayers();
        theftLayer.clearLayers();
        accidentLayer.clearLayers();

        (data.crimeStatePoints ?? []).forEach((point) => {
          addCirclePoint(crimeStateLayer, point, { fillOpacity: 0.09, dashArray: '5 5' });
        });

        data.crimePoints.forEach((point) => {
          addCirclePoint(crimeLayer, point, { fillOpacity: 0.14 });
        });

        data.theftPoints.forEach((point) => {
          addCirclePoint(theftLayer, point, { fillOpacity: 0.12 });
        });

        data.accidentPoints.forEach((point) => {
          addCirclePoint(accidentLayer, point, { fillOpacity: 0.12, dashArray: '6 4' });
        });

        data.trafficStatePoints.forEach((point) => {
          addCirclePoint(accidentLayer, point, { fillOpacity: 0.1, dashArray: '3 5' });
        });

        data.trafficCityPoints.forEach((point) => {
          addCirclePoint(accidentLayer, point, { fillOpacity: 0.1, dashArray: '4 6' });
        });

        data.casualtyPoints.forEach((point) => {
          addCirclePoint(accidentLayer, point, { fillOpacity: 0.08, dashArray: '2 6' });
        });

        const points = [
          ...(data.crimeStatePoints ?? []),
          ...data.crimePoints,
          ...data.theftPoints,
          ...data.accidentPoints,
          ...(data.trafficStatePoints ?? []),
          ...(data.trafficCityPoints ?? []),
        ];
        if (points.length) {
          const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
          map.fitBounds(bounds.pad(0.12));
        }
      } catch (error) {
        if (!active) return;
        console.error(error);
        setMappingError('Unable to fully load CSV mapping diagnostics.');
      }
    }

    loadHotspots();

    return () => {
      active = false;
      resizeObserver?.disconnect();
      userLocationLayerRef.current = null;
      map.remove();
      leafletMapRef.current = null;
    };
  }, []);

  function showMyLocation() {
    const map = leafletMapRef.current;
    const userLayer = userLocationLayerRef.current;

    if (!map || !userLayer) {
      setMessage('Map is still loading. Please try again.');
      return;
    }

    if (!navigator.geolocation) {
      setMessage('Geolocation is not supported on this device.');
      return;
    }

    setMessage('Requesting permission to access your current location...');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setUserLocation({ lat: latitude, lng: longitude });

        userLayer.clearLayers();

        const userIcon = L.divIcon({
          className: 'user-location-marker',
          html: '<span class="user-location-ring" aria-hidden="true"></span><span class="user-location-dot" aria-hidden="true"></span>',
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        });

        const marker = L.marker([latitude, longitude], { icon: userIcon }).addTo(userLayer);

        L.circle([latitude, longitude], {
          radius: 220,
          color: '#60a5fa',
          weight: 1,
          fillColor: '#60a5fa',
          fillOpacity: 0.1,
          opacity: 0.35,
        }).addTo(userLayer);

        marker.bindPopup('Your current location').openPopup();
        map.flyTo([latitude, longitude], Math.max(16, map.getZoom()), { animate: true, duration: 1.1 });
        setMessage('Current location shown on the map.');
      },
      (error) => {
        if (error?.code === 1) {
          setMessage('Location permission denied. Allow location access in browser settings and try again.');
          return;
        }
        if (error?.code === 2) {
          setMessage('Unable to detect location. Please check GPS/network and try again.');
          return;
        }
        if (error?.code === 3) {
          setMessage('Location request timed out. Please try again.');
          return;
        }
        setMessage('Location permission was denied or unavailable.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
    );
  }

  async function handleAction(action) {
    if (navigator.vibrate) navigator.vibrate([12, 20, 12]);

    if (action.id === 'police') {
      const contact = getContactById('police') ?? getContactById('erss');
      if (contact) dialContact(contact);
      return;
    }

    if (action.id === 'ambulance') {
      const contact = getContactById('ambulance') ?? getContactById('erss');
      if (contact) dialContact(contact);
      return;
    }

    if (action.id === 'fire') {
      const contact = getContactById('fire') ?? getContactById('erss');
      if (contact) dialContact(contact);
      return;
    }

    if (action.id === 'highway') {
      dialHighwayContact(NATIONAL_HIGHWAY_CONTACTS[0]);
      return;
    }

    if (action.id === 'share') {
      if (!navigator.geolocation) {
        setMessage('Geolocation is not supported on this device.');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          const url = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
          const text = `My live location: ${url}`;

          if (navigator.share) {
            try {
              await navigator.share({ title: 'Emergency Location', text, url });
              setMessage('Live location shared.');
              return;
            } catch {
              setMessage('Share canceled.');
              return;
            }
          }

          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            setMessage('Live location copied to clipboard.');
            return;
          }

          setMessage('Unable to share location on this browser.');
        },
        () => setMessage('Unable to access your location.'),
        { enableHighAccuracy: true, timeout: 7000 },
      );
      return;
    }

    if (action.id === 'safe') {
      const destination = `https://www.openstreetmap.org/search?query=${encodeURIComponent(`nearest safe zone ${selectedState}`)}`;
      window.open(destination, '_blank', 'noopener,noreferrer');
      setMessage(`Opened nearest safe zone search for ${selectedState}.`);
      return;
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_15%_10%,#122540_0%,#07101d_42%,#040a12_100%)] text-slate-100">
      <main className="relative flex min-h-screen w-full items-start justify-center overflow-hidden px-0 py-0">
        <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(84,142,201,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(84,142,201,0.14)_1px,transparent_1px)] [background-size:48px_48px]" />
        <section className="relative w-full min-h-screen border border-cyan-300/20 bg-slate-900/55 p-4 shadow-2xl shadow-cyan-900/30 backdrop-blur-xl md:p-8">
          <p className="text-xs uppercase tracking-[0.22em] text-cyan-300">UrbanAegis</p>
          <h1 className="mt-3 text-4xl font-black leading-tight text-white md:text-5xl">Predict. Prevent. Protect.</h1>
          <p className="mt-3 max-w-2xl text-slate-300">
            UrbanAegis intelligence for safer cities.
          </p>

          <div className="mt-6 rounded-2xl border border-cyan-300/25 bg-slate-950/50 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.15em] text-cyan-300">Live Risk Hotspot Map</p>
              <button
                type="button"
                onClick={showMyLocation}
                className="rounded-full border border-cyan-300/35 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
              >
                Show My Location
              </button>
            </div>
            <div ref={mapContainerRef} className="h-[380px] w-full rounded-xl border border-cyan-300/25" />

            <div className="mt-3 grid gap-3 text-xs text-slate-200 md:grid-cols-2">
              <div className="rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3">
                <p className="mb-2 uppercase tracking-[0.12em] text-cyan-300">Crime Risk Colors</p>
                <ul className="space-y-1">
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#34d399]" /> Safe</li>
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#f59e0b]" /> Potential Risk</li>
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#ef4444]" /> Very High Risk</li>
                </ul>
              </div>
              <div className="rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3">
                <p className="mb-2 uppercase tracking-[0.12em] text-cyan-300">Theft / Accident / Traffic Colors</p>
                <ul className="space-y-1">
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#38bdf8]" /> Safe Theft Zone</li>
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#fb923c]" /> Potential Theft / Accident Risk</li>
                  <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#a855f7]" /> Very High Accident Risk</li>
                </ul>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3 text-xs text-slate-200">
              <p className="mb-2 uppercase tracking-[0.12em] text-cyan-300">Denotation Guide</p>
              <div className="grid gap-2 md:grid-cols-3">
                <p className="flex items-center gap-2"><span className="text-lg">🛡</span> Crime</p>
                <p className="flex items-center gap-2"><span className="text-lg">💠</span> Theft</p>
                <p className="flex items-center gap-2"><span className="text-lg">⚠</span> Accident</p>
              </div>
            </div>

            <p className="mt-3 text-[11px] text-slate-300">
              Bigger ring = higher risk. Green / cyan are safer, amber means potential risk, and red / purple are very high risk zones.
            </p>
          </div>

          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-slate-950/45 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.15em] text-cyan-300">Local Activity Dashboard (75 km)</p>
              {userLocation ? (
                <p className="text-[11px] text-cyan-200">
                  Lat {userLocation.lat.toFixed(4)} · Lng {userLocation.lng.toFixed(4)}
                </p>
              ) : null}
            </div>

            {!userLocation ? (
              <p className="mt-3 text-sm text-slate-300">Tap “Show My Location” to generate your nearby activity histogram.</p>
            ) : !localDashboard ? (
              <p className="mt-3 text-sm text-slate-300">Preparing local dashboard...</p>
            ) : localDashboard.totalNearby === 0 ? (
              <p className="mt-3 text-sm text-slate-300">No mapped activity points found within 75 km of your current location.</p>
            ) : (
              <>
                <div className="mt-3 rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3 text-sm text-slate-200">
                  <p className="text-xs uppercase tracking-[0.12em] text-cyan-300">Exact Place</p>
                  <p className="mt-1 font-semibold text-cyan-100">
                    {isResolvingPlace ? 'Resolving your exact place...' : userPlace?.displayName || 'Unknown location'}
                  </p>
                </div>

                <div className="mt-3 grid gap-2 text-sm text-slate-200 md:grid-cols-2 xl:grid-cols-4">
                  <p className="rounded-lg border border-cyan-300/20 bg-slate-900/55 px-3 py-2">Nearby mapped activities: <strong>{localDashboard.totalNearby}</strong></p>
                  <p className="rounded-lg border border-cyan-300/20 bg-slate-900/55 px-3 py-2">Safety score: <strong>{localDashboard.safetyScore}/100</strong></p>
                  <p className="rounded-lg border border-cyan-300/20 bg-slate-900/55 px-3 py-2">Risk index: <strong>{localDashboard.riskIndex}/100</strong></p>
                  <p className="rounded-lg border border-cyan-300/20 bg-slate-900/55 px-3 py-2">Avg. risk (nearby): <strong>{Math.round(localDashboard.averageRiskScore)}/100</strong></p>
                </div>

                <div className="mt-2 grid gap-2 text-sm text-slate-200 md:grid-cols-2">
                  <p>
                    Dominant category:{' '}
                    {localDashboard.topCategory
                      ? `${DASHBOARD_CATEGORY_LABELS[localDashboard.topCategory.category]} (${localDashboard.topCategory.count})`
                      : 'N/A'}
                  </p>
                  <p>Average distance of nearby activities: {localDashboard.averageDistanceKm.toFixed(1)} km</p>
                </div>

                <div className="mt-3 space-y-3">
                  {localDashboard.bands.map((band) => {
                    const total = band.total || 1;
                    return (
                      <div key={band.label} className="rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3">
                        <div className="mb-2 flex items-center justify-between text-xs text-slate-200">
                          <span className="font-semibold text-cyan-100">{band.label}</span>
                          <span>{band.total} points</span>
                        </div>

                        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800/90">
                          {DASHBOARD_CATEGORY_ORDER.map((category) => {
                            const count = band.categories[category] ?? 0;
                            if (!count) return null;
                            const width = (count / total) * 100;
                            return (
                              <span
                                key={`${band.label}-${category}`}
                                className="inline-block h-full"
                                style={{ width: `${width}%`, backgroundColor: DASHBOARD_CATEGORY_COLORS[category] }}
                                title={`${DASHBOARD_CATEGORY_LABELS[category]}: ${count}`}
                              />
                            );
                          })}
                        </div>

                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-300">
                          {DASHBOARD_CATEGORY_ORDER.map((category) => (
                            <span key={`${band.label}-legend-${category}`} className="flex items-center gap-1">
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: DASHBOARD_CATEGORY_COLORS[category] }}
                              />
                              {DASHBOARD_CATEGORY_LABELS[category]} {band.categories[category] ?? 0}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {safetyTimeline ? (
                  <div className="mt-4 rounded-xl border border-cyan-300/20 bg-slate-900/60 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs uppercase tracking-[0.12em] text-cyan-300">Safety Forecast (Next 24 Hours)</p>
                      <p className="text-[11px] text-cyan-200">Model confidence: {safetyTimeline.confidence}%</p>
                    </div>

                    <div className="h-40 overflow-hidden rounded-lg border border-cyan-300/15 bg-slate-950/60 p-2">
                      <div className="flex h-full items-end gap-1">
                        {safetyTimeline.points.map((point) => {
                          const barColor =
                            point.safety <= 45
                              ? '#ef4444'
                              : point.safety <= 65
                                ? '#f59e0b'
                                : '#34d399';

                          return (
                            <div key={`forecast-${point.hour}`} className="group flex min-w-0 flex-1 flex-col items-center justify-end">
                              <div
                                className="w-full rounded-t-sm"
                                style={{
                                  height: `${Math.max(8, point.safety)}%`,
                                  backgroundColor: barColor,
                                  opacity: 0.9,
                                }}
                                title={`${point.label}: Safety ${point.safety}/100 · Risk ${point.predictedRisk}/100`}
                              />
                              <span className="mt-1 text-[9px] text-slate-400">
                                {point.hour % 3 === 0 ? point.label : ''}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Risk Times (High)</p>
                        {safetyTimeline.riskHours.length ? (
                          <ul className="mt-1 list-disc pl-5 text-xs text-amber-200">
                            {safetyTimeline.riskHours.map((entry) => (
                              <li key={`risk-hour-${entry.hour}`}>
                                {entry.label} · Safety {entry.safety}/100
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1 text-xs text-emerald-300">No severe risk window predicted in the next 24 hours.</p>
                        )}
                      </div>

                      <div>
                        <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Model Notes</p>
                        <p className="mt-1 text-xs text-slate-300">
                          Forecast uses nearby crime/theft/accident/traffic intensity + time-of-day cyclic patterns to predict hourly safety.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-slate-950/45 p-4">
            <p className="text-xs uppercase tracking-[0.15em] text-cyan-300">Exact Location Diagnostics</p>
            {mappingWarnings.length ? (
              <div className="mt-2 rounded-xl border border-amber-300/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                <p className="mb-1 font-semibold">Some CSV files were partially unavailable</p>
                <ul className="list-disc space-y-1 pl-5">
                  {mappingWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {mappingError ? (
              <p className="mt-2 text-sm text-red-300">{mappingError}</p>
            ) : !mappingMeta ? (
              <p className="mt-2 text-sm text-slate-300">Loading mapping diagnostics...</p>
            ) : (
              <>
                <div className="mt-2 grid gap-2 text-sm text-slate-200 md:grid-cols-2">
                  <p>Crime points plotted: {mappingMeta.crimeLayerCount}</p>
                  <p>Theft points plotted: {mappingMeta.theftLayerCount}</p>
                  <p>Accident points plotted: {mappingMeta.accidentLayerCount}</p>
                  <p>Exact rows with coordinates: {mappingMeta.crimeRecords}</p>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Exact-location status</p>
                    {mappingMeta.exactCrimeRowsWithoutCoordinates ? (
                      <p className="mt-1 text-xs text-amber-200">
                        {mappingMeta.exactCrimeRowsWithoutCoordinates} rows had no latitude/longitude and were skipped.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-emerald-300">All exact-location rows were plotted.</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Other CSV scans</p>
                    {mappingMeta.trafficCityRecords || mappingMeta.trafficStateRecords ? (
                      <p className="mt-1 text-xs text-slate-300">
                        Traffic and casualty CSVs were scanned for diagnostics, but only rows with latitude/longitude are plotted on the map.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-emerald-300">No extra CSV scans pending.</p>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Unmapped Crime States</p>
                    {mappingMeta.crimeUnmappedStateNames?.length ? (
                      <ul className="mt-1 list-disc pl-5 text-xs text-amber-200">
                        {mappingMeta.crimeUnmappedStateNames.map((stateName) => (
                          <li key={`crime-${stateName}`}>{stateName}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-emerald-300">All crime states are mapped.</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Precision note</p>
                    {mappingMeta.exactCrimeRowsLoaded ? (
                      <p className="mt-1 text-xs text-cyan-200">
                        Exact coordinates from the lat/long CSV are used directly without jitter.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-amber-200">Exact-location file is still loading.</p>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Unmapped Crime States</p>
                    {mappingMeta.crimeUnmappedStateNames?.length ? (
                      <ul className="mt-1 list-disc pl-5 text-xs text-amber-200">
                        {mappingMeta.crimeUnmappedStateNames.map((stateName) => (
                          <li key={`crime-${stateName}`}>{stateName}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-emerald-300">All crime states are mapped.</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-300">Scanned traffic states (not plotted)</p>
                    {mappingMeta.trafficStateUnmappedNames?.length ? (
                      <ul className="mt-1 list-disc pl-5 text-xs text-amber-200">
                        {mappingMeta.trafficStateUnmappedNames.map((stateName) => (
                          <li key={`traffic-${stateName}`}>{stateName}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-emerald-300">Scanned for diagnostics only.</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-slate-950/45 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.15em] text-cyan-300">Government Emergency Contacts by State</p>
              <label className="text-xs text-slate-300" htmlFor="state-selector">
                Select State / UT
              </label>
            </div>

            <select
              id="state-selector"
              value={selectedState}
              onChange={(event) => setSelectedState(event.target.value)}
              className="mt-2 w-full rounded-xl border border-cyan-300/30 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-300/40 focus:ring"
            >
              {STATE_OPTIONS.map((stateName) => (
                <option key={stateName} value={stateName}>
                  {stateName}
                </option>
              ))}
            </select>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {selectedContacts.map((contact) => (
                <div
                  key={`${selectedState}-${contact.id}`}
                  className="rounded-xl border border-cyan-300/20 bg-slate-900/55 p-3"
                >
                  <p className="text-sm font-semibold text-cyan-100">{contact.label}</p>
                  <p className="mt-1 text-lg font-bold text-white">{contact.number}</p>
                  <p className="mt-1 text-xs text-slate-300">{contact.description}</p>
                  <button
                    type="button"
                    onClick={() => dialContact(contact)}
                    className="mt-2 rounded-lg border border-cyan-300/35 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
                  >
                    Call Now
                  </button>
                </div>
              ))}
            </div>

            <p className="mt-3 text-xs text-slate-400">
              Contacts are shown for {selectedState}. For local variations, verify with official state government advisories.
            </p>

            <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-slate-900/55 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.15em] text-emerald-300">Travelling on National Highways</p>
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-200" htmlFor="highway-mode">
                  <input
                    id="highway-mode"
                    type="checkbox"
                    checked={isHighwayMode}
                    onChange={(event) => setIsHighwayMode(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-500 bg-slate-800 text-emerald-300 focus:ring-emerald-300"
                  />
                  Enable highway contacts
                </label>
              </div>

              <p className="mt-2 text-xs text-slate-300">
                Use these priority numbers for incidents while travelling on National Highways.
              </p>

              {isHighwayMode ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {NATIONAL_HIGHWAY_CONTACTS.map((contact) => (
                    <div key={contact.id} className="rounded-xl border border-emerald-300/25 bg-slate-900/60 p-3">
                      <p className="text-sm font-semibold text-emerald-100">{contact.label}</p>
                      <p className="mt-1 text-lg font-bold text-white">{contact.number}</p>
                      <p className="mt-1 text-xs text-slate-300">{contact.description}</p>
                      <button
                        type="button"
                        onClick={() => dialHighwayContact(contact)}
                        className="mt-2 rounded-lg border border-emerald-300/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20"
                      >
                        Call Highway Support
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-400">Enable the toggle to view highway emergency contacts.</p>
              )}
            </div>
          </div>
        </section>

        <motion.button
          whileTap={{ scale: 0.96 }}
          whileHover={{ scale: 1.04 }}
          onClick={() => setOpen((v) => !v)}
          className="fixed bottom-6 right-6 z-50 rounded-full border border-cyan-300/40 bg-slate-900/90 px-5 py-3 text-sm font-bold text-cyan-100 shadow-glow animate-pulse-soft"
          aria-expanded={open}
          aria-controls="emergency-panel"
        >
          🛡 SOS
        </motion.button>

        <AnimatePresence>
          {open && (
            <motion.aside
              id="emergency-panel"
              role="dialog"
              aria-label="Emergency assistance"
              variants={panelMotion}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="fixed bottom-24 right-6 z-50 w-[min(380px,calc(100%-2rem))] rounded-2xl border border-red-400/60 bg-slate-900/85 p-4 shadow-2xl shadow-red-900/25 backdrop-blur-xl"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-red-100">Emergency Assistance</h2>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-full border border-red-300/50 bg-red-500/20 px-2 py-1 text-xs text-red-50"
                  aria-label="Close emergency panel"
                >
                  ✕
                </button>
              </div>

              <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-100">
                <span className="h-2 w-2 rounded-full bg-red-400 shadow-[0_0_0_0_rgba(248,113,113,0.45)] animate-ping" />
                Connected to emergency services
              </div>

              <div className="grid gap-2">
                {actions.map((action) => (
                  <motion.button
                    key={action.id}
                    whileHover={{ x: 2 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => handleAction(action)}
                    className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold text-red-50 transition ${action.tone}`}
                  >
                    {action.label}
                  </motion.button>
                ))}
              </div>

              <p className="mt-3 min-h-5 text-xs text-red-100/90">{message}</p>

              <div className="mt-3 rounded-xl border border-red-300/30 bg-slate-800/70 p-3">
                <p className="text-xs uppercase tracking-[0.16em] text-red-200">Nearest services</p>
                <ul className="mt-2 space-y-1 text-xs text-slate-200">
                  <li>Police: City Central Unit · 1.9 km</li>
                  <li>Hospital: Metro Emergency Care · 2.4 km</li>
                  <li>Fire: Civic Response Base · 3.1 km</li>
                </ul>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
