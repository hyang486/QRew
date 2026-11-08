import { AppleMaps } from 'expo-maps';

// Hide Apple Maps points of interest so a tap on a store/landmark cannot open Apple's place card (R-1, human
// iPhone check). `including: []` still rendered every POI on iOS 26 (qa, a025558), so exclude each category
// the installed expo-maps knows instead. Categories MapKit adds later are not covered.
export const NO_POIS: AppleMaps.PointOfInterestCategories = {
  excluding: Object.values(AppleMaps.PointOfInterestCategory) as AppleMaps.PointOfInterestCategory[],
};
