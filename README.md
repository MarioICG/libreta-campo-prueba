# Libreta de campo

App web instalable (PWA) para trabajo de campo: anotas puntos con campos configurables, sacas fotos que quedan georreferenciadas con el rumbo de la cámara, las ves en un mapa y exportas todo a SIG. Funciona sin cobertura y sin cuentas: los datos se guardan solo en el teléfono.

## Qué hace

- **Puntos (estaciones)** con código automático (E-001, E-002…), coordenadas promediadas del GPS, UTM, altitud sobre el nivel del mar (geoide EGM96) y nombre del lugar cuando hay conexión.
- **Campos configurables por proyecto**: texto, texto largo, número, lista de opciones, sí/no y plano (dirección de buzamiento / buzamiento). Viene una plantilla de geología que puedes cambiar.
- **Medir planos con el teléfono**: apoyas la parte trasera sobre la superficie y lee dirección de buzamiento y buzamiento (con declinación corregida).
- **Cámara dentro de la app** con cinta de rumbo en vivo: cada foto guarda posición, hora, precisión y hacia dónde miraba la cámara. También puedes usar la cámara del sistema (más calidad, rumbo aproximado) o añadir fotos de la galería (usa el GPS del EXIF si lo trae).
- **Marca de agua** al exportar: fecha, hora, lugar, código del punto, coordenadas, UTM, altitud, azimut y una rosa con la aguja del norte girada según la dirección de la foto. La foto original nunca se modifica. Se configura en Proyecto → Marca de agua:
  - texto propio por proyecto (obra, cliente; hasta dos líneas) y logo de la empresa (PNG con transparencia);
  - 7 posiciones (esquinas, bordes superior e inferior y centro), fondo en banda, recuadro o sin fondo, y opacidad del fondo;
  - 6 formatos de fecha, hora de 24 h (con o sin segundos) o 12 h, y zona horaria opcional;
  - qué datos aparecen, tamaño, coordenadas decimales o en grados, minutos y segundos, y norte geográfico o magnético.
- **Mapa** con OpenTopoMap, OpenStreetMap, satélite Esri, ortofoto PNOA y MTN del IGN, y geología regional de Macrostrat. Las fotos aparecen como miniaturas con un cono que indica su dirección.
- **Exportar para SIG (ZIP)**: `puntos.geojson`, `fotos.geojson` (con `azimut`), fotos con marca y GPS en el EXIF, originales opcionales, `datos.json` y un `LEEME.txt` con los pasos para QGIS.
- **Copia de seguridad e importación** para pasar la libreta a otro teléfono.

## Ponerla en tu móvil (GitHub Pages, gratis)

La cámara, el GPS y el modo sin conexión exigen que la app se sirva por HTTPS. La forma más simple:

1. Entra en github.com con tu cuenta y crea un repositorio público llamado `libreta-campo`.
2. En el repositorio, «Add file» → «Upload files» y arrastra **el contenido** de esta carpeta (no la carpeta en sí). Confirma con «Commit changes».
3. Ve a «Settings» → «Pages». En «Source» elige «Deploy from a branch», rama `main`, carpeta `/ (root)` y guarda.
4. Al cabo de uno o dos minutos la app estará en `https://TU-USUARIO.github.io/libreta-campo/`.
5. Ábrela en el móvil:
   - Android (Chrome): menú ⋮ → «Instalar aplicación».
   - iPhone (Safari): botón Compartir → «Añadir a pantalla de inicio».
6. Acepta los permisos de ubicación y cámara la primera vez.

El código queda público, pero tus puntos y fotos no: viven solo en el teléfono.

También sirve cualquier servidor con HTTPS (por ejemplo tu Raspberry Pi detrás de un proxy con certificado). Para probar en el ordenador basta con `python3 -m http.server` dentro de la carpeta y abrir `http://localhost:8000` (localhost cuenta como seguro).

### Actualizar la app

Sube los archivos nuevos y cambia el número de `VERSION` al principio de `sw.js`. La próxima vez que abras la app con conexión aparecerá «Hay una versión nueva → Actualizar».

## Antes de ir al campo

- **Instálala** (paso 5). En iPhone es imprescindible: Safari borra los datos de las webs no instaladas tras unos días sin uso.
- En Proyecto → «Proteger datos» para que el navegador no limpie el almacenamiento.
- **Mapas sin conexión**: la app guarda las teselas que ya viste. Antes de salir, recorre la zona con conexión a los zooms que vayas a usar.
- **Copia de seguridad** al volver de cada salida. Si borras los datos del navegador o desinstalas la app, la libreta se pierde.

## Precisión y limitaciones

- **Brújula**: depende del magnetómetro del teléfono. Calíbrala moviendo el teléfono en forma de 8 y aléjalo del martillo, la brújula, el coche y las vallas metálicas. Para medidas estructurales serias, contrasta con tu brújula de geólogo.
- **Norte**: Android entrega el norte magnético; la app aplica la declinación del modelo WMM2025 para dar el geográfico. En iPhone se usa el rumbo de Safari (también tratado como magnético).
- **Fotos desde la cámara de la app**: salen del vídeo de la cámara, así que tienen algo menos de resolución y procesado que las de la app de cámara nativa. Si necesitas máxima calidad, usa el botón de cámara del sistema (el rumbo queda como aproximado).
- **Altitud**: el GPS del móvil tiene errores verticales de 10–30 m. Android da altura elipsoidal y la app la corrige con EGM96; iPhone ya la da sobre el nivel del mar.
- **Fotos con el teléfono en horizontal**: la app las endereza aunque tengas la rotación automática apagada. Si alguna sale girada, corrígela con los botones de giro del visor.
- **Nombre del lugar**: se consulta a OpenStreetMap (Nominatim) solo con conexión; puedes desactivarlo o escribirlo a mano.
- **Exportaciones grandes**: el ZIP se arma en la memoria del teléfono. Con cientos de fotos, exporta por rangos de fechas.

## En QGIS

1. Descomprime el ZIP y arrastra `puntos.geojson` y `fotos.geojson` al mapa (WGS84, EPSG:4326).
2. Los estilos `puntos.qml` y `fotos.qml` que van en el ZIP se aplican solos: puntos con su código, fotos como flechas giradas según el `azimut`, y el formulario de cada foto muestra la imagen.
3. Activa Ver → Mostrar avisos del mapa y pasa el ratón sobre un punto o una flecha para ver la foto.

## Estructura

```
index.html            interfaz
css/app.css           estilos
js/app.js             lógica de pantallas
js/sensors.js         GPS, brújula, inclinación y medida de planos
js/camera.js          cámara y enderezado de fotos
js/watermark.js       marca de agua y rosa del norte
js/export.js          ZIP, GeoJSON, EXIF e importación
js/map.js, capas.js   mapa y capas (añade aquí tus WMS/WMTS)
js/geo.js             UTM, formatos, declinación, geoide
js/place.js           nombre del lugar (Nominatim)
js/db.js              almacenamiento local (IndexedDB)
sw.js                 funcionamiento sin conexión
vendor/               Leaflet, JSZip, piexifjs, WMM2025, geoide EGM96
```

## Siguiente paso: app de tienda

Cuando la quieras en Google Play o la App Store, el mismo código se puede empaquetar con Capacitor. Eso daría acceso a la cámara nativa a plena resolución, GPS en segundo plano y guardado directo en la galería, sin reescribir la app.

## Créditos

Leaflet (BSD-2), JSZip (MIT), piexifjs (MIT), geomagnetism / NOAA WMM2025 (Apache-2.0 / dominio público), egm96-universal / NGA EGM96 (MIT), tipografía Barlow (OFL). Mapas © colaboradores de OpenStreetMap, OpenTopoMap, Esri, Instituto Geográfico Nacional y Macrostrat.
