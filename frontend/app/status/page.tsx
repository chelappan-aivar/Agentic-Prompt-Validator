'use client';
import { Suspense, useEffect, useState, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, Meta, DbRecord } from '@/lib/api';

/* ---- Bedrock pricing (us-east-1, 2025) per token ---- */
const PRICE = {
  haiku:  { input: 0.80e-6, output: 4.00e-6, cacheRead: 0.08e-6 },
  sonnet: { input: 3.00e-6, output: 15.00e-6, cacheRead: 0.30e-6 },
} as const;

type ModelKey = 'haiku' | 'sonnet';
type CallUsage = { model: ModelKey; input_tokens: number; output_tokens: number; cache_read_tokens: number };
type UsagePayload = { calls: Record<string, CallUsage>; total: { input_tokens: number; output_tokens: number; cache_read_tokens: number } };

function callCost(u: CallUsage): number {
  const p = PRICE[u.model] ?? PRICE.sonnet;
  const fresh = Math.max(0, u.input_tokens - u.cache_read_tokens);
  return fresh * p.input + u.cache_read_tokens * p.cacheRead + u.output_tokens * p.output;
}

function totalUsageCost(payload: UsagePayload): number {
  return Object.values(payload.calls).reduce((s, c) => s + callCost(c), 0);
}

function fmtCost(n: number): string {
  if (n === 0) return '$0.0000';
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function parseUsage(s?: string): UsagePayload | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const CALL_LABELS: Record<string, string> = {
  token:      'Token check',
  clarity:    'Clarity check',
  safety:     'Safety check',
  suggest:    'Suggestion',
  verify_fix: 'Verify fix',
  llm_refine: 'LLM rewrite',
};

function RunCost({ usageJson, label }: { usageJson?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const payload = parseUsage(usageJson);
  if (!payload) return null;

  const cost = totalUsageCost(payload);
  const total = payload.total;

  return (
    <div className="run-cost-wrap">
      <button className="run-cost-toggle" onClick={() => setOpen(o => !o)}>
        <span className="run-cost-badge">
          {label && <span className="run-cost-label">{label}</span>}
          <span className="run-cost-val">{fmtCost(cost)}</span>
        </span>
        <span className="run-cost-summary muted">
          {total.input_tokens.toLocaleString()} in · {total.output_tokens.toLocaleString()} out
          {total.cache_read_tokens > 0 && ` · ${total.cache_read_tokens.toLocaleString()} cached`}
          <span style={{ fontSize: 10, marginLeft: 6 }}>{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div className="run-cost-detail">
          <table className="run-cost-table">
            <thead>
              <tr>
                <th>Call</th>
                <th>Model</th>
                <th style={{ textAlign: 'right' }}>In</th>
                <th style={{ textAlign: 'right' }}>Cached</th>
                <th style={{ textAlign: 'right' }}>Out</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(payload.calls).map(([name, u]) => (
                <tr key={name}>
                  <td>{CALL_LABELS[name] ?? name}</td>
                  <td><span className={`run-cost-model ${u.model}`}>{u.model}</span></td>
                  <td style={{ textAlign: 'right' }}>{u.input_tokens.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', color: 'var(--success)' }}>
                    {u.cache_read_tokens > 0 ? u.cache_read_tokens.toLocaleString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{u.output_tokens.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(callCost(u))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TERMINAL = new Set(['approved', 'rejected', 'awaiting_review']);

export default function StatusPageWrapper() {
  return (
    <Suspense fallback={<div className="container"><LoadingSkeleton /></div>}>
      <StatusPage />
    </Suspense>
  );
}

function LoadingSkeleton() {
  return (
    <div className="card">
      <div className="skeleton skel-bar" style={{ width: '40%' }} />
      <div className="skeleton skel-bar" />
      <div className="skeleton skel-bar" />
    </div>
  );
}

function gaugeColor(score: number): string {
  if (score >= 0.85) return 'var(--success)';
  if (score >= 0.5) return 'var(--warning)';
  return 'var(--danger)';
}

function StatusPage() {
  const id = useSearchParams().get('id') || '';
  const [meta, setMeta] = useState<Meta | null>(null);
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const aggRecords = useMemo(
    () => records.filter((r) => r.sk?.startsWith('AGG#')).sort((a, b) => (a.sk || '').localeCompare(b.sk || '')),
    [records],
  );
  const refineRecords = useMemo(
    () => records.filter((r) => r.sk?.startsWith('REFINE#')).sort((a, b) => (a.sk || '').localeCompare(b.sk || '')),
    [records],
  );
  const totalRunCost = useMemo(() => {
    let sum = 0;
    for (const r of [...aggRecords, ...refineRecords]) {
      const p = parseUsage(r.usage_tokens);
      if (p) sum += totalUsageCost(p);
    }
    return sum;
  }, [aggRecords, refineRecords]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await api.get(id);
        if (cancelled) return;
        setMeta(res.meta);
        setRecords(res.records || []);
        if (res.meta && !TERMINAL.has(res.meta.status)) {
          timer = setTimeout(tick, 2500);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [id]);

  if (!id) return <div className="container"><div className="error">Missing prompt id in URL</div></div>;
  if (error) return <div className="container"><div className="error">⚠ {error}</div></div>;
  if (!meta) return <div className="container"><LoadingSkeleton /></div>;

  const score = Number(meta.latest_composite ?? 0);
  const confidence = Number(meta.latest_confidence ?? 0);
  const pct = Math.round(score * 100);

  return (
    <div className="container">
      <div className="row between" style={{ marginBottom: 18 }}>
        <h1 style={{ marginBottom: 0 }}>Validation result</h1>
        <span className={`tag ${meta.status}`}>{meta.status.replace('_', ' ')}</span>
      </div>

      <div className="card">
        <div className="score-grid">
          <div className="gauge" style={{ ['--pct' as string]: pct, ['--color' as string]: gaugeColor(score) }}>
            <div className="gauge-inner">
              <div className="num">{score.toFixed(2)}</div>
              <div className="lbl">Composite</div>
            </div>
          </div>
          <div>
            <div className="kv">
              <div className="k">Domain</div>
              <div className="v"><span className="pill">{meta.domain}</span></div>
              <div className="k">Severity</div>
              <div className="v">
                <span className={`tag ${meta.latest_severity || 'MED'}`}>{meta.latest_severity || '—'}</span>
              </div>
              <div className="k">Confidence</div>
              <div className="v">{confidence ? `${(confidence * 100).toFixed(0)}%` : '—'}</div>
              <div className="k">Iteration</div>
              <div className="v">{meta.latest_iteration ?? 0}</div>
              <div className="k">Last action</div>
              <div className="v">{meta.latest_action || '—'}</div>
              {totalRunCost > 0 && (
                <>
                  <div className="k">Run cost</div>
                  <div className="v" style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmtCost(totalRunCost)}</div>
                </>
              )}
            </div>

            {meta.status === 'awaiting_review' && (
              <div style={{ marginTop: 18 }}>
                <Link href={`/review/detail?id=${id}`}>
                  <button>Open review →</button>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {meta.latest_suggestion && (
        <SuggestionCard
          original={meta.current_prompt || meta.original_prompt}
          suggestion={meta.latest_suggestion}
          canApply={meta.status === 'awaiting_review'}
          promptId={id}
        />
      )}

      <div className="card">
        <h2>Original prompt</h2>
        <div className="diff">{meta.original_prompt}</div>
      </div>

      {meta.current_prompt && meta.current_prompt !== meta.original_prompt && (
        <div className="card">
          <div className="row between">
            <h2 style={{ marginBottom: 0 }}>Current prompt</h2>
            <span className="pill">latest revision</span>
          </div>
          <div className="diff" style={{ marginTop: 12 }}>{meta.current_prompt}</div>
        </div>
      )}

      {aggRecords.length > 0 && (
        <div className="card">
          <h2>Agent runs</h2>
          {aggRecords.map((r) => (
            <AgentRun key={r.sk} record={r} />
          ))}
        </div>
      )}

      {refineRecords.length > 0 && (
        <div className="card">
          <h2>Refinements</h2>
          {refineRecords.map((r) => (
            <RefineRun key={r.sk} record={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRun({ record }: { record: DbRecord }) {
  const scores = (safeParse<Record<string, any>>(record.scores) || {}) as Record<string, any>;
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 18, marginTop: 18 }}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="row">
          <span className="pill">Iteration {record.iteration}</span>
          <span className={`tag ${record.severity}`}>{record.severity}</span>
        </div>
        <div className="muted">
          score <strong>{Number(record.composite_score).toFixed(2)}</strong> · confidence <strong>{(Number(record.confidence) * 100).toFixed(0)}%</strong> · → {record.action}
        </div>
      </div>
      <RunCost usageJson={record.usage_tokens} label="Aggregation cost" />
      <div className="agent-grid" style={{ marginTop: 12 }}>
        {Object.entries(scores).map(([name, s]: [string, any]) => (
          <div key={name} className="agent-panel">
            <div className="agent-panel-header">
              <div className="agent-panel-name">{name}</div>
              <div className={`agent-panel-score ${s.severity}`}>{Number(s.score ?? 0).toFixed(2)}</div>
            </div>
            <span className={`tag ${s.severity}`}>{s.severity}</span>
            {(s.issues || []).length > 0 && (
              <ul>
                {s.issues.slice(0, 4).map((i: string, idx: number) => (
                  <li key={idx}>{i}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RefineRun({ record }: { record: DbRecord }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 18, marginTop: 18 }}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="row">
          <span className="pill">Iteration {record.iteration}</span>
          <span className={`tag ${record.source}`}>{record.source}</span>
        </div>
      </div>
      {record.usage_tokens && (
        <RunCost usageJson={record.usage_tokens} label="Refinement cost" />
      )}
      <details style={{ marginTop: 10 }}>
        <summary>View before / after</summary>
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ marginBottom: 6 }}>Before</p>
          <div className="diff">{record.before}</div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 6 }}>After</p>
          <div className="diff">{record.after}</div>
        </div>
      </details>
    </div>
  );
}

function safeParse<T>(s?: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function approxTokens(s: string): number {
  return Math.round(s.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

function SuggestionCard({
  original,
  suggestion,
  canApply,
  promptId,
}: {
  original: string;
  suggestion: string;
  canApply: boolean;
  promptId: string;
}) {
  const [copied, setCopied] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const router = useRouter();

  const tBefore = approxTokens(original);
  const tAfter = approxTokens(suggestion);
  const saved = Math.max(0, tBefore - tAfter);
  const pct = tBefore > 0 ? Math.round((saved / tBefore) * 100) : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(suggestion);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await api.review(promptId, 'edit', suggestion);
      router.push(`/status?id=${promptId}`);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'apply failed');
      setApplying(false);
    }
  };

  return (
    <div className="suggestion-card">
      <h2>
        <span className="sparkle">✨</span>
        Suggested refinement
      </h2>
      <p className="muted" style={{ marginBottom: 8 }}>
        AI-generated improved version of your prompt, tuned to the target domain.
      </p>
      <div className="stats">
        <div className="stat">
          before: <strong>~{tBefore} tokens</strong>
        </div>
        <div className="stat">
          after: <strong>~{tAfter} tokens</strong>
          {saved > 0 && <span className="delta">−{pct}%</span>}
        </div>
        <div className="stat">
          length: <strong>{original.length} → {suggestion.length} chars</strong>
        </div>
      </div>
      <div className="diff">{suggestion}</div>
      {applyError && <div className="error" style={{ marginTop: 12 }}>⚠ {applyError}</div>}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="secondary" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
        {canApply && (
          <button onClick={apply} disabled={applying}>
            {applying ? 'Applying…' : 'Apply suggestion ↺'}
          </button>
        )}
      </div>
    </div>
  );
}
