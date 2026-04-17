import Papa from 'papaparse';
import { CITY_COORDINATES } from './cityCoordinates.js';
import { STATE_COORDINATES } from './stateCoordinates.js';

const DISTRICT_CRIME_FILE = '/data/districtwise-ipc-crimes-2017-onwards.csv';
const DISTRICT_CRIME_LATLONG_FILE = '/data/districtwise-ipc-crimes-2017-onwards_WITH_LAT_LONG.csv';
const VEHICLES_FILE = '/data/VehiclesBig.csv';
const CASUALTIES_FILE = '/data/CasualtiesBig.csv';
const TRAFFIC_CITY_FILE = '/data/traffic_city_2022_2023.csv';
const TRAFFIC_STATE_FILE = '/data/traffic_state_2019_2023.csv';

const TRAFFIC_STATE_NAME_ALIASES = {
  'Andaman & Nicobar Islands': 'Andaman And Nicobar Islands',
  'Dadra & Nagar Haveli*': 'The Dadra And Nagar Haveli And Daman And Diu',
  'Daman & Diu': 'The Dadra And Nagar Haveli And Daman And Diu',
  'J & K #': 'Jammu And Kashmir',
  Gujrat: 'Gujarat',
  'Uttarpradesh': 'Uttar Pradesh',
  'Uttar Pradesh ': 'Uttar Pradesh',
};

const TELANGANA_HISTORIC_DISTRICTS = new Set([
  'adilabad',
  'bhadradri kothagudem',
  'hyderabad',
  'jagtial',
  'jangaon',
  'jayashankar bhupalapally',
  'jogulamba gadwal',
  'kamareddy',
  'karimnagar',
  'khammam',
  'kumuram bheem asifabad',
  'mahabubabad',
  'mahabubnagar',
  'mancherial',
  'medak',
  'medchal malkajgiri',
  'mulugu',
  'nagarkurnool',
  'nalgonda',
  'narayanpet',
  'nirmal',
  'nizamabad',
  'peddapalli',
  'rajanna sircilla',
  'sangareddy',
  'siddipet',
  'suryapet',
  'vikarabad',
  'wanaparthy',
  'warangal',
  'warangal rural',
  'warangal urban',
  'yadadri bhuvanagiri',
  'yadadri bhongir',
  'rangareddy',
  'ranga reddy',
  'jayashankar bhupalpalli',
  'rajanna siricilla',
]);

const THEFT_FIELDS = [
  'auto_motor_vehicle_theft',
  'other_thefts',
  'day_time_burglary',
  'night_burglary',
  'extortion_and_blackmailing',
  'robbery',
  'atmpt_dacoity_robbery',
  'dacoity',
  'dacoity_with_murder',
  'criminal_misappropriation',
  'criminal_breach_of_trust',
  'dsh_hon_rec_deal_stl_prop',
  'counterfeit_coin',
  'cntrfte_govt_stamp',
  'cntrft_seal_mark',
  'cntrft_curr_bank_notes',
  'bank_frauds',
  'atm_fraud',
  'credit_debit_card_fraud',
  'other_frauds',
  'cheating',
  'forgery',
];

const ACCIDENT_FIELDS = [
  'hit_and_run',
  'acdnt_other_than_hit_and_run_',
  'deaths_negl_rel_rail_acdnt',
  'deaths_due_med_negnc',
  'deaths_neg_civic_bodies',
  'deaths_other_negnc',
  'rash_driving_pub_way',
  'csng_hrt_rsh_nglgnt_drvng_pblc_wy',
  'grvus_hrt_rsh_nglgnt_drvng',
  'obstruction_pub_way',
];

const EXACT_LOCATION_META_FIELDS = new Set([
  'id',
  'year',
  'state_name',
  'state_code',
  'district_name',
  'district_code',
  'registration_circles',
  'latitude',
  'longitude',
]);

const RAJASTHAN_FALLBACK = STATE_COORDINATES.Rajasthan;

const EXCLUDED_CRIME_FIELDS = new Set([
  ...EXACT_LOCATION_META_FIELDS,
  ...THEFT_FIELDS,
  ...ACCIDENT_FIELDS,
]);

function parseCsv(csvText) {
  const result = Papa.parse(csvText, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  if (result.errors?.length) {
    const nonFieldErrors = result.errors.filter((error) => error.type !== 'FieldMismatch');
    if (nonFieldErrors.length) {
      throw new Error(nonFieldErrors[0].message);
    }
  }

  return result.data;
}

async function loadCsv(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }

  return parseCsv(await response.text());
}

function parseCoordinates(row) {
  const latitude = toNumber(row.latitude);
  const longitude = toNumber(row.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude === 0 || longitude === 0) {
    return null;
  }

  if (latitude < 6 || latitude > 38.5 || longitude < 68 || longitude > 98.5) {
    return RAJASTHAN_FALLBACK;
  }

  return { latitude, longitude };
}

function sumFields(row, fields) {
  return fields.reduce((total, field) => total + toNumber(row[field]), 0);
}

function scoreToRisk100(score) {
  if (!score || score <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(score + 1) * 25));
}

function scoreToWeight(score100) {
  return Math.min(4, Math.max(0.6, 0.6 + score100 / 33.333));
}

function buildExactLocationPoints(rows) {
  const exactRows = [];
  const stats = {
    rowsWithCoordinates: 0,
    rowsWithoutCoordinates: 0,
    categoryCounts: {
      crime: 0,
      theft: 0,
      accident: 0,
    },
  };

  for (const row of rows) {
    const coords = parseCoordinates(row);
    if (!coords) {
      stats.rowsWithoutCoordinates += 1;
      continue;
    }

    stats.rowsWithCoordinates += 1;

    const stateName = normalizeCrimeStateName(row.state_name, row.district_name);
    const districtName = String(row.district_name ?? '').trim();
    const baseLabel = [stateName, districtName].filter(Boolean).join(' / ') || 'Exact Location';

    const crimeScore = Object.entries(row).reduce((total, [key, value]) => {
      if (EXCLUDED_CRIME_FIELDS.has(key)) return total;
      const numericValue = Number(value);
      return Number.isFinite(numericValue) && numericValue > 0 ? total + numericValue : total;
    }, 0);

    const theftScore = sumFields(row, THEFT_FIELDS);
    const accidentScore = sumFields(row, ACCIDENT_FIELDS);

    exactRows.push({
      coords,
      stateName,
      districtName,
      baseLabel,
      crimeScore,
      theftScore,
      accidentScore,
    });
  }

  const crimePoints = [];
  const theftPoints = [];
  const accidentPoints = [];

  for (const entry of exactRows) {
    const { coords, stateName, districtName, baseLabel, crimeScore, theftScore, accidentScore } = entry;

    if (crimeScore > 0) {
      const riskScore = scoreToRisk100(crimeScore);
      stats.categoryCounts.crime += 1;
      crimePoints.push({
        lat: coords.latitude,
        lng: coords.longitude,
        weight: scoreToWeight(riskScore),
        riskScore,
        source: 'crime',
        category: 'crime',
        label: baseLabel,
        stats: {
          scope: 'Crime',
          score: Math.round(crimeScore),
          riskScore,
          state: stateName,
          district: districtName,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
      });
    }

    if (theftScore > 0) {
      const riskScore = scoreToRisk100(theftScore);
      stats.categoryCounts.theft += 1;
      theftPoints.push({
        lat: coords.latitude,
        lng: coords.longitude,
        weight: scoreToWeight(riskScore),
        riskScore,
        source: 'theft',
        category: 'theft',
        label: baseLabel,
        stats: {
          scope: 'Theft',
          score: Math.round(theftScore),
          riskScore,
          state: stateName,
          district: districtName,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
      });
    }

    if (accidentScore > 0) {
      const riskScore = scoreToRisk100(accidentScore);
      stats.categoryCounts.accident += 1;
      accidentPoints.push({
        lat: coords.latitude,
        lng: coords.longitude,
        weight: scoreToWeight(riskScore),
        riskScore,
        source: 'accident',
        category: 'accident',
        label: baseLabel,
        stats: {
          scope: 'Accident',
          score: Math.round(accidentScore),
          riskScore,
          state: stateName,
          district: districtName,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
      });
    }
  }

  return { crimePoints, theftPoints, accidentPoints, stats };
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeCityName(cityName) {
  const city = String(cityName ?? '').trim();
  if (city === 'Bengaluru') return 'Bangalore';
  if (city === 'Vizaq') return 'Visakhapatnam';
  if (city === 'Kolkatta') return 'Kolkata';
  if (city === 'Calcutta') return 'Kolkata';
  return city;
}

function normalizeDistrictKey(districtName) {
  return String(districtName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCrimeStateName(stateName, districtName = '') {
  const state = String(stateName ?? '').trim();
  if (!state) return state;

  if (state === 'Andhra Pradesh' && TELANGANA_HISTORIC_DISTRICTS.has(normalizeDistrictKey(districtName))) {
    return 'Telangana';
  }

  return state;
}

function normalizeStateName(stateName) {
  const state = String(stateName ?? '').trim();
  return TRAFFIC_STATE_NAME_ALIASES[state] ?? state;
}

function districtCrimeScore(row) {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    if (
      key === 'id' ||
      key === 'year' ||
      key === 'state_name' ||
      key === 'state_code' ||
      key === 'district_name' ||
      key === 'district_code' ||
      key === 'registration_circles'
    ) {
      continue;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      total += numericValue;
    }
  }

  return total;
}

function latestDistrictRows(rows) {
  const latestByDistrict = new Map();

  for (const row of rows) {
    const stateName = normalizeCrimeStateName(row.state_name, row.district_name);
    const districtName = String(row.district_name ?? '').trim();
    if (!stateName || !districtName) continue;

    const year = Number(row.year) || 0;
    const key = `${stateName}::${districtName}`;
    const normalizedRow = stateName === String(row.state_name ?? '').trim() ? row : { ...row, state_name: stateName };
    const existing = latestByDistrict.get(key);

    if (!existing || year > Number(existing.year || 0)) {
      latestByDistrict.set(key, normalizedRow);
    }
  }

  return [...latestByDistrict.values()];
}

function aggregateStateCrime(rows) {
  const stateTotals = new Map();

  for (const row of rows) {
    const stateName = normalizeCrimeStateName(row.state_name, row.district_name);
    if (!stateName) continue;

    const score = districtCrimeScore(row);
    const year = Number(row.year) || 0;
    const existing = stateTotals.get(stateName) ?? {
      totalScore: 0,
      districtCount: 0,
      latestYear: 0,
    };

    stateTotals.set(stateName, {
      totalScore: existing.totalScore + score,
      districtCount: existing.districtCount + 1,
      latestYear: Math.max(existing.latestYear, year),
    });
  }

  return stateTotals;
}

function mapStateCrimeToHotspots(crimeRows) {
  const rows = latestDistrictRows(crimeRows);
  const stateTotals = aggregateStateCrime(rows);
  const points = [];
  let unmatchedStateCount = 0;
  const unmatchedStateNames = new Set();

  for (const [stateName, stateSummary] of stateTotals.entries()) {
    const base = STATE_COORDINATES[stateName];

    if (!base) {
      unmatchedStateCount += 1;
      unmatchedStateNames.add(stateName);
      continue;
    }

    const riskScore = scoreToRisk100(stateSummary.totalScore);

    points.push({
      lat: base.lat,
      lng: base.lng,
      weight: scoreToWeight(riskScore),
      riskScore,
      source: 'crime-state',
      label: stateName,
      stats: {
        scope: 'State Crime Overview',
        districtRows: stateSummary.districtCount,
        totalCrimeScore: Math.round(stateSummary.totalScore),
        riskScore,
        latestYear: stateSummary.latestYear,
      },
    });
  }

  return {
    points,
    unmatchedStateCount,
    unmatchedStateNames: [...unmatchedStateNames].sort(),
    districtRowsUsed: rows.length,
    statesRepresented: stateTotals.size,
  };
}

function mapCityTrafficToHotspots(cityTrafficRows) {
  const points = [];
  let unmatchedCities = 0;
  const unmatchedCityNames = new Set();

  for (const row of cityTrafficRows) {
    const rawCityName = String(row.City ?? '').trim();
    if (!rawCityName || rawCityName.toLowerCase() === 'total') continue;

    const cityName = normalizeCityName(rawCityName);
    const cityCoordinate = CITY_COORDINATES[cityName];
    if (!cityCoordinate) {
      unmatchedCities += 1;
      unmatchedCityNames.add(cityName);
      continue;
    }

    const accidents2023 = toNumber(row['2023 Accidents']);
    const killed2023 = toNumber(row['2023 Killed']);
    const injured2023 = toNumber(row['2023 Injured']);
    const cityTrafficScore = accidents2023 + killed2023 * 2 + injured2023 * 0.75;
    const riskScore = scoreToRisk100(cityTrafficScore);

    points.push({
      lat: cityCoordinate.lat,
      lng: cityCoordinate.lng,
      weight: scoreToWeight(riskScore),
      riskScore,
      source: 'traffic-city',
      label: cityName,
      stats: {
        scope: 'City Traffic Accidents (2023)',
        accidents2023,
        killed2023,
        injured2023,
        riskScore,
      },
    });
  }

  return { points, unmatchedCities, unmatchedCityNames: [...unmatchedCityNames].sort() };
}

function mapStateTrafficToHotspots(stateTrafficRows) {
  const points = [];
  let unmatchedStates = 0;
  const unmatchedStateNames = new Set();

  for (const row of stateTrafficRows) {
    const rawStateName = String(row.State ?? '').trim();
    if (!rawStateName || rawStateName.toLowerCase() === 'all india') continue;

    const stateName = normalizeStateName(rawStateName);
    const stateCoordinate = STATE_COORDINATES[stateName];
    if (!stateCoordinate) {
      unmatchedStates += 1;
      unmatchedStateNames.add(stateName);
      continue;
    }

    const accidents2023 = toNumber(row['2023 Accidents']);
    const change = toNumber(row['Change from 2022 to 2023']);
    const stateTrafficScore = accidents2023 + Math.max(0, change) * 0.6;
    const riskScore = scoreToRisk100(stateTrafficScore);

    points.push({
      lat: stateCoordinate.lat,
      lng: stateCoordinate.lng,
      weight: scoreToWeight(riskScore),
      riskScore,
      source: 'traffic-state',
      label: stateName,
      stats: {
        scope: 'State Traffic Accidents (2023)',
        accidents2023,
        changeFrom2022: change,
        riskScore,
      },
    });
  }

  return { points, unmatchedStates, unmatchedStateNames: [...unmatchedStateNames].sort() };
}

function computeCasualtySummary(casualtyRows) {
  let totalCasualties = 0;
  let weightedSeverity = 0;
  const severityBreakdown = {
    1: 0,
    2: 0,
    3: 0,
  };

  for (const row of casualtyRows) {
    const severity = Number(row.Casualty_Severity) || 0;
    const severityWeight = severity === 1 ? 3 : severity === 2 ? 2 : 1;
    totalCasualties += 1;
    weightedSeverity += severityWeight;
    if (severityBreakdown[severity] !== undefined) {
      severityBreakdown[severity] += 1;
    }
  }

  return { totalCasualties, weightedSeverity, severityBreakdown };
}

function buildCasualtyOverlayPoints(trafficPoints, casualtySummary) {
  const totalTrafficWeight = trafficPoints.reduce((sum, point) => sum + (point.weight ?? 1), 0) || 1;

  return trafficPoints.map((point) => {
    const share = (point.weight ?? 1) / totalTrafficWeight;
    const casualtyShare = Math.max(1, Math.round(casualtySummary.totalCasualties * share));
    const weightedSeverityShare = Math.max(1, Math.round(casualtySummary.weightedSeverity * share));

    return {
      ...point,
      source: point.source === 'traffic-city' ? 'casualty-city' : 'casualty-state',
      label: point.label,
      riskScore: point.riskScore,
      stats: {
        scope: 'Casualty Overlay',
        casualtyRecords: casualtyShare,
        weightedSeverity: weightedSeverityShare,
        riskScore: point.riskScore,
      },
    };
  });
}

function computeAccidentSeverityByIndex(vehicleRows, casualtyRows) {
  const vehicleCounts = new Map();
  for (const row of vehicleRows) {
    const index = String(row.Accident_Index ?? '').trim();
    if (!index) continue;
    vehicleCounts.set(index, (vehicleCounts.get(index) ?? 0) + 1);
  }

  const casualtyCounts = new Map();
  for (const row of casualtyRows) {
    const index = String(row.Accident_Index ?? '').trim();
    if (!index) continue;

    const severity = Number(row.Casualty_Severity);
    const severityWeight = severity === 1 ? 3 : severity === 2 ? 2 : 1;
    casualtyCounts.set(index, (casualtyCounts.get(index) ?? 0) + severityWeight);
  }

  return {
    accidentsIndexed: casualtyCounts.size,
    vehicleRows: vehicleRows.length,
    casualtyRows: casualtyRows.length,
    sampleSeverity: Array.from(casualtyCounts.values()).slice(0, 5),
    sampleVehicles: Array.from(vehicleCounts.values()).slice(0, 5),
  };
}

export async function loadHotspotDatasets() {
  const [districtCrimeResult, exactLocationResult, vehicleResult, casualtyResult, cityTrafficResult, stateTrafficResult] = await Promise.allSettled([
    loadCsv(DISTRICT_CRIME_FILE),
    loadCsv(DISTRICT_CRIME_LATLONG_FILE),
    loadCsv(VEHICLES_FILE),
    loadCsv(CASUALTIES_FILE),
    loadCsv(TRAFFIC_CITY_FILE),
    loadCsv(TRAFFIC_STATE_FILE),
  ]);

  const districtCrimeRows = districtCrimeResult.status === 'fulfilled' ? districtCrimeResult.value : [];
  const exactLocationRows = exactLocationResult.status === 'fulfilled' ? exactLocationResult.value : [];
  const vehicleRows = vehicleResult.status === 'fulfilled' ? vehicleResult.value : [];
  const casualtyRows = casualtyResult.status === 'fulfilled' ? casualtyResult.value : [];
  const cityTrafficRows = cityTrafficResult.status === 'fulfilled' ? cityTrafficResult.value : [];
  const stateTrafficRows = stateTrafficResult.status === 'fulfilled' ? stateTrafficResult.value : [];

  const exactLocation = buildExactLocationPoints(exactLocationRows);
  const crime = mapStateCrimeToHotspots(districtCrimeRows);
  const accidentMeta = computeAccidentSeverityByIndex(vehicleRows, casualtyRows);
  const casualtySummary = computeCasualtySummary(casualtyRows);
  const cityTraffic = mapCityTrafficToHotspots(cityTrafficRows);
  const stateTraffic = mapStateTrafficToHotspots(stateTrafficRows);
  const trafficStatePoints = stateTraffic.points;
  const trafficCityPoints = cityTraffic.points;
  const trafficPoints = [...trafficStatePoints, ...trafficCityPoints];
  const casualtyPoints = buildCasualtyOverlayPoints(trafficPoints, casualtySummary);

  return {
    districtCrimeRows,
    crimePoints: exactLocation.crimePoints,
    crimeStatePoints: crime.points,
    theftPoints: exactLocation.theftPoints,
    accidentPoints: exactLocation.accidentPoints,
    trafficStatePoints,
    trafficCityPoints,
    casualtyPoints,
    meta: {
      crimeRecords: exactLocation.stats.rowsWithCoordinates,
      exactCrimeRowsLoaded: exactLocationRows.length,
      exactCrimeRowsWithoutCoordinates: exactLocation.stats.rowsWithoutCoordinates,
      crimeLayerCount: exactLocation.stats.categoryCounts.crime,
      theftLayerCount: exactLocation.stats.categoryCounts.theft,
      accidentLayerCount: exactLocation.stats.categoryCounts.accident,
      districtRowsUsed: crime.districtRowsUsed,
      crimeStatesRepresented: crime.statesRepresented,
      crimePlotted: exactLocation.crimePoints.length,
      crimeUnmappedStates: crime.unmatchedStateCount,
      crimeUnmappedStateNames: crime.unmatchedStateNames,
      trafficCityRecords: cityTrafficRows.length,
      trafficStateRecords: stateTrafficRows.length,
      trafficCityPlotted: cityTraffic.points.length,
      trafficStatePlotted: stateTraffic.points.length,
      trafficCityUnmapped: cityTraffic.unmatchedCities,
      trafficCityUnmappedNames: cityTraffic.unmatchedCityNames,
      trafficStateUnmapped: stateTraffic.unmatchedStates,
      trafficStateUnmappedNames: stateTraffic.unmatchedStateNames,
      accidentsPlotted: exactLocation.accidentPoints.length,
      casualtyPlotted: casualtyPoints.length,
      casualtiesRecords: casualtySummary.totalCasualties,
      casualtiesWeightedSeverity: casualtySummary.weightedSeverity,
      accidentsNote: `Exact-location crime, theft, and accident points plotted from the lat/long CSV. Other CSVs were scanned for diagnostics only.`,
      accidentMeta,
      loadWarnings: [
        districtCrimeResult.status === 'rejected' ? `Crime CSV: ${districtCrimeResult.reason?.message ?? 'failed to load'}` : null,
        exactLocationResult.status === 'rejected' ? `Exact crime CSV: ${exactLocationResult.reason?.message ?? 'failed to load'}` : null,
        vehicleResult.status === 'rejected' ? `Vehicles CSV: ${vehicleResult.reason?.message ?? 'failed to load'}` : null,
        casualtyResult.status === 'rejected' ? `Casualties CSV: ${casualtyResult.reason?.message ?? 'failed to load'}` : null,
        cityTrafficResult.status === 'rejected' ? `Traffic city CSV: ${cityTrafficResult.reason?.message ?? 'failed to load'}` : null,
        stateTrafficResult.status === 'rejected' ? `Traffic state CSV: ${stateTrafficResult.reason?.message ?? 'failed to load'}` : null,
      ].filter(Boolean),
    },
  };
}
