import { doc, setDoc } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "@/lib/firebase/config";
import { newId } from "./store";

/**
 * Tasks are the primary driver of the ERP's core Appro→Production→Stock→
 * Commercialisation funnel, and (sprint 37) of three more workflows that
 * previously happened only via direct record edits: partner KYC
 * verification, storefront order fulfillment, and staff invite follow-up.
 * Direct editing stays available everywhere (BoutiquesCard's Vérifié
 * toggle, OrdersCard's status buttons, etc.) — tasks are the recommended
 * path, not the only one. Extracted out of dashboard.tsx so non-dashboard
 * code (CheckoutSheet.tsx, auth.tsx's completePartnerOnboarding) can spawn
 * tasks too, at the exact moment the source record they track is created.
 */
export type TaskStage =
  | "production"
  | "stock"
  | "commercialisation"
  | "kyc"
  | "order-confirm"
  | "order-fulfill"
  | "invite";

export interface Task {
  id: string;
  stage: TaskStage;
  title: string;
  /** Display label for the source record — kept even though sourceId (below) is the real lineage key, since renaming the source shouldn't also rewrite every task title. */
  sourceLabel: string;
  /** Real id of the record this task traces back to (réception, production lot, partner uid, order id, invite id). Optional: tasks created before sprint 32 only have sourceLabel. */
  sourceId?: string;
  status: "pending" | "done";
  createdAt: string;
  completedAt?: string;
  completedBy?: string;
}

export function createTask(
  stage: TaskStage,
  title: string,
  sourceLabel: string,
  sourceId?: string,
) {
  const id = newId("TASK");
  return setDoc(doc(db, "tasks", id), {
    id,
    stage,
    title,
    sourceLabel,
    ...(sourceId ? { sourceId } : {}),
    status: "pending",
    createdAt: new Date().toISOString(),
  } satisfies Task).catch((err) =>
    toast.error(
      err instanceof Error
        ? `Création de tâche impossible : ${err.message}`
        : "Création de tâche impossible.",
    ),
  );
}

/**
 * Which stages a given account should see in "Tâches" — mirrors
 * firestore.rules' poste scoping (rbac.md) so the UI never offers a stage
 * the account couldn't actually act on:
 * - orders (order-confirm/order-fulfill) require admin/unscoped-staff/
 *   Chargée de Commercialisation read access — Directeur de Production has
 *   no `orders` read rule at all.
 * - invites require `list`, which firestore.rules grants to admin only
 *   (matches InviteCard's own `profile?.role !== "admin"` guard).
 * - kyc reads `users`, which every signed-in staff account can read
 *   regardless of poste, and both named postes' STAFF_POSTES menus include
 *   "personnel" (where Boutiques partenaires already lives) — so kyc tasks
 *   are visible to every staff account, not just unscoped ones.
 */
export function visibleTaskStages(
  profile: { role?: string; poste?: string } | null | undefined,
): TaskStage[] {
  if (profile?.poste === "Directeur de Production") return ["production", "stock", "kyc"];
  if (profile?.poste === "Chargée de Commercialisation")
    return ["commercialisation", "order-confirm", "order-fulfill", "kyc"];
  const base: TaskStage[] = [
    "production",
    "stock",
    "commercialisation",
    "order-confirm",
    "order-fulfill",
    "kyc",
  ];
  return profile?.role === "admin" ? [...base, "invite"] : base;
}
