/**
 * Candidate Semantic Change Interpretation Engine
 * 
 * Extends deterministic change detection outputs with carefully labeled
 * candidate interpretations based strictly on computed indicators (NDVI, NDWI, SAR).
 * 
 * Rules:
 * 1. Interpretations are explicitly candidates (never ground-truth labels).
 * 2. All candidates require concrete supporting evidence.
 * 3. Includes standard caveat: ground truth verification required.
 */

export function interpretCandidateSemanticChange({ changeResult = {}, supportingSignals = {} } = {}) {
  const changePct = typeof changeResult.change_percentage === 'number'
    ? changeResult.change_percentage
    : (typeof changeResult.changePercentage === 'number' ? changeResult.changePercentage : 0);

  const changedAreaKm2 = typeof changeResult.changed_area_km2 === 'number'
    ? changeResult.changed_area_km2
    : null;

  const { ndviT1, ndviT2, ndwiT1, ndwiT2, sarRatio } = supportingSignals;

  const hasNdvi = typeof ndviT1 === 'number' && typeof ndviT2 === 'number';
  const ndviDelta = hasNdvi ? ndviT2 - ndviT1 : null;

  const hasNdwi = typeof ndwiT1 === 'number' && typeof ndwiT2 === 'number';
  const ndwiDelta = hasNdwi ? ndwiT2 - ndwiT1 : null;

  // Trivial change check (< 1% or negligible mean difference)
  if (changePct < 1.0 && (!changedAreaKm2 || changedAreaKm2 < 0.05)) {
    return {
      candidateTitle: 'No Meaningful Candidate Change',
      category: 'no_change',
      confidenceLabel: 'Low',
      evidence: [
        `Computed change percentage is ${changePct.toFixed(2)}% (below 1.0% threshold).`,
        changedAreaKm2 !== null ? `Changed area: ${changedAreaKm2.toFixed(3)} km².` : null
      ].filter(Boolean),
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 1. Vegetation Decline (NDVI drop >= 0.15 with change mask overlap)
  if (hasNdvi && ndviT1 >= 0.35 && ndviDelta <= -0.15) {
    return {
      candidateTitle: 'Candidate Vegetation Decline',
      category: 'vegetation_decline',
      confidenceLabel: 'Moderate',
      evidence: [
        `NDVI T1 = ${ndviT1.toFixed(2)}`,
        `NDVI T2 = ${ndviT2.toFixed(2)} (Delta: ${ndviDelta.toFixed(2)})`,
        `Change mask overlap = ${changePct.toFixed(1)}%${changedAreaKm2 !== null ? ` (${changedAreaKm2.toFixed(2)} km²)` : ''}`
      ],
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 2. Vegetation Increase (NDVI gain >= 0.15 with change mask overlap)
  if (hasNdvi && ndviDelta >= 0.15) {
    return {
      candidateTitle: 'Candidate Vegetation Increase / Regrowth',
      category: 'vegetation_increase',
      confidenceLabel: 'Moderate',
      evidence: [
        `NDVI T1 = ${ndviT1.toFixed(2)}`,
        `NDVI T2 = ${ndviT2.toFixed(2)} (Delta: +${ndviDelta.toFixed(2)})`,
        `Change mask overlap = ${changePct.toFixed(1)}%`
      ],
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 3. Water Expansion (NDWI gain >= 0.15)
  if (hasNdwi && ndwiDelta >= 0.15) {
    return {
      candidateTitle: 'Candidate Water Expansion',
      category: 'water_expansion',
      confidenceLabel: 'Moderate',
      evidence: [
        `NDWI T1 = ${ndwiT1.toFixed(2)}`,
        `NDWI T2 = ${ndwiT2.toFixed(2)} (Delta: +${ndwiDelta.toFixed(2)})`,
        `Change mask overlap = ${changePct.toFixed(1)}%`
      ],
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 4. Water Reduction (NDWI drop >= 0.15)
  if (hasNdwi && ndwiDelta <= -0.15) {
    return {
      candidateTitle: 'Candidate Water Reduction / Receding Water',
      category: 'water_reduction',
      confidenceLabel: 'Moderate',
      evidence: [
        `NDWI T1 = ${ndwiT1.toFixed(2)}`,
        `NDWI T2 = ${ndwiT2.toFixed(2)} (Delta: ${ndwiDelta.toFixed(2)})`,
        `Change mask overlap = ${changePct.toFixed(1)}%`
      ],
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 5. Built-up / Structure Expansion (SAR backscatter ratio > 1.25)
  if (typeof sarRatio === 'number' && sarRatio >= 1.25) {
    return {
      candidateTitle: 'Possible Built-up / Structure Expansion',
      category: 'possible_built_up',
      confidenceLabel: 'Moderate',
      evidence: [
        `SAR backscatter ratio = ${sarRatio.toFixed(2)}`,
        `Change mask overlap = ${changePct.toFixed(1)}%`
      ],
      caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
    };
  }

  // 6. Generic Disturbance / Surface Change
  return {
    candidateTitle: 'Candidate Surface Disturbance',
    category: 'possible_disturbance',
    confidenceLabel: 'Low to Moderate',
    evidence: [
      `Overall raster difference = ${changePct.toFixed(1)}%`,
      changedAreaKm2 !== null ? `Changed area = ${changedAreaKm2.toFixed(2)} km²` : null
    ].filter(Boolean),
    caveat: 'Candidate interpretation based on computed spectral/change signals. Semantic cause cannot be established from satellite measurements alone without ground truth.'
  };
}
