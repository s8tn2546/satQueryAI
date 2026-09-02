import React, { useEffect } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

export default function GlobeView() {
  useEffect(() => {
    // Initialize Cesium Viewer with default widgets disabled for a clean UI
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

    // Fly camera directly to India to prevent coordinate/default mismatch bugs
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 25000000),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0), // Looking straight down
        roll: 0.0
      }
    });

    return () => {
      viewer.destroy();
    };
  }, []);

  return <div id="cesiumContainer" className="absolute inset-0 w-full h-full" />;
}