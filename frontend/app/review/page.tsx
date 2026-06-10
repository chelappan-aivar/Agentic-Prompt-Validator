'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Meta } from '@/lib/api';

export default function ReviewQueue() {
  const [items, setItems] = useState<Meta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .list('awaiting_review')
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="container">
      <div className="row between" style={{ marginBottom: 18 }}>
        <h1 style={{ marginBottom: 0 }}>Review queue</h1>
        <span className="pill">{loading ? '…' : `${items.length} pending`}</span>
      </div>

      {error && <div className="error">⚠ {error}</div>}

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
            <div className="icon">✓</div>
            <h3 style={{ marginBottom: 4 }}>All caught up</h3>
            <p className="muted">No prompts awaiting review.</p>
          </div>
        </div>
      )}

      {items.map((m) => (
        <Link
          key={m.pk}
          href={`/review/detail?id=${m.pk}`}
          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          <div className="card interactive">
            <div className="row between" style={{ marginBottom: 10 }}>
              <div className="row">
                <span className={`tag ${m.latest_severity || 'MED'}`}>{m.latest_severity || '—'}</span>
                <span className="pill">{m.domain}</span>
              </div>
              <div className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                score <strong>{Number(m.latest_composite ?? 0).toFixed(2)}</strong> · conf <strong>{((Number(m.latest_confidence ?? 0)) * 100).toFixed(0)}%</strong> · iter {m.latest_iteration ?? 0}
              </div>
            </div>
            <div style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.55 }}>
              {(m.current_prompt || m.original_prompt || '').slice(0, 240)}
              {(m.current_prompt || m.original_prompt || '').length > 240 ? '…' : ''}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
