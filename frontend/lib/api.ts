const BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || '';

if (!BASE && typeof window !== 'undefined') {
  console.warn('NEXT_PUBLIC_API_URL not set');
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export type SubmitResp = { prompt_id: string; status: string };
export type Meta = {
  pk: string;
  status: string;
  domain: string;
  target_model?: string;
  original_prompt: string;
  current_prompt?: string;
  latest_composite?: number;
  latest_confidence?: number;
  latest_severity?: string;
  latest_action?: string;
  latest_iteration?: number;
  latest_suggestion?: string;
  agg?: string;
  final_action?: string;
};
export type DbRecord = {
  pk: string;
  sk: string;
  iteration?: number;
  composite_score?: number;
  confidence?: number;
  severity?: string;
  action?: string;
  scores?: string;
  flags?: string;
  suggestion?: string;
  source?: string;
  before?: string;
  after?: string;
  usage_tokens?: string;
};

export type DomainSummary = {
  domain: string;
  display_name: string;
  token_budget: { min: number; max: number };
  rule_counts: {
    pii_risks: number;
    compliance: number;
    clarity_requirements: number;
    good_patterns: number;
    bad_patterns: number;
  };
};

export type DomainRules = {
  domain: string;
  display_name: string;
  token_budget: { min: number; max: number };
  pii_risks: string[];
  compliance: string[];
  clarity_requirements: string[];
  tone: string;
  good_patterns: string[];
  bad_patterns: string[];
  _fallback?: boolean;
  _requested_domain?: string;
};

export const api = {
  submit: (prompt: string, domain: string, targetModel?: string) =>
    req<SubmitResp>('/prompts', { method: 'POST', body: JSON.stringify({ prompt, domain, target_model: targetModel ?? '' }) }),
  get: (id: string) => req<{ meta: Meta; records: DbRecord[] }>(`/prompts/${id}`),
  list: (status?: string) =>
    req<{ items: Meta[] }>(`/prompts${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  review: (id: string, action: 'approve' | 'reject' | 'edit', edited_prompt?: string) =>
    req<{ ok: boolean }>(`/prompts/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, edited_prompt }),
    }),
  delete: (id: string) =>
    req<{ ok: boolean; deleted_records?: number; deleted_objects?: number }>(
      `/prompts/${id}`,
      { method: 'DELETE' }
    ),
  rules: {
    list: () => req<{ domains: DomainSummary[] }>('/rules'),
    get: (domain: string) => req<DomainRules>(`/rules/${encodeURIComponent(domain)}`),
    update: (domain: string, rules: DomainRules) =>
      req<{ ok: boolean }>(`/rules/${encodeURIComponent(domain)}`, {
        method: 'PUT',
        body: JSON.stringify(rules),
      }),
  },
};
