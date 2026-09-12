import { interpretCandidateSemanticChange } from '../src/utils/semanticChangeInterpreter.js';

describe('Candidate Semantic Change Interpretation', () => {
  test('returns candidate vegetation decline when NDVI drops significantly with change overlap', () => {
    const changeResult = {
      change_percentage: 14.5,
      changed_area_km2: 1.25,
      mean_difference: 0.28
    };
    const supportingSignals = {
      ndviT1: 0.68,
      ndviT2: 0.42,
      ndwiT1: -0.10,
      ndwiT2: -0.05
    };

    const res = interpretCandidateSemanticChange({ changeResult, supportingSignals });

    expect(res.candidateTitle).toBe('Candidate Vegetation Decline');
    expect(res.category).toBe('vegetation_decline');
    expect(res.evidence.some(e => e.includes('NDVI T1 = 0.68'))).toBe(true);
    expect(res.evidence.some(e => e.includes('NDVI T2 = 0.42'))).toBe(true);
    expect(res.caveat).toContain('Semantic cause cannot be established from satellite measurements alone without ground truth.');
    expect(res.confidenceLabel).toBe('Moderate');
  });

  test('returns candidate water expansion when NDWI increases significantly', () => {
    const changeResult = {
      change_percentage: 8.2,
      changed_area_km2: 0.65
    };
    const supportingSignals = {
      ndviT1: 0.20,
      ndviT2: 0.15,
      ndwiT1: 0.05,
      ndwiT2: 0.38
    };

    const res = interpretCandidateSemanticChange({ changeResult, supportingSignals });

    expect(res.candidateTitle).toBe('Candidate Water Expansion');
    expect(res.category).toBe('water_expansion');
    expect(res.evidence.some(e => e.includes('NDWI T1 = 0.05'))).toBe(true);
    expect(res.evidence.some(e => e.includes('NDWI T2 = 0.38'))).toBe(true);
  });

  test('returns candidate possible built-up expansion when SAR backscatter increases with change overlap', () => {
    const changeResult = {
      change_percentage: 11.0,
      changed_area_km2: 0.90
    };
    const supportingSignals = {
      sarRatio: 1.45,
      opticalChangePct: 11.0
    };

    const res = interpretCandidateSemanticChange({ changeResult, supportingSignals });

    expect(res.candidateTitle).toBe('Possible Built-up / Structure Expansion');
    expect(res.category).toBe('possible_built_up');
    expect(res.evidence.some(e => e.includes('SAR backscatter ratio = 1.45'))).toBe(true);
  });

  test('returns insufficient evidence when change is trivial or signals are conflicting', () => {
    const changeResult = {
      change_percentage: 0.3,
      changed_area_km2: 0.01,
      mean_difference: 0.02
    };

    const res = interpretCandidateSemanticChange({ changeResult });

    expect(res.candidateTitle).toBe('No Meaningful Candidate Change');
    expect(res.category).toBe('no_change');
    expect(res.confidenceLabel).toBe('Low');
    expect(res.caveat).toBeDefined();
  });
});
