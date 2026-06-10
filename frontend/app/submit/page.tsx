'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, DomainRules, DomainSummary } from '@/lib/api';
import { MODELS, ModelProfile, groupByProvider, GUARDRAIL_LABEL, GUARDRAIL_TAG } from '@/lib/models';

const GROUPED_MODELS = groupByProvider();

export default function SubmitPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [domain, setDomain] = useState('');
  const [targetModel, setTargetModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [rules, setRules] = useState<DomainRules | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const rulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.rules.list().then((r) => setDomains(r.domains)).catch(() => {});
  }, []);

  useEffect(() => {
    if (rulesTimer.current) clearTimeout(rulesTimer.current);
    if (!domain.trim()) { setRules(null); return; }
    rulesTimer.current = setTimeout(() => {
      api.rules.get(domain.trim().toLowerCase())
        .then((r) => { setRules(r); setRulesOpen(true); })
        .catch(() => setRules(null));
    }, 400);
    return () => { if (rulesTimer.current) clearTimeout(rulesTimer.current); };
  }, [domain]);

  const selectedModel: ModelProfile | undefined = MODELS.find((m) => m.id === targetModel);

  const tokensPerWord = selectedModel?.tokens_per_word ?? 1.3;
  const wordCount = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  const estimatedTokens = Math.round(wordCount * tokensPerWord);
  const contextWindow = selectedModel?.context_window;
  const remainingCtx = contextWindow ? contextWindow - estimatedTokens : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.submit(prompt, domain, targetModel || undefined);
      router.push(`/status?id=${res.prompt_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
      setBusy(false);
    }
  };

  const pillDomains = domains.length > 0
    ? domains.map((d) => d.domain)
    : ['legal', 'medical', 'financial', 'marketing', 'technical', 'general'];

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <div className="hero">
        <h1>Validate any prompt in seconds</h1>
        <p>Three specialist agents score your prompt for token efficiency, clarity, and safety — tuned to your domain and target model.</p>
      </div>

      <form onSubmit={submit} className="card">
        {error && (
          <div className="error">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* Domain */}
        <div className="form-row">
          <label htmlFor="domain">Target domain</label>
          <input
            id="domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="e.g. legal, medical, financial, marketing"
            required
          />
          <div className="helper">
            Tunes token budget, clarity checks, and safety rules for the selected domain.
          </div>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
            {pillDomains.map((d) => (
              <button
                key={d}
                type="button"
                className={`secondary${domain === d ? ' active-pill' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12, fontWeight: 500 }}
                onClick={() => setDomain(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Domain rules preview */}
        {rules && !rules._fallback && (
          <div className="rules-preview">
            <button
              type="button"
              className="rules-preview-toggle"
              onClick={() => setRulesOpen((o) => !o)}
            >
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                Rules for <strong>{rules.display_name}</strong>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                {rules.token_budget.min}–{rules.token_budget.max} tokens
                <span style={{ fontSize: 10 }}>{rulesOpen ? '▲' : '▼'}</span>
              </span>
            </button>
            {rulesOpen && (
              <div className="rules-preview-body">
                <PreviewSection label="PII risks"       items={rules.pii_risks.slice(0, 5)}           color="var(--danger)"  soft="var(--danger-soft)" />
                <PreviewSection label="Compliance"      items={rules.compliance.slice(0, 3)}           color="var(--warning)" soft="var(--warning-soft)" />
                <PreviewSection label="Clarity required" items={rules.clarity_requirements.slice(0, 3)} color="var(--info)"    soft="var(--info-soft)" />
                {rules.tone && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    <strong>Tone:</strong> {rules.tone}
                  </div>
                )}
                <div style={{ marginTop: 10, textAlign: 'right' }}>
                  <a href={`/rules/edit?domain=${rules.domain}`} style={{ fontSize: 12 }}>Edit these rules →</a>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Target model */}
        <div className="form-row" style={{ marginTop: 16 }}>
          <label>
            Target model&nbsp;
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>(optional)</span>
          </label>
          <div className="helper" style={{ marginBottom: 10 }}>
            Adjusts safety scoring, token budget, and the rewritten prompt for the model you&apos;ll deploy to.
          </div>

          {Object.entries(GROUPED_MODELS).map(([provider, models]) => (
            <div key={provider} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 5 }}>
                {provider}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`secondary${targetModel === m.id ? ' active-pill' : ''}`}
                    style={{ padding: '4px 10px', fontSize: 12, fontWeight: 500 }}
                    onClick={() => setTargetModel(targetModel === m.id ? '' : m.id)}
                  >
                    {m.display}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Model profile card */}
          {selectedModel && (
            <div className="rules-preview" style={{ marginTop: 6 }}>
              <div className="rules-preview-toggle" style={{ cursor: 'default' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{selectedModel.display}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  {selectedModel.context_window >= 1_000_000
                    ? `${(selectedModel.context_window / 1_000_000).toFixed(1)}M ctx`
                    : `${Math.round(selectedModel.context_window / 1000)}k ctx`}
                  <span className={`tag ${GUARDRAIL_TAG[selectedModel.guardrail]}`} style={{ fontSize: 11 }}>
                    {GUARDRAIL_LABEL[selectedModel.guardrail]}
                  </span>
                </span>
              </div>
              <div className="rules-preview-body" style={{ paddingTop: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  <strong>Format preference:</strong> {selectedModel.format_hint}
                </div>
                {selectedModel.guardrail_note && (
                  <div style={{
                    fontSize: 12,
                    color: selectedModel.guardrail === 'weak' ? 'var(--danger)' : 'var(--warning)',
                    background: selectedModel.guardrail === 'weak' ? 'var(--danger-soft)' : 'var(--warning-soft)',
                    padding: '6px 10px',
                    borderRadius: 6,
                  }}>
                    ⚠ {selectedModel.guardrail_note}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className="form-row" style={{ marginTop: 8 }}>
          <label htmlFor="prompt">Prompt</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Paste the prompt you want validated…"
            required
          />
          <div className="helper">
            {prompt.length > 0 ? (
              <>
                {prompt.length} chars · ~{estimatedTokens} tokens
                {rules && !rules._fallback && ` · budget ${rules.token_budget.min}–${rules.token_budget.max}`}
                {remainingCtx !== null && (
                  <span style={{ color: remainingCtx < 1000 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {' · '}{remainingCtx.toLocaleString()} ctx remaining
                  </span>
                )}
              </>
            ) : 'Plain text. Markdown OK.'}
          </div>
        </div>

        <div className="row between" style={{ marginTop: 24 }}>
          <span className="muted">Validation typically takes 15–25 s</span>
          <button type="submit" disabled={busy || !prompt.trim() || !domain.trim()}>
            {busy ? 'Submitting…' : 'Validate prompt →'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PreviewSection({ label, items, color, soft }: { label: string; items: string[]; color: string; soft: string }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color, marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {items.map((item, i) => (
          <div key={i} style={{ fontSize: 12, background: soft, color, padding: '3px 9px', borderRadius: 6 }}>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
