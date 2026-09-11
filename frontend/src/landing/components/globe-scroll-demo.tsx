import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import ScrollGlobe, { type ScrollGlobeHandle } from "@/components/scroll-globe";

// Landing page copy aligned with the SatQuery AI satellite-analysis product.
export default function GlobeScrollDemo() {
  const navigate = useNavigate();
  const globeRef = useRef<ScrollGlobeHandle>(null);

  const goToLogin = () => {
    // Animate the earth gliding downward, then navigate to the login page.
    if (globeRef.current) {
      globeRef.current.animateExit(() => navigate("/login"));
    } else {
      navigate("/login");
    }
  };
  const goToCapabilities = () =>
    document.getElementById("capabilities")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const demoSections = [
    {
      id: "hero",
      badge: "SatQuery AI",
      title: "Ask the Earth",
      subtitle: "Anything You Want to Know",
      description:
        "Type a question about any place on the planet and get an instant, evidence-grounded answer. SatQuery AI fuses Sentinel-2 optical and Sentinel-1 SAR imagery with vision-language models — from land cover and water bodies to change detection across time.",
      align: "left" as const,
      actions: [
        { label: "Start Analysing", variant: "primary" as const, onClick: goToLogin },
        { label: "Explore Capabilities", variant: "secondary" as const, onClick: goToCapabilities },
      ],
    },
    {
      id: "satellite",
      badge: "Satellite Intelligence",
      title: "A Satellite Eye",
      subtitle: "On Every Location",
      description:
        "From a single scene to a full time series, every corner of the globe is within reach. A cloud-free optical pass and a temporally-close SAR pass are fetched for any region you select, then analysed through one unified agent pipeline.",
      align: "center" as const,
    },
    {
      id: "capabilities",
      badge: "Capabilities",
      title: "Analyse",
      subtitle: "The Planet",
      description:
        "One natural-language question unlocks powerful geospatial analysis. Every answer ships with visual evidence, a confidence score, and a downloadable execution trace you can trust.",
      align: "left" as const,
      features: [
        { title: "Single-Scene Understanding", description: "Describe imagery, classify land use, ground objects and answer visual questions with a vision-language model." },
        { title: "Temporal Change Detection", description: "Compare T1 and T2 scenes to reveal what changed and exactly where the change occurred." },
        { title: "Optical + SAR Fusion", description: "Combine optical and SAR imagery to identify built-up areas, water bodies and more in any weather." },
        { title: "Vegetation & Water Indices", description: "Track NDVI and NDWI trends over time to surface vegetation, drought and flood signals." },
      ],
    },
    {
      id: "trust",
      badge: "Trust",
      title: "Answers You Can",
      subtitle: "Verify Yourself",
      description:
        "Built on an agentic pipeline that classifies intent, selects the right detection tool and composes answers from evidence alone. Every response includes confidence estimation and a transparent execution trace, so you can verify each claim — and download the full report.",
      align: "center" as const,
      actions: [
        { label: "Enter Your Earth", variant: "accent" as const, onClick: goToLogin },
        { label: "View Documentation", variant: "secondary" as const, onClick: () => console.log("Docs clicked") },
      ],
    },
  ];

  return (
    <ScrollGlobe
      ref={globeRef}
      sections={demoSections}
      className="bg-gradient-to-br from-background via-muted/20 to-background"
    />
  );
}