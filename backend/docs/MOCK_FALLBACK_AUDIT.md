# Mock / fallback honesty audit

Source of truth: the code, not the docs. Audited
`backend/src/services/mlServiceClient.js` against the real ML responses in
`ml-service/app/{api,tools}/*.py` and the `ToolOutput` contract in
`ml-service/app/schemas/common.py`.

## ToolOutput contract (real, `schemas/common.py`)

```
{ tool, status, result, evidence, confidence, metadata }
```

## Real vs mock schema per endpoint

| endpoint | real `result` keys | mock `result` keys (before) | verdict |
|---|---|---|---|
| `/ndvi` | `index,min,max,mean,median,valid_pixel_count,total_pixel_count,bands,band_detection_method,warnings,aoi` | `value,map,classification` | fabricated value; `mean` missing so the real value is lost |
| `/ndwi` | same shape with `bands.green` | `value,map,classification` | same |
| `/area` | `status,area_km2,area_ha,area_m2,valid_pixel_count,total_pixel_count,resolution_m,resolution_y_m,crs,feature_type,pixel_area_m2,warnings,confidence,aoi` | `areaKm2,featureType,pixelCount` | camelCase-only; real `area_km2` absent |
| `/change` | `method,comparison_band,threshold,threshold_source,total_pixels,valid_pixels,invalid_pixels,changed_pixels,unchanged_pixels,change_percentage,mean_difference,max_difference,changed_area_km2,aligned,alignment,warnings,aoi` | `changePercentage,changeMaskUrl,summary` | `changeMaskUrl`/`summary` do not exist in the real tool; `change_percentage` absent |
| `/trend` | `metric,region,date_range,interval,source,collection,band_mapping,quality_mask,series,trend,warnings` | `metric,series,trendSlope,summary` | series dates/values invented; `trendSlope` is not a real key |
| `/vqa` | `answer,question,answer_mode,confidence,aoi` | `answer,confidence` | fabricated prose answer about urban infrastructure |
| `/caption` | `caption,confidence,aoi` | `caption,keywords` | `keywords` does not exist; caption invented |
| `/optical-sar` | `optical{feature_basis,statistics,normalized_mean},sar{band,statistics,speckle_filter,speckle_window,normalized_mean},fusion{method,optical_weight,sar_weight,combined_mean,combined_std,pearson_correlation},overlap{total_pixels,valid_pixels,invalid_pixels,validation_ratio,valid_area_km2,partial,overlap_ratio},alignment{method,resampling},crs{optical,sar,match},resolution,warnings,aoi` | `fusedLandCover{builtUpPercent,waterPercent,vegetationPercent,bareSoilPercent},summary` | **entirely fictional.** The real tool computes no land-cover percentages at all |
| `/validate` | `valid,validation_status,modality,format,width,height,band_count,bands,crs,bounds,wgs84_bounds,resolution,nodata,dtype,warnings,errors` | `valid,validation_status,format,errors,warnings` | claims a file is `valid` with `confidence: 1.0` without ever opening it |
| `/fetch-imagery` | `source,bounding_box,date_range,images,date_gap_days,warnings` | images with invented `satellite/bands/captureDate/resolution`, `date_gap_days: 3` | no imagery was acquired; satellite/bands/date are invented |
| `/ground` | **endpoint does not exist** in the ML service | `boundingBox:[0.25,0.30,0.65,0.70],label,detectedFeatures:1`, `confidence: 0.88` | **fabricated bbox + fabricated confidence** |

## Additional findings

1. **Fabricated `confidence` on every mock.** `0.85`–`1.0` values presented as
   analysis confidence. The ML service's own offline placeholder uses
   `confidence: 0.0`; the backend mocks did not.
2. **`status: 'success'` on results that computed nothing.**
3. **Tool-name divergence.** Real ML returns `tool: "optical-sar"` (hyphen);
   the backend mock returns `"optical_sar"` (underscore). `toolExecutor.js`
   builds `{ tool: tool.name, ...mlResult }`, so the ML value *overrides* the
   backend name. The frontend keys on `'optical_sar'` only, so the **real**
   fusion result is dropped while the **fabricated** mock renders.
4. **Invented `outputSchema` in `seedTools.js`** (`fusedLandCover`,
   `boundingBox`, `{value,map}`, `changeMaskUrl`) documents contracts the ML
   service never returns.
5. **Downstream loss.** `answerComposer` reads `fusedLandCover`
   (`answerComposer.js:464`) — a key only mocks produce, so a real fusion
   result produced no readable summary. Frontend `results.js:176-185` prints
   `JSON.stringify(result.fusedLandCover)` as the finding explanation.

## Resolution

Fallbacks now return the **real schema with null scientific values**,
`status: 'failed'`, `confidence: 0`, and explicit
`metadata.mock/offline/available/reason/not_computed`. `/ground` is reported
as unimplemented without attempting a call. The backend tool name is now
authoritative, so real and mock results agree.
