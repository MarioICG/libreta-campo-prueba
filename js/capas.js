// Capas de mapa. Para añadir otra, copia una entrada y cambia la URL.
// cors: true si el servidor permite CORS (así se guardan bien para usar sin cobertura).

export const BASES = [
  {
    id: 'topo', nombre: 'Topográfico (OpenTopoMap)', cors: true,
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opts: { subdomains: 'abc', maxZoom: 17, maxNativeZoom: 17,
      attribution: '© OpenStreetMap, SRTM | estilo © OpenTopoMap (CC-BY-SA)' },
  },
  {
    id: 'osm', nombre: 'Calles (OpenStreetMap)', cors: true,
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: '© colaboradores de OpenStreetMap' },
  },
  {
    id: 'sat', nombre: 'Satélite (Esri)', cors: true,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics' },
  },
  {
    id: 'pnoa', nombre: 'Ortofoto PNOA (solo España)', cors: false,
    url: 'https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    opts: { maxZoom: 20, maxNativeZoom: 19, attribution: 'PNOA cedido por © Instituto Geográfico Nacional' },
  },
  {
    id: 'mtn', nombre: 'Mapa topográfico IGN (solo España)', cors: false,
    url: 'https://www.ign.es/wmts/mapa-raster?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=MTN&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    opts: { maxZoom: 20, maxNativeZoom: 17, attribution: '© Instituto Geográfico Nacional' },
  },
];

export const OVERLAYS = [
  {
    id: 'geologia', nombre: 'Geología (Macrostrat, escala regional)', cors: true,
    url: 'https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, maxNativeZoom: 16, opacity: 0.55, attribution: 'Geología © Macrostrat' },
  },
];
