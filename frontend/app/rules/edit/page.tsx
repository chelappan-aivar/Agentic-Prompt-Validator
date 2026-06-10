'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, DomainRules } from '@/lib/api';

export default function RulesEditPage() {
  return (
    <Suspense fallback={<div className="container"><p className="muted">Loading…</p></div>}>
      <RulesEditInner />
    </Suspense>
  );
}

function RulesEditInner() {
  const params = useSearchParams();
  const router = useRouter();
  const domain = params.get('domain') || 'general';

  const [rules, setRules] = useState<DomainRules | null>(null);
  const [original, setOriginal] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.rules.get(domain)
      .then((r) => {
        setRules(r);
        setOriginal(JSON.stringify(r));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [domain]);

  const isDirty = rules ? JSON.stringify(rules) !== original : false;

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.rules.update(domain, rules);
      setOriginal(JSON.stringify(rules));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (original) setRules(JSON.parse(original));
  };

  if (loading) return <div className="container"><p className="muted">Loading…</p></div>;
  if (!rules) return <div className="container"><div className="error"><span>⚠</span><span>{error || 'Not found'}</span></div></div>;

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Link href="/rules" style={{ color: 'var(--text-muted)', fontSize: 13 }}>← All domains</Link>
        <span style={{ color: 'var(--border-strong)' }}>/</span>
        <span style={{ fontWeight: 700, fontSize: 16 }}>{rules.display_name}</span>
        {rules._fallback && (
          <span className="tag MED" style={{ fontSize: 11 }}>Using general fallback</span>
        )}
      </div>

      {error && <div className="error" style={{ marginBottom: 18 }}><span>⚠</span><span>{error}</span></div>}

      {/* Sticky save bar */}
      {(isDirty || saved) && (
        <div className="rules-save-bar">
          {saved
            ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓ Saved</span>
            : <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Unsaved changes</span>
          }
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="secondary" onClick={discard} disabled={saving} style={{ fontSize: 13, padding: '6px 14px' }}>
              Discard
            </button>
            <button onClick={save} disabled={saving} style={{ fontSize: 13, padding: '6px 18px' }}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}

      {/* Display name */}
      <div className="card">
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>Display name</label>
          <input
            value={rules.display_name}
            onChange={(e) => setRules({ ...rules, display_name: e.target.value })}
            placeholder="e.g. Medical / Clinical"
          />
        </div>
      </div>

      {/* Token budget */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 14 }}>Token budget</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>Min tokens</label>
            <input
              type="number"
              min={1}
              value={rules.token_budget.min}
              onChange={(e) => setRules({ ...rules, token_budget: { ...rules.token_budget, min: Number(e.target.value) } })}
            />
          </div>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <label>Max tokens</label>
            <input
              type="number"
              min={1}
              value={rules.token_budget.max}
              onChange={(e) => setRules({ ...rules, token_budget: { ...rules.token_budget, max: Number(e.target.value) } })}
            />
          </div>
        </div>
        <div className="helper" style={{ marginTop: 10 }}>
          Prompts outside this range will be flagged for token efficiency.
        </div>
      </div>

      {/* Tone */}
      <div className="card">
        <div className="form-row" style={{ marginBottom: 0 }}>
          <label>Tone</label>
          <input
            value={rules.tone}
            onChange={(e) => setRules({ ...rules, tone: e.target.value })}
            placeholder="e.g. Objective, clinical, precise."
          />
          <div className="helper">Expected register and voice for this domain.</div>
        </div>
      </div>

      {/* Array sections */}
      <ArraySection
        title="PII risks"
        description="Data types flagged as PII in this domain. The safety tool checks for these specifically."
        items={rules.pii_risks}
        onChange={(v) => setRules({ ...rules, pii_risks: v })}
        placeholder="e.g. patient full name"
        accent="danger"
      />

      <ArraySection
        title="Compliance requirements"
        description="Regulatory and policy constraints applied to every prompt in this domain."
        items={rules.compliance}
        onChange={(v) => setRules({ ...rules, compliance: v })}
        placeholder="e.g. HIPAA — do not include patient-identifiable information"
        accent="warning"
      />

      <ArraySection
        title="Clarity requirements"
        description="What makes a prompt clear and complete for this domain. The clarity tool checks these."
        items={rules.clarity_requirements}
        onChange={(v) => setRules({ ...rules, clarity_requirements: v })}
        placeholder="e.g. Specify patient population or case type"
        accent="info"
      />

      <ArraySection
        title="Good patterns"
        description="Example prompt starters that follow best practices for this domain."
        items={rules.good_patterns}
        onChange={(v) => setRules({ ...rules, good_patterns: v })}
        placeholder="e.g. Summarise the following de-identified clinical note in SOAP format:"
        accent="success"
        large
      />

      <ArraySection
        title="Bad patterns"
        description="Anti-patterns and phrases that violate domain rules. Used to train the safety and clarity tools."
        items={rules.bad_patterns}
        onChange={(v) => setRules({ ...rules, bad_patterns: v })}
        placeholder="e.g. What medication should I give John Smith?"
        accent="danger"
        large
      />

      {/* Bottom save */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
        <button className="secondary" onClick={() => router.push('/rules')}>Cancel</button>
        <button onClick={save} disabled={saving || !isDirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
type AccentColor = 'danger' | 'warning' | 'info' | 'success';

function ArraySection({
  title, description, items, onChange, placeholder, accent, large = false,
}: {
  title: string;
  description: string;
  items: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  accent: AccentColor;
  large?: boolean;
}) {
  const update = (i: number, val: string) => {
    const next = [...items];
    next[i] = val;
    onChange(next);
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, '']);

  const accentColor: Record<AccentColor, string> = {
    danger: 'var(--danger)',
    warning: 'var(--warning)',
    info: 'var(--info)',
    success: 'var(--success)',
  };
  const accentSoft: Record<AccentColor, string> = {
    danger: 'var(--danger-soft)',
    warning: 'var(--warning-soft)',
    info: 'var(--info-soft)',
    success: 'var(--success-soft)',
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>
            <span
              style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: accentColor[accent], marginRight: 7, verticalAlign: 'middle',
              }}
            />
            {title}
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 600,
              background: accentSoft[accent], color: accentColor[accent],
              padding: '2px 7px', borderRadius: 12,
            }}>
              {items.length}
            </span>
          </div>
          <div className="helper" style={{ marginTop: 0 }}>{description}</div>
        </div>
        <button
          className="secondary"
          onClick={add}
          style={{ fontSize: 12, padding: '5px 12px', flexShrink: 0, marginLeft: 12 }}
        >
          + Add
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: '10px 0', textAlign: 'center' }}>
            No items yet — click + Add to add one.
          </div>
        )}
        {items.map((item, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {large ? (
              <textarea
                value={item}
                onChange={(e) => update(i, e.target.value)}
                placeholder={placeholder}
                style={{ minHeight: 60, resize: 'vertical', flex: 1 }}
              />
            ) : (
              <input
                value={item}
                onChange={(e) => update(i, e.target.value)}
                placeholder={placeholder}
                style={{ flex: 1 }}
              />
            )}
            <button
              className="secondary"
              onClick={() => remove(i)}
              style={{ padding: '8px 12px', fontSize: 13, color: 'var(--danger)', flexShrink: 0 }}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
