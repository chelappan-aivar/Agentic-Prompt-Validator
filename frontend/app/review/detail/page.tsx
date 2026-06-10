'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, Meta, DbRecord } from '@/lib/api';

export default function ReviewDetailWrapper() {
  return (
    <Suspense fallback={<div className="container"><LoadingSkeleton /></div>}>
      <ReviewDetail />
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

function ReviewDetail() {
  const id = useSearchParams().get('id') || '';
  const router = useRouter();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .get(id)
      .then((r) => {
        setMeta(r.meta);
        setRecords(r.records || []);
        setEdited(r.meta.current_prompt || r.meta.original_prompt || '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, [id]);

  const act = async (action: 'approve' | 'reject' | 'edit', override?: string) => {
    setBusy(true);
    setError(null);
    try {
      const editText = action === 'edit' ? (override ?? edited) : undefined;
      await api.review(id, action, editText);
      router.push(`/status?id=${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action failed';
      // 409 means task token is gone — prompt already processed; go to status
      if (msg.startsWith('409:')) {
        router.push(`/status?id=${id}`);
        return;
      }
      setError(msg);
      setBusy(false);
    }
  };

  if (!id) return <div className="container"><div className="error">Missing prompt id in URL</div></div>;
  if (error) return <div className="container"><div className="error">⚠ {error}</div></div>;
  if (!meta) return <div className="container"><LoadingSkeleton /></div>;

  if (meta.status !== 'awaiting_review') {
    return (
      <div className="container">
        <div className="card">
          <h2>Not awaiting review</h2>
          <p className="muted">Current status: <span className={`tag ${meta.status}`}>{meta.status}</span></p>
        </div>
      </div>
    );
  }

  const latestAgg = records
    .filter((r) => r.sk?.startsWith('AGG#'))
    .sort((a, b) => (b.sk || '').localeCompare(a.sk || ''))[0];
  const scores = latestAgg ? safeParse<any>(latestAgg.scores) : safeParse<any>(meta.agg)?.scores;

  const score = Number(meta.latest_composite ?? 0);
  const confidence = Number(meta.latest_confidence ?? 0);
  const pct = Math.round(score * 100);

  return (
    <div className="container">
      <h1>Human review</h1>

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
              <div className="v"><span className={`tag ${meta.latest_severity || 'MED'}`}>{meta.latest_severity}</span></div>
              <div className="k">Confidence</div>
              <div className="v">{(confidence * 100).toFixed(0)}%</div>
              <div className="k">Iteration</div>
              <div className="v">{meta.latest_iteration ?? 0}</div>
            </div>
          </div>
        </div>
      </div>

      {scores && (
        <div className="card">
          <h2>Agent findings</h2>
          <div className="agent-grid">
            {Object.entries(scores).map(([name, s]: [string, any]) => (
              <div key={name} className="agent-panel">
                <div className="agent-panel-header">
                  <div className="agent-panel-name">{name}</div>
                  <div className={`agent-panel-score ${s.severity}`}>{Number(s.score ?? 0).toFixed(2)}</div>
                </div>
                <span className={`tag ${s.severity}`}>{s.severity}</span>
                {(s.issues || []).length > 0 && (
                  <>
                    <p className="muted" style={{ marginTop: 10, marginBottom: 4, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Issues</p>
                    <ul>
                      {s.issues.slice(0, 5).map((i: string, idx: number) => <li key={idx}>{i}</li>)}
                    </ul>
                  </>
                )}
                {(s.suggestions || []).length > 0 && (
                  <>
                    <p className="muted" style={{ marginTop: 10, marginBottom: 4, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Suggestions</p>
                    <ul>
                      {s.suggestions.slice(0, 4).map((s2: string, idx: number) => <li key={idx}>{s2}</li>)}
                    </ul>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {meta.latest_suggestion && (
        <div className="suggestion-card">
          <h2>
            <span className="sparkle">✨</span>
            Suggested refinement
          </h2>
          <p className="muted" style={{ marginBottom: 8 }}>
            AI-generated improved version. Use as-is or edit further before approving.
          </p>
          <div className="diff">{meta.latest_suggestion}</div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button
              className="secondary"
              onClick={() => {
                setEdited(meta.latest_suggestion || '');
                setEditing(true);
              }}
              disabled={busy}
            >
              Use suggestion as edit
            </button>
            <button
              onClick={() => act('edit', meta.latest_suggestion)}
              disabled={busy}
            >
              {busy ? 'Applying…' : 'Apply suggestion & re-validate'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ marginBottom: 0 }}>Prompt</h2>
          {!editing && <button className="secondary" onClick={() => setEditing(true)} disabled={busy}>Edit</button>}
        </div>
        {!editing ? (
          <div className="diff">{meta.current_prompt || meta.original_prompt}</div>
        ) : (
          <textarea value={edited} onChange={(e) => setEdited(e.target.value)} />
        )}
      </div>

      <div className="card">
        <div className="row between">
          <span className="muted">Choose an action — this resumes the workflow.</span>
          <div className="btn-row">
            {editing && (
              <>
                <button className="secondary" onClick={() => setEditing(false)} disabled={busy}>Cancel edit</button>
                <button onClick={() => act('edit')} disabled={busy || !edited.trim()}>Save edit & re-validate</button>
              </>
            )}
            {!editing && (
              <>
                <button className="danger" onClick={() => act('reject')} disabled={busy}>Reject</button>
                <button className="success" onClick={() => act('approve')} disabled={busy}>Approve</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function safeParse<T>(s?: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
