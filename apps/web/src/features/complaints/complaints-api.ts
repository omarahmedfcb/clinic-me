// The complaints ("شكوى") viewer — what patients reported over WhatsApp. Read plus one action
// (resolve); the complaint itself is only ever created by the bot (bot.controller.ts's
// POST /bot/complaints), which is why there is no create call in this file, the same reasoning
// audit-api.ts gives for having no write call in it at all.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ComplaintEntry {
  id: string;
  referenceNumber: string;
  description: string;
  status: "OPEN" | "RESOLVED";
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
}

export interface ComplaintsPage {
  entries: ComplaintEntry[];
  total: number;
}

export interface ComplaintsQuery {
  status?: "OPEN" | "RESOLVED";
  limit?: number;
  offset?: number;
}

export async function loadComplaints(authFetch: AuthFetch, query: ComplaintsQuery = {}): Promise<ComplaintsPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 50), offset: String(query.offset ?? 0) });
  if (query.status !== undefined) params.set("status", query.status);

  const response = await authFetch(`/api/complaints?${params.toString()}`);
  if (!response.ok) throw new Error(`GET /complaints -> ${response.status}`);
  const body = (await response.json()) as Partial<ComplaintsPage>;
  if (!Array.isArray(body.entries)) throw new Error("GET /complaints -> unreadable payload");
  return { entries: body.entries, total: body.total ?? body.entries.length };
}

export async function resolveComplaint(authFetch: AuthFetch, complaintId: string): Promise<void> {
  const response = await authFetch(`/api/complaints/${complaintId}/resolve`, { method: "POST" });
  if (!response.ok) throw new Error(`POST /complaints/${complaintId}/resolve -> ${response.status}`);
}
