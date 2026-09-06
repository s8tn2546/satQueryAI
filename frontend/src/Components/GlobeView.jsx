import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';

export default function GlobeView() {
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const lastTouchDist = useRef(null);

  useEffect(() => {
    const viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
    });
    viewerRef.current = viewer;

    const creditContainers = document.querySelectorAll('.cesium-viewer-credits, .cesium-widget-credits, .cesium-credit-expander');
    creditContainers.forEach((el) => {
      el.style.display = 'none';
    });
    const ionCredit = viewer.cesiumWidget && viewer.cesiumWidget.creditContainer;
    if (ionCredit) ionCredit.style.display = 'none';

    viewer.scene.skyBox.show = true;
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.globe.show = true;

    const applySceneTheme = () => {
      const isLight = document.documentElement.classList.contains('light');
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(isLight ? '#cbd5e1' : '#020617');
      if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
    };
    applySceneTheme();
    const themeObserver = new MutationObserver(applySceneTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

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

    viewer.resolutionScale = window.devicePixelRatio;
    viewer.scene.globe.maximumScreenSpaceError = 1.2;

    const raiseEarth = () => {
      if (viewer.isDestroyed()) return;
      const camera = viewer.camera;
      const shift = Cesium.Cartesian3.multiplyByScalar(camera.up, -6.0e5, new Cesium.Cartesian3());
      camera.position = Cesium.Cartesian3.add(camera.position, shift, new Cesium.Cartesian3());
      if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
    };

    const flight = viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 28000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0
      },
      duration: 1.5
    });
    if (flight && typeof flight.then === 'function') {
      flight.then(raiseEarth);
    } else {
      setTimeout(raiseEarth, 1600);
    }

    const removeListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queueLength) => {
      if (queueLength === 0) {
        setIsLoading(false);
      }
    });

    const timer = setTimeout(() => setIsLoading(false), 1500);

    return () => {
      themeObserver.disconnect();
      clearTimeout(timer);
      if (removeListener) removeListener();
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
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
      <div className="starfield" aria-hidden="true" />

      {isLoading && (
        <div className="globe-loader">
          <div className="globe-loader-spinner" />
          <p className="globe-loader-text">Loading Globe...</p>
        </div>
      )}
    </div>
  );
}
