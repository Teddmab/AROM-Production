/**
 * Provenance marker written as `createdByUid` on offers imported by
 * reconciliation. The merged Backend Rules require `createdByUid is string`
 * at create, so the field cannot be omitted; this is a *system* marker,
 * deliberately not a user uid. Firebase Auth uids for client sign-ins are
 * server-generated alphanumerics (never containing ":"), and harvestOffers
 * can only be created by the trusted Mombongo identity (Rules), so no client
 * can submit this value. No user actor is invented.
 */
export const RECONCILIATION_ACTOR = "system:mombongo-reconciliation";
