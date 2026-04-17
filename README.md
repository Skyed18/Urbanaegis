# Urban Safety Hotspots Map

A minimal Vite web app with OpenStreetMap (free) via Leaflet and a heatmap layer for crime/accident hotspot visualization.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm run dev
   ```

## Current status

- Map is initialized with OpenStreetMap tiles via Leaflet.
- Heatmap layer is enabled.
- CSV ingestion is enabled from:
   - `public/data/districtwise-ipc-crimes-2017-onwards.csv`
   - `public/data/traffic_city_2022_2023.csv`
   - `public/data/traffic_state_2019_2023.csv`
   - `public/data/crime_dataset_india.csv`
   - `public/data/VehiclesBig.csv`
   - `public/data/CasualtiesBig.csv`
- Runtime helper is available in the browser console:
  - `window.urbanMap.setHotspots(crimePoints, accidentPoints)`
   - `window.urbanMap.reloadFromCsv()`

## Dataset mapping

- `districtwise-ipc-crimes-2017-onwards.csv` is the primary crime source.
- One hotspot is generated per district using the latest available year for that district.
- Districts are positioned by state center + deterministic district jitter so they appear distributed within India.
- Heat intensity (`weight`) is derived from summed IPC category counts in each district row.
- `traffic_city_2022_2023.csv` and `traffic_state_2019_2023.csv` are merged into traffic hotspot points and plotted as accident/traffic intensity.
- City traffic points use 2023 accidents, killed, and injured values with city-coordinate mapping.
- State traffic points use 2023 accidents and change values with state-coordinate mapping.
- `VehiclesBig.csv` and `CasualtiesBig.csv` are still parsed for severity/index metadata only (no lat/lng in source).

## Data format

Provide data points in this shape:

```js
{ lat: 40.7128, lng: -74.0060, weight: 1 }
```

- `weight` is optional and defaults to `1`.

When you send your dataset, we can wire loading/parsing and category styling next.
