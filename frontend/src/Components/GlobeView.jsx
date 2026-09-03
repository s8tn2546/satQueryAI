import React, { useEffect, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

export default function GlobeView() {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Using Cesium's reliable default imagery layer
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

    // Performance optimizations
    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = Infinity;

    // Ultra-smooth desktop navigation controller settings
    const controller = viewer.scene.screenSpaceCameraController;
    controller.inertiaZoom = 0.90;
    controller.inertiaTranslate = 0.90;
    controller.inertiaSpin = 0.90;
    controller.zoomFactor = 2.5;

    viewer.resolutionScale = window.devicePixelRatio;
    viewer.scene.globe.maximumScreenSpaceError = 1.2;

    // Fly camera directly to India
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 15000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0
      },
      duration: 1.5
    });

    const removeListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queueLength) => {
      if (queueLength === 0) {
        setIsLoading(false);
      }
    });

    const timer = setTimeout(() => setIsLoading(false), 1500);

    return () => {
      clearTimeout(timer);
      if (removeListener) removeListener();
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
    };
  }, []);

  return (
    <div className="absolute inset-0 w-full h-full">
      <div id="cesiumContainer" className="w-full h-full" />

      {isLoading && (
        <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center z-20 transition-opacity duration-300">
          <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin mb-2 shadow-lg shadow-emerald-500/20"></div>
          <p className="text-slate-300 text-xs font-medium tracking-wide">Loading Globe...</p>
        </div>
      )}
    </div>
  );
}