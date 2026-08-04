export interface FederationListing {
  localFleet: string;
  fleets: { name: string; sessions: string[] }[];
}
