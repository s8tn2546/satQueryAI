import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { calculateGeographicAreaKm2, formatGeographicArea } from '../lib/utils';

const HomeIcon = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 9.5 12 3l9 6.5" />
    <path d="M5 10v10h14V10" />
    <path d="M9 20v-6h6v6" />
  </svg>
);

const SceneIcon = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 2 2 7v10l10 5 10-5V7z" />
    <path d="M2 7l10 5 10-5" />
    <path d="M12 12v10" />
  </svg>
);

const LayersIcon = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const SearchIcon = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const HelpIcon = ({ size = 16, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const XIcon = ({ size = 14, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const CheckIcon = ({ size = 12, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function GlobeView({ onCoordsChange, onRegionSelect, roiAttachment, onClearRoi }) {
  const [isLoading, setIsLoading] = useState(true);
  const [locationLabel, setLocationLabel] = useState(null);
  const [isDrawMode, setIsDrawMode] = useState(false);
  const [selectedBbox, setSelectedBbox] = useState(null);
  const [openPanel, setOpenPanel] = useState(null);
  const [activeBasemap, setActiveBasemap] = useState('Google Satellite (Hybrid)');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMsg, setSearchMsg] = useState(null);
  const [baseLayersList, setBaseLayersList] = useState([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const lastTouchDist = useRef(null);
  const roiEntityRef = useRef(null);
  const drawHandlerRef = useRef(null);
  const activeBboxRef = useRef(null);

  const onCoordsChangeRef = useRef(onCoordsChange);
  useEffect(() => {
    onCoordsChangeRef.current = onCoordsChange;
  }, [onCoordsChange]);

  // Helper to get ground Cartographic coordinate from mouse click/move
  const getGroundPosition = (position) => {
    const viewer = viewerRef.current;
    if (!viewer || !position) return null;
    const ray = viewer.camera.getPickRay(position);
    if (!ray) return null;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  };

  // Helper to draw or update ROI rectangle entity in Cesium
  const updateRoiEntity = (bbox) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    if (roiEntityRef.current) {
      viewer.entities.remove(roiEntityRef.current);
      roiEntityRef.current = null;
    }

    if (!bbox) return;

    const areaKm2 = calculateGeographicAreaKm2(bbox);
    const areaStr = formatGeographicArea(areaKm2);
    const labelText = areaStr ? `AOI\n${areaStr}` : 'AOI Selected';

    const centerLon = (bbox.west + bbox.east) / 2;
    const centerLat = (bbox.south + bbox.north) / 2;

    roiEntityRef.current = viewer.entities.add({
      name: 'Selected Region (AOI)',
      position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0),
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(bbox.west, bbox.south, bbox.east, bbox.north),
        material: Cesium.Color.fromCssColorString('#06B6D4').withAlpha(0.25),
        height: 0,
      },
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([
          bbox.west, bbox.south,
          bbox.east, bbox.south,
          bbox.east, bbox.north,
          bbox.west, bbox.north,
          bbox.west, bbox.south,
        ]),
        width: 3,
        material: Cesium.Color.fromCssColorString('#22D3EE'),
        clampToGround: true,
      },
      label: {
        text: labelText,
        font: 'bold 12px monospace, sans-serif',
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: Cesium.Color.fromCssColorString('#ECFEFF'),
        outlineColor: Cesium.Color.fromCssColorString('#083344'),
        outlineWidth: 4,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#083344').withAlpha(0.85),
        backgroundPadding: new Cesium.Cartesian2(8, 5),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    viewer.scene.requestRender();
  };

  // Synchronize internal selectedBbox / Cesium entity with external roiAttachment prop
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!roiAttachment) {
      activeBboxRef.current = null;
      if (roiEntityRef.current && viewer && !viewer.isDestroyed()) {
        viewer.entities.remove(roiEntityRef.current);
        roiEntityRef.current = null;
        viewer.scene.requestRender();
      }
      queueMicrotask(() => setSelectedBbox(null));
    } else if (roiAttachment.bbox) {
      const b = roiAttachment.bbox;
      activeBboxRef.current = b;
      updateRoiEntity(b);
      queueMicrotask(() => setSelectedBbox(b));
    }
  }, [roiAttachment]);

  // Toggle Draw ROI Mode
  const toggleDrawMode = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    if (isDrawMode) {
      // Deactivate draw mode
      if (drawHandlerRef.current) {
        drawHandlerRef.current.destroy();
        drawHandlerRef.current = null;
      }
      viewer.scene.screenSpaceCameraController.enableInputs = true;
      setIsDrawMode(false);
    } else {
      // Activate draw mode
      setIsDrawMode(true);
      setSelectedBbox(null);
      activeBboxRef.current = null;
      if (roiEntityRef.current) {
        viewer.entities.remove(roiEntityRef.current);
        roiEntityRef.current = null;
        viewer.scene.requestRender();
      }

      let isDrawing = false;
      let firstPoint = null;

      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      drawHandlerRef.current = handler;

      handler.setInputAction((movement) => {
        const point = getGroundPosition(movement.position);
        if (point) {
          firstPoint = point;
          isDrawing = true;
          viewer.scene.screenSpaceCameraController.enableInputs = false;
        }
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

      handler.setInputAction((movement) => {
        if (!isDrawing || !firstPoint) return;
        const currentPoint = getGroundPosition(movement.endPosition);
        if (currentPoint) {
          const bbox = {
            west: Math.min(firstPoint.lon, currentPoint.lon),
            south: Math.min(firstPoint.lat, currentPoint.lat),
            east: Math.max(firstPoint.lon, currentPoint.lon),
            north: Math.max(firstPoint.lat, currentPoint.lat),
          };
          activeBboxRef.current = bbox;
          setSelectedBbox(bbox);
          updateRoiEntity(bbox);
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      handler.setInputAction(() => {
        if (isDrawing) {
          isDrawing = false;
          viewer.scene.screenSpaceCameraController.enableInputs = true;
          if (drawHandlerRef.current) {
            drawHandlerRef.current.destroy();
            drawHandlerRef.current = null;
          }
          setIsDrawMode(false);
          if (activeBboxRef.current && onRegionSelect) {
            onRegionSelect(activeBboxRef.current);
          }
        }
      }, Cesium.ScreenSpaceEventType.LEFT_UP);
    }
  };

  // Capture current viewport extent as ROI
  const captureViewportRoi = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const rect = viewer.camera.computeViewRectangle();
    if (rect) {
      const bbox = {
        west: Cesium.Math.toDegrees(rect.west),
        south: Cesium.Math.toDegrees(rect.south),
        east: Cesium.Math.toDegrees(rect.east),
        north: Cesium.Math.toDegrees(rect.north),
      };
      setSelectedBbox(bbox);
      activeBboxRef.current = bbox;
      updateRoiEntity(bbox);
      if (onRegionSelect) {
        onRegionSelect(bbox);
      }
    }
  };

  const instantiateLayer = (viewModel) =>
    typeof viewModel.creationCommand === 'function'
      ? viewModel.creationCommand()
      : viewModel.creationFunction();

  const handleConfirmRoi = () => {
    if (selectedBbox && onRegionSelect) {
      onRegionSelect(selectedBbox);
    }
  };

  const handleClearRoi = () => {
    const viewer = viewerRef.current;
    setSelectedBbox(null);
    activeBboxRef.current = null;
    if (roiEntityRef.current && viewer && !viewer.isDestroyed()) {
      viewer.entities.remove(roiEntityRef.current);
      roiEntityRef.current = null;
      viewer.scene.requestRender();
    }
    if (onClearRoi) {
      onClearRoi();
    }
  };

  // Fullscreen toggle for the globe wrapper. The wrapper (not just the canvas)
  // is put in fullscreen so the top-right ROI toolbar stays reachable while the
  // map fills the screen. Reuses the existing fullscreenchange resize handler.
  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve());
      } else if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request could not be completed:', err);
    }
  };

  useEffect(() => {
    const syncFullscreen = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || document.webkitFullscreenElement));
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.resize();
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncFullscreen);
    };
  }, []);

  const homeView = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    setLocationLabel(null);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 24000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0,
      },
      duration: 1.4,
    });
  };

  const cycleSceneMode = () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const { scene } = viewer;
    if (scene.mode === Cesium.SceneMode.SCENE3D) {
      scene.morphTo2D(1.2);
    } else if (scene.mode === Cesium.SceneMode.SCENE2D) {
      scene.morphToColumbusView(1.2);
    } else {
      scene.morphTo3D(1.2);
    }
    scene.requestRender();
  };

  const applyBasemap = (viewModel) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const layers = viewer.imageryLayers;
    layers.removeAll();
    layers.addImageryProvider(instantiateLayer(viewModel));
    viewer.scene.requestRender();
    setActiveBasemap(viewModel.name);
    setOpenPanel(null);
  };

  const flyToLocationView = (lon, lat, label) => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    if (label) setLocationLabel(label);

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 28000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0,
      },
      duration: 1.2,
      complete: () => {
        if (viewer.isDestroyed()) return;
        const camera = viewer.camera;
        const shift = Cesium.Cartesian3.multiplyByScalar(camera.up, -6.0e5, new Cesium.Cartesian3());
        camera.position = Cesium.Cartesian3.add(camera.position, shift, new Cesium.Cartesian3());

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 180000),
          orientation: {
            heading: Cesium.Math.toRadians(0.0),
            pitch: Cesium.Math.toRadians(-55.0),
            roll: 0.0,
          },
          duration: 2.2,
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          complete: () => {
            if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
            setTimeout(() => setLocationLabel(null), 3000);
          },
        });
      },
    });
  };

  const handleLocationSearch = async (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setSearchMsg(null);

    const numeric = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (numeric) {
      flyToLocationView(parseFloat(numeric[2]), parseFloat(numeric[1]), null);
      setOpenPanel(null);
      return;
    }

    setSearchLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const data = await res.json();
      if (data && data[0]) {
        flyToLocationView(parseFloat(data[0].lon), parseFloat(data[0].lat), null);
        setOpenPanel(null);
      } else {
        setSearchMsg('Location not found.');
      }
    } catch {
      setSearchMsg('Search failed.');
    } finally {
      setSearchLoading(false);
    }
  };

  useEffect(() => {
    const baseLayers = [
      new Cesium.ProviderViewModel({
        name: 'Google Satellite (Hybrid)',
        tooltip: 'Latest Google Maps satellite imagery with roads and labels',
        iconUrl: 'https://mt1.google.com/vt/lyrs=y&x=2&y=1&z=2',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
            credit: 'Google Maps',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Google Satellite (Clean)',
        tooltip: 'Latest Google Maps high-resolution imagery without labels',
        iconUrl: 'https://mt1.google.com/vt/lyrs=s&x=2&y=1&z=2',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
            credit: 'Google Maps',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Bing Maps Aerial',
        tooltip: 'Latest Microsoft Bing Maps high-resolution aerial imagery',
        iconUrl: 'https://t0.tiles.virtualearth.net/tiles/a03.jpeg?g=1',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1',
            subdomains: ['0', '1', '2', '3'],
            credit: 'Microsoft Bing Maps',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Bing Maps Hybrid',
        tooltip: 'Latest Microsoft Bing Maps aerial imagery with roads and labels',
        iconUrl: 'https://t1.tiles.virtualearth.net/tiles/h03.jpeg?g=1',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/h{quadkey}.jpeg?g=1',
            subdomains: ['0', '1', '2', '3'],
            credit: 'Microsoft Bing Maps',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Esri World Imagery',
        tooltip: 'Latest Esri high-resolution global satellite imagery',
        iconUrl:
          'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/2/1/1',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            credit: 'Esri, Maxar, Earthstar Geographics',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Sentinel-2 Cloudless',
        tooltip: 'Latest Sentinel-2 cloud-free global satellite mosaic',
        iconUrl:
          'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/2/1/1.jpg',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
            credit: 'Sentinel-2 Cloudless - EOX IT Services GmbH',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'Google Terrain',
        tooltip: 'Latest Google Maps physical terrain and elevation contours',
        iconUrl: 'https://mt1.google.com/vt/lyrs=p&x=2&y=1&z=2',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
            credit: 'Google Maps',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'CartoDB Dark Matter',
        tooltip: 'Subtle dark canvas basemap for mission control',
        iconUrl: 'https://a.basemaps.cartocdn.com/dark_all/2/1/1.png',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            credit: '© CARTO, © OpenStreetMap',
          }),
      }),
      new Cesium.ProviderViewModel({
        name: 'OpenStreetMap Standard',
        tooltip: 'OpenStreetMap standard global vector tiles',
        iconUrl: 'https://tile.openstreetmap.org/2/1/1.png',
        creationFunction: () =>
          new Cesium.UrlTemplateImageryProvider({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            credit: '© OpenStreetMap contributors',
          }),
      }),
    ];

    setTimeout(() => {
      setBaseLayersList(baseLayers);
    }, 0);

    const viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      fullscreenElement: document.documentElement,
      vrButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: true,
      sceneModePicker: false,
      selectionIndicator: true,
      timeline: false,
      navigationHelpButton: false,
      baseLayer: new Cesium.ImageryLayer(instantiateLayer(baseLayers[0])),
    });
    viewerRef.current = viewer;

    const handleResize = () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.resize();
      }
    };
    window.addEventListener('resize', handleResize);
    document.addEventListener('fullscreenchange', handleResize);
    document.addEventListener('webkitfullscreenchange', handleResize);
    document.addEventListener('mozfullscreenchange', handleResize);

    const creditContainers = document.querySelectorAll('.cesium-viewer-credits, .cesium-widget-credits, .cesium-credit-expander');
    creditContainers.forEach((el) => {
      el.style.display = 'none';
    });
    const ionCredit = viewer.cesiumWidget && viewer.cesiumWidget.creditContainer;
    if (ionCredit) ionCredit.style.display = 'none';

    viewer.scene.skyBox.show = true;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.globe.show = true;

    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0A0E16');

    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = Infinity;

    const controller = viewer.scene.screenSpaceCameraController;
    controller.inertiaZoom = 0.90;
    controller.inertiaTranslate = 0.90;
    controller.inertiaSpin = 0.90;
    controller.zoomFactor = 2.5;
    controller.enableMouseWheelZoom = true;
    controller.enableTranslate = true;
    controller.enableLook = true;
    controller.enableRotate = true;
    controller.enableTilt = true;
    controller.enableZoom = true;
    controller.minimumZoomDistance = 1000.0;
    controller.maximumZoomDistance = 25000000.0;

    viewer.resolutionScale = window.devicePixelRatio;
    viewer.scene.globe.maximumScreenSpaceError = 1.2;

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 24000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0,
      },
    });

    const removeCoordListener = viewer.scene.postRender.addEventListener(() => {
      if (!onCoordsChangeRef.current) return;
      const camera = viewer.camera;
      const pos = camera.positionCartographic;
      if (pos) {
        onCoordsChangeRef.current({
          lat: Cesium.Math.toDegrees(pos.latitude),
          lon: Cesium.Math.toDegrees(pos.longitude),
        });
      }
    });

    const removeListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queueLength) => {
      if (queueLength === 0) setIsLoading(false);
    });

    const timer = setTimeout(() => setIsLoading(false), 1500);

    return () => {
      clearTimeout(timer);
      removeCoordListener();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('fullscreenchange', handleResize);
      document.removeEventListener('webkitfullscreenchange', handleResize);
      document.removeEventListener('mozfullscreenchange', handleResize);
      if (removeListener) removeListener();
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const getTouchDist = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        lastTouchDist.current = getTouchDist(e.touches);
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length === 2 && lastTouchDist.current !== null && viewerRef.current && !viewerRef.current.isDestroyed()) {
        e.preventDefault();
        const newDist = getTouchDist(e.touches);
        const delta = lastTouchDist.current - newDist;
        const zoomFactor = delta * 50000;

        const camera = viewerRef.current.camera;
        const direction = camera.direction;
        const pos = camera.position;
        camera.position = new Cesium.Cartesian3(
          pos.x + direction.x * zoomFactor,
          pos.y + direction.y * zoomFactor,
          pos.z + direction.z * zoomFactor
        );
        viewerRef.current.scene.requestRender();
        lastTouchDist.current = newDist;
      }
    };

    const onTouchEnd = () => {
      lastTouchDist.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    <div ref={containerRef} className="satquery-globe absolute inset-0 w-full h-full">
      <div id="cesiumContainer" className="w-full h-full" />

      {/* Globe Region ROI Selection Toolbar */}
      <div className="globe-roi-toolbar">
        <button
          type="button"
          className={`roi-tool-btn ${isDrawMode ? 'active' : ''}`}
          onClick={toggleDrawMode}
          title={isDrawMode ? 'Click & Drag on globe to draw ROI boundary' : 'Draw Region Bounding Box'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
          <span>{isDrawMode ? 'Drawing ROI...' : 'Draw ROI'}</span>
        </button>

        <button
          type="button"
          className={`roi-tool-btn ${isFullscreen ? 'active' : ''}`}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {isFullscreen ? (
              <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />
            ) : (
              <path d="M3 3h6M3 3v6M21 3h-6M21 3v6M3 21h6M3 21v-6M21 21h-6M21 21v-6" />
            )}
          </svg>
          <span>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
        </button>

        <button
          type="button"
          className="roi-tool-btn"
          onClick={captureViewportRoi}
          title="Set active globe camera extent as ROI"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 15v6h-6M3 9V3h6" />
          </svg>
          <span>Capture View</span>
        </button>

        {selectedBbox && (
          <div className="roi-bbox-badge">
            <div className="flex flex-col text-[11px] font-mono leading-tight pr-1">
              <span className="text-cyan-300 font-bold flex items-center gap-1.5">
                <span>AOI Active</span>
                {calculateGeographicAreaKm2(selectedBbox) ? (
                  <span className="text-cyan-100 text-[10px] bg-cyan-900/60 px-1.5 py-0.5 rounded border border-cyan-700 font-normal">
                    {formatGeographicArea(calculateGeographicAreaKm2(selectedBbox))}
                  </span>
                ) : (
                  <span className="text-slate-400 text-[10px]">Selected</span>
                )}
              </span>
              <span className="text-slate-300 text-[10px] tracking-tight">
                W: {selectedBbox.west.toFixed(3)}° • S: {selectedBbox.south.toFixed(3)}° • E: {selectedBbox.east.toFixed(3)}° • N: {selectedBbox.north.toFixed(3)}°
              </span>
            </div>
            <button type="button" className="confirm-roi-btn" onClick={handleConfirmRoi} title="Fetch Satellite Imagery for Region">
              Fetch Region
            </button>
            <button type="button" className="clear-roi-btn" onClick={handleClearRoi} title="Clear Region">
              ✕
            </button>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="globe-loader">
          <div className="globe-loader-spinner" />
          <p className="globe-loader-text">Loading Globe...</p>
        </div>
      )}

      {/* Standalone Cesium Tool Access — Home / 3D-2D / Basemaps / Search / Help */}
      <div className="globe-tools-vertical">
        <button
          type="button"
          className={`globe-tool-item ${openPanel === 'search' ? 'pressed' : ''}`}
          onClick={() => setOpenPanel(openPanel === 'search' ? null : 'search')}
          title="Search a location"
          aria-label="Search location"
        >
          <SearchIcon />
        </button>

        <button
          type="button"
          className="globe-tool-item"
          onClick={homeView}
          title="Home / Reset View"
          aria-label="Reset view to home"
        >
          <HomeIcon />
        </button>

        <button
          type="button"
          className="globe-tool-item"
          onClick={cycleSceneMode}
          title="3D / 2D / Colombia View Mode"
          aria-label="Cycle scene mode"
        >
          <SceneIcon />
        </button>

        <button
          type="button"
          className={`globe-tool-item ${openPanel === 'basemap' ? 'pressed' : ''}`}
          onClick={() => setOpenPanel(openPanel === 'basemap' ? null : 'basemap')}
          title="Choose Basemap"
          aria-label="Choose basemap"
        >
          <LayersIcon />
        </button>

        <button
          type="button"
          className={`globe-tool-item ${openPanel === 'help' ? 'pressed' : ''}`}
          onClick={() => setOpenPanel(openPanel === 'help' ? null : 'help')}
          title="Navigation Help"
          aria-label="Navigation help"
        >
          <HelpIcon />
        </button>

        {openPanel === 'basemap' && (
          <div className="globe-tool-popup basemap-popup">
            <div className="globe-tool-popup-header">
              <span>BASEMAP LAYERS</span>
              <button type="button" className="globe-tool-popup-close" onClick={() => setOpenPanel(null)} aria-label="Close">
                <XIcon />
              </button>
            </div>
            <div className="basemap-popup-list">
              {baseLayersList.map((vm) => (
                <button
                  key={vm.name}
                  type="button"
                  className={`basemap-popup-item ${activeBasemap === vm.name ? 'active' : ''}`}
                  onClick={() => applyBasemap(vm)}
                >
                  <span className="basemap-popup-name">{vm.name}</span>
                  {activeBasemap === vm.name && <CheckIcon />}
                </button>
              ))}
            </div>
          </div>
        )}

        {openPanel === 'search' && (
          <div className="globe-tool-popup search-popup">
            <div className="globe-tool-popup-header">
              <span>SEARCH LOCATION</span>
              <button type="button" className="globe-tool-popup-close" onClick={() => setOpenPanel(null)} aria-label="Close">
                <XIcon />
              </button>
            </div>
            <form className="search-popup-form" onSubmit={handleLocationSearch}>
              <input
                autoFocus
                className="search-popup-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Place name or Lat, Lon"
              />
              <button type="submit" className="search-popup-go" title="Go">
                {searchLoading ? '…' : <SearchIcon size={14} />}
              </button>
            </form>
            {searchMsg && <div className="search-popup-msg">{searchMsg}</div>}
          </div>
        )}

        {openPanel === 'help' && (
          <div className="globe-tool-popup help-popup">
            <div className="globe-tool-popup-header">
              <span>NAVIGATION HELP</span>
              <button type="button" className="globe-tool-popup-close" onClick={() => setOpenPanel(null)} aria-label="Close">
                <XIcon />
              </button>
            </div>
            <ul className="help-popup-list">
              <li><span className="help-key">Left Drag</span> Orbit / Rotate globe</li>
              <li><span className="help-key">Right Drag</span> Pan the globe</li>
              <li><span className="help-key">Scroll Wheel</span> Zoom in / out</li>
              <li><span className="help-key">Double Click</span> Zoom to region</li>
            </ul>
          </div>
        )}
      </div>

      {locationLabel && (
        <div className="globe-location-toast">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          {locationLabel}
        </div>
      )}
    </div>
  );
}
