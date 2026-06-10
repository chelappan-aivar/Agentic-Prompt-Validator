'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Meta } from '@/lib/api';

export default function ApprovedPrompts() {
  const [items, setItems] = useState<Meta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .list('approved')
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const onRemove = async (id: string) => {
    setDeletingId(id);
    setActionError(null);
    try {
      await api.delete(id);
      setItems((prev) => prev.filter((m) => m.pk !== id));
      setConfirmingId(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="container">
      <div className="row between" style={{ marginBottom: 18 }}>
        <h1 style={{ marginBottom: 0 }}>Approved prompts</h1>
        <span className="pill">{loading ? '…' : `${items.length} approved`}</span>
      </div>

      {error && <div className="error">⚠ {error}</div>}
      {actionError && <div className="error">⚠ {actionError}</div>}

      {loading && (
        <div className="card">
          <div className="skeleton skel-bar" />
          <div className="skeleton skel-bar" />
          <div className="skeleton skel-bar" />
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="card">
          <div className="empty">
            <div className="icon">∅</div>
            <h3 style={{ marginBottom: 4 }}>No approved prompts yet</h3>
            <p className="muted">Prompts that pass scoring or are approved in review will appear here.</p>
          </div>
        </div>
      )}

      {items.map((m) => {
        const isConfirming = confirmingId === m.pk;
        const isDeleting = deletingId === m.pk;
        return (
          <div key={m.pk} className="card" style={{ position: 'relative' }}>
            <div className="row between" style={{ marginBottom: 10 }}>
              <div className="row">
                <span className={`tag ${m.latest_severity || 'LOW'}`}>{m.latest_severity || '—'}</span>
                <span className="pill">{m.domain}</span>
                <span className="pill" style={{ background: 'rgba(46, 160, 67, 0.15)', color: '#2ea043' }}>
                  {m.final_action || m.latest_action || 'approved'}
                </span>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  score <strong>{Number(m.latest_composite ?? 0).toFixed(2)}</strong> · conf <strong>{((Number(m.latest_confidence ?? 0)) * 100).toFixed(0)}%</strong> · iter {m.latest_iteration ?? 0}
                </div>
                {!isConfirming && (
                  <button
                    type="button"
                    className="secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => { setConfirmingId(m.pk); setActionError(null); }}
                    disabled={isDeleting}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <Link
              href={`/status?id=${m.pk}`}
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.55 }}>
                {(m.current_prompt || m.original_prompt || '').slice(0, 240)}
                {(m.current_prompt || m.original_prompt || '').length > 240 ? '…' : ''}
              </div>
            </Link>

            {isConfirming && (
              <div
                className="row"
                style={{
                  marginTop: 12,
                  padding: 10,
                  borderRadius: 8,
                  background: 'rgba(248, 81, 73, 0.08)',
                  border: '1px solid rgba(248, 81, 73, 0.3)',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--text)' }}>
                  Permanently delete this prompt and all its records? This cannot be undone.
                </span>
                <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
                  <button
                    type="button"
                    className="secondary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => setConfirmingId(null)}
                    disabled={isDeleting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: '4px 10px',
                      fontSize: 12,
                      background: '#cf222e',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                    onClick={() => onRemove(m.pk)}
                    disabled={isDeleting}
                  >
                    {isDeleting ? 'Removing…' : 'Remove permanently'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
