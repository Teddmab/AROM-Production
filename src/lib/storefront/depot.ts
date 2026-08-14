/**
 * AROM currently delivers from a single point of sale. This is a stub —
 * once there's more than one, replace it with a real `pointsDeVente`
 * Firestore collection and a commune → depot lookup, matching the
 * `address` shape already collected during boutique onboarding
 * (see storefront/signup.tsx).
 */
export const AROM_DEPOT_NAME = "Dépôt AROM — Kasaï";

export const DRC_VILLES = ["Kananga", "Tshikapa", "Mbuji-Mayi", "Luebo", "Ilebo", "Autre"] as const;
