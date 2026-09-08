import { useEffect, useRef, useState, useCallback } from 'react';
import * as Cesium from 'cesium';

export default function GlobeView({ onCoordsChange, activeQuery }) {
  const [isLoading, setIsLoading] = useState(true);
  const [locationLabel, setLocationLabel] = useState(null);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const lastTouchDist = useRef(null);
  const markerRef = useRef(null);

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

    const viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      baseLayerPicker: true,
      fullscreenButton: false,
      fullscreenElement: document.documentElement,
      vrButton: false,
      geocoder: true,
      homeButton: true,
      infoBox: true,
      sceneModePicker: true,
      selectionIndicator: true,
      timeline: false,
      navigationHelpButton: true,
      imageryProviderViewModels: baseLayers,
      selectedImageryProviderViewModel: baseLayers[0],
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

    const reverseGeocode = async (lat, lon) => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const data = await res.json();
        const a = data.address || {};
        return a.city || a.town || a.village || a.county || a.state || data.display_name || null;
      } catch {
        return null;
      }
    };

    const flyToLocation = (lon, lat, label) => {
      if (viewer.isDestroyed()) return;
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

    const geoAndFly = async () => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lon } = pos.coords;
          const label = await reverseGeocode(lat, lon);
          flyToLocation(lon, lat, label);
        },
        () => flyToLocation(78.9629, 20.5937, null)
      );
    };

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 24000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0,
      },
    });

    const resetToHomeView = () => {
      if (viewer.isDestroyed()) return;
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

    viewer.homeButton.viewModel.command.beforeExecute.addEventListener((e) => {
      e.cancel = true;
      resetToHomeView();
    });

    const removeCoordListener = viewer.scene.postRender.addEventListener(() => {
      if (!onCoordsChange) return;
      const camera = viewer.camera;
      const pos = camera.positionCartographic;
      if (pos) {
        onCoordsChange({
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
    <div ref={containerRef} className="absolute inset-0 w-full h-full">
      <div id="cesiumContainer" className="w-full h-full" />

      {isLoading && (
        <div className="globe-loader">
          <div className="globe-loader-spinner" />
          <p className="globe-loader-text">Loading Globe...</p>
        </div>
      )}

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
