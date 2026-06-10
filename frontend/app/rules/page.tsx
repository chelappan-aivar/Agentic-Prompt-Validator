'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, DomainSummary } from '@/lib/api';

export default function RulesPage() {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.rules.list()
      .then((r) => setDomains(r.domains))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="container" style={{ maxWidth: 960 }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ marginBottom: 6 }}>Domain rules</h1>
        <p className="muted">
          Each domain defines token budgets, PII risks, compliance requirements, and example patterns
          used by the validation agent. Select a domain to view or edit its rules.
        </p>
      </div>

      {loading && <p className="muted">Loading domains…</p>}
      {error && <div className="error"><span>⚠</span><span>{error}</span></div>}

      {!loading && !error && (
        <div className="rules-domain-grid">
          {domains.map((d) => (
            <div key={d.domain} className="card rules-domain-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 3 }}>{d.display_name}</div>
                  <code style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-subtle)', padding: '2px 7px', borderRadius: 4 }}>
                    {d.domain}
                  </code>
                </div>
                <Link href={`/rules/edit?domain=${d.domain}`}>
                  <button className="secondary" style={{ fontSize: 13, padding: '6px 14px' }}>
                    Edit
                  </button>
                </Link>
              </div>

              <div style={{ marginBottom: 12 }}>
                <span className="card-title">Token budget</span>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>
                  {d.token_budget?.min ?? '—'}–{d.token_budget?.max ?? '—'} tokens
                </div>
              </div>

              <div className="rules-count-row">
                <RuleCount label="PII risks"    n={d.rule_counts.pii_risks} />
                <RuleCount label="Compliance"   n={d.rule_counts.compliance} />
                <RuleCount label="Clarity"      n={d.rule_counts.clarity_requirements} />
                <RuleCount label="Good patterns" n={d.rule_counts.good_patterns} />
                <RuleCount label="Bad patterns"  n={d.rule_counts.bad_patterns} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleCount({ label, n }: { label: string; n: number }) {
  return (
    <div className="rules-count-item">
      <span style={{ fontSize: 18, fontWeight: 700 }}>{n}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}
