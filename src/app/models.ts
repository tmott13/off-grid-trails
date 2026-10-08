export type LatLon = [number, number];

export interface Trail {
  id: number;
  name: string | null;
  kind: string;
  difficulty: string | null;
  length: number; // meters
  coords: LatLon[];
}

export type PoiType =
  | 'viewpoint' | 'peak' | 'waterfall' | 'water' | 'trailhead'
  | 'parking' | 'toilets' | 'shelter' | 'campsite';

export interface Poi {
  id: number;
  type: PoiType;
  name: string | null;
  lat: number;
  lon: number;
  ele: number | null;
}

export interface Pack {
  id: string;
  name: string;
  region: string;
  bbox: [number, number, number, number];
  packedAt: string;
  attribution: string;
  trails: Trail[];
  pois: Poi[];
}

export interface Area {
  id: string;
  name: string;
  region: string;
  bbox: [number, number, number, number];
}

export const POI_ICON: Record<PoiType, string> = {
  viewpoint: '👀', peak: '⛰️', waterfall: '💦', water: '💧', trailhead: '🥾',
  parking: '🅿️', toilets: '🚻', shelter: '🛖', campsite: '⛺',
};
export const POI_LABEL: Record<PoiType, string> = {
  viewpoint: 'Viewpoint', peak: 'Peak', waterfall: 'Waterfall', water: 'Water', trailhead: 'Trailhead',
  parking: 'Parking', toilets: 'Restroom', shelter: 'Shelter', campsite: 'Campsite',
};
