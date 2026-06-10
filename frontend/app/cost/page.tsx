'use client';
import { useState, useMemo } from 'react';

/* ---- Bedrock on-demand pricing (us-east-1, 2025) per token ---- */
const P = {
  haiku: {
    input:      0.80  / 1_000_000,
    output:     4.00  / 1_000_000,
    cacheRead:  0.08  / 1_000_000,  // 10 % of input
    cacheWrite: 1.00  / 1_000_000,  // 125 % of input
  },
  sonnet: {
    input:      3.00  / 1_000_000,
    output:    15.00  / 1_000_000,
    cacheRead:  0.30  / 1_000_000,
    cacheWrite: 3.75  / 1_000_000,
  },
};

/* ---- System-prompt sizes (tokens) for each specialist call ---- */
const SYS = {
  tokenCheck:  650,   // haiku
  verifyFix:   520,   // haiku
  clarityCheck:1050,  // sonnet
  safetyCheck: 1050,  // sonnet
  suggest:      820,  // sonnet
  refine:       840,  // sonnet
};

/* ---- Lambda pricing ---- */
const LAMBDA_REQ   = 0.20 / 1_000_000;  // per request
const LAMBDA_GB_S  = 0.0000166667;      // per GB-second
const LAMBDA_FREE_GB_S = 400_000;
const LAMBDA_FREE_REQS = 1_000_000;

/* ---- Step Functions ---- */
const SFN_PER_TRANSITION = 0.025 / 1000; // standard workflow

function calcCost(
  promptTokens: number,
  rulesTokens: number,
  refinements: number,
  cacheHitPct: number,   // 0-1
  monthlyVolume: number,
) {
  const userTokens = promptTokens + rulesTokens;
  const cacheMult  = cacheHitPct;           // fraction using cached reads
  const freshMult  = 1 - cacheHitPct;       // fraction paying full input price

  /* Helper: cost for one LLM call */
  const haikuCall = (sysTokens: number, inTokens: number, outTokens: number) => {
    const sysInput = sysTokens * (cacheMult * P.haiku.cacheRead + freshMult * P.haiku.input);
    return sysInput + inTokens * P.haiku.input + outTokens * P.haiku.output;
  };
  const sonnetCall = (sysTokens: number, inTokens: number, outTokens: number) => {
    const sysInput = sysTokens * (cacheMult * P.sonnet.cacheRead + freshMult * P.sonnet.input);
    return sysInput + inTokens * P.sonnet.input + outTokens * P.sonnet.output;
  };

  /* ---- One aggregation pass ---- */
  const oneAgg = () =>
    haikuCall(SYS.tokenCheck,  userTokens,  100) +
    haikuCall(SYS.verifyFix,   promptTokens,  80) +
    sonnetCall(SYS.clarityCheck, userTokens, 150) +
    sonnetCall(SYS.safetyCheck,  userTokens, 150) +
    sonnetCall(SYS.suggest,      promptTokens, 200);

  /* ---- Per prompt: initial agg + N refinement loops ---- */
  let perPrompt = oneAgg();
  for (let i = 0; i < refinements; i++) {
    // refinement rewrite (Sonnet)
    perPrompt += sonnetCall(SYS.refine, promptTokens + 250, promptTokens);
    // re-aggregate after each refinement
    perPrompt += oneAgg();
  }

  /* ---- Bedrock monthly ---- */
  const bedrockMonthly = perPrompt * monthlyVolume;

  /* ---- Lambda monthly ---- */
  // 3 lambdas per validation: intake + aggregator (once per agg) + refinement(s)
  const aggInvokes = 1 + refinements;
  const lambdaReqs = (3 + refinements) * monthlyVolume;
  const lambdaGbS  =
    monthlyVolume * (
      0.512 * 1.5 +          // intake 512MB ~1.5s
      1.024 * 8 * aggInvokes + // aggregator 1024MB ~8s per agg
      (refinements > 0 ? 1.024 * 4 * refinements : 0) // refinement 1024MB ~4s
    );
  const billableReqs = Math.max(0, lambdaReqs - LAMBDA_FREE_REQS);
  const billableGbS  = Math.max(0, lambdaGbS  - LAMBDA_FREE_GB_S);
  const lambdaMonthly = billableReqs * LAMBDA_REQ + billableGbS * LAMBDA_GB_S;

  /* ---- Step Functions monthly ---- */
  // ~8 base transitions + 4 per refinement
  const transitions = (8 + 4 * refinements) * monthlyVolume;
  const sfnMonthly  = transitions * SFN_PER_TRANSITION;

  const total = bedrockMonthly + lambdaMonthly + sfnMonthly;

  /* ---- Per-call breakdown (for table) ---- */
  const haikuInputCost  = monthlyVolume * (
    haikuCall(SYS.tokenCheck, userTokens, 0) + haikuCall(SYS.verifyFix, promptTokens, 0)
  ) * (1 + refinements);
  const haikuOutputCost = monthlyVolume * (
    haikuCall(0, 0, 100) + haikuCall(0, 0, 80)
  ) * (1 + refinements);
  const sonnetInputCost = monthlyVolume * (
    sonnetCall(SYS.clarityCheck, userTokens, 0) +
    sonnetCall(SYS.safetyCheck, userTokens, 0) +
    sonnetCall(SYS.suggest, promptTokens, 0) +
    (refinements > 0 ? sonnetCall(SYS.refine, promptTokens + 250, 0) * refinements : 0)
  );
  const sonnetOutputCost = monthlyVolume * (
    sonnetCall(0, 0, 150) + sonnetCall(0, 0, 150) + sonnetCall(0, 0, 200) +
    (refinements > 0 ? sonnetCall(0, 0, promptTokens) * refinements : 0)
  );

  return {
    perPrompt,
    bedrockMonthly,
    lambdaMonthly,
    sfnMonthly,
    total,
    breakdown: {
      haikuInput: haikuInputCost,
      haikuOutput: haikuOutputCost,
      sonnetInput: sonnetInputCost,
      sonnetOutput: sonnetOutputCost,
    },
    lambdaReqs,
    lambdaGbS,
    transitions,
  };
}

const fmt = (n: number, decimals = 2) =>
  n < 0.001 ? `< $0.001` : `$${n.toFixed(decimals)}`;

const fmtBig = (n: number) => {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
};

function Slider({
  label, hint, min, max, step, value, onChange, format,
}: {
  label: string; hint?: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; format: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="cost-slider-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)' }}>{format(value)}</span>
      </div>
      {hint && <div className="helper" style={{ marginBottom: 8 }}>{hint}</div>}
      <div className="cost-track">
        <div className="cost-track-fill" style={{ width: `${pct}%` }} />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="cost-range"
        />
      </div>
    </div>
  );
}

function StatBox({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`cost-stat${accent ? ' cost-stat-accent' : ''}`}>
      <div className="cost-stat-val">{value}</div>
      <div className="cost-stat-label">{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function CostPage() {
  const [volume,      setVolume]      = useState(1000);
  const [promptToks,  setPromptToks]  = useState(200);
  const [refinements, setRefinements] = useState(1);
  const [cacheHit,    setCacheHit]    = useState(0.85);

  const rulesTokens = 250; // avg domain rules injected in user message

  const result = useMemo(
    () => calcCost(promptToks, rulesTokens, refinements, cacheHit, volume),
    [volume, promptToks, refinements, cacheHit],
  );

  const rows = [
    { service: 'Haiku — input (incl. cached sys-prompt)', cost: result.breakdown.haikuInput,  share: result.breakdown.haikuInput  / result.total },
    { service: 'Haiku — output',                          cost: result.breakdown.haikuOutput, share: result.breakdown.haikuOutput / result.total },
    { service: 'Sonnet — input (incl. cached sys-prompt)',cost: result.breakdown.sonnetInput, share: result.breakdown.sonnetInput / result.total },
    { service: 'Sonnet — output',                         cost: result.breakdown.sonnetOutput,share: result.breakdown.sonnetOutput/ result.total },
    { service: 'Lambda compute',                          cost: result.lambdaMonthly,          share: result.lambdaMonthly / result.total },
    { service: 'Step Functions transitions',              cost: result.sfnMonthly,             share: result.sfnMonthly / result.total },
  ];

  const cacheLabel = `${Math.round(cacheHit * 100)}%`;

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ marginBottom: 8 }}>Cost calculator</h1>
        <p className="muted">
          Estimates based on AWS Bedrock on-demand pricing (us-east-1, 2025). Prompt caching
          reduces system-prompt input cost by 90 % on cache hits.
        </p>
      </div>

      <div className="cost-layout">
        {/* ---- Left: sliders ---- */}
        <div className="cost-inputs card">
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 18 }}>Parameters</div>

          <Slider
            label="Monthly validations"
            hint="Number of prompts validated per month."
            min={100} max={50000} step={100}
            value={volume}
            onChange={setVolume}
            format={(v) => v.toLocaleString()}
          />

          <Slider
            label="Avg prompt length"
            hint="Approximate tokens in each submitted prompt (1 token ≈ 0.75 words)."
            min={50} max={1000} step={10}
            value={promptToks}
            onChange={setPromptToks}
            format={(v) => `${v} tokens`}
          />

          <Slider
            label="Avg refinement rounds"
            hint="Automatic rewrites before approval. 0 = no refinement; max is 3."
            min={0} max={3} step={1}
            value={refinements}
            onChange={setRefinements}
            format={(v) => v === 0 ? 'None' : v === 1 ? '1 round' : `${v} rounds`}
          />

          <Slider
            label="Prompt-cache hit rate"
            hint="System prompts are cached in Bedrock. Higher volume → higher hit rate."
            min={0} max={1} step={0.05}
            value={cacheHit}
            onChange={setCacheHit}
            format={() => cacheLabel}
          />

          <div className="cost-pricing-note">
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Model pricing used</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11 }}>
              <span className="muted">Haiku 4.5 input</span><span>$0.80 / 1M tok</span>
              <span className="muted">Haiku 4.5 output</span><span>$4.00 / 1M tok</span>
              <span className="muted">Haiku cache read</span><span>$0.08 / 1M tok</span>
              <span className="muted">Sonnet 4.5 input</span><span>$3.00 / 1M tok</span>
              <span className="muted">Sonnet 4.5 output</span><span>$15.00 / 1M tok</span>
              <span className="muted">Sonnet cache read</span><span>$0.30 / 1M tok</span>
            </div>
          </div>
        </div>

        {/* ---- Right: summary ---- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card cost-summary-card">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Monthly estimate</div>
            <div className="cost-stat-grid">
              <StatBox label="Per prompt" value={fmt(result.perPrompt, 4)} accent />
              <StatBox label="Bedrock" value={fmtBig(result.bedrockMonthly)} sub="model calls" />
              <StatBox label="Lambda" value={fmtBig(result.lambdaMonthly)} sub="compute" />
              <StatBox label="Step Functions" value={fmtBig(result.sfnMonthly)} sub="transitions" />
            </div>
            <div className="cost-total-bar">
              <span>Total / month</span>
              <span className="cost-total-val">{fmtBig(result.total)}</span>
            </div>
          </div>

          {/* Volume comparison */}
          <div className="card">
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14 }}>At different volumes</div>
            {[100, 1000, 5000, 25000].map((v) => {
              const r = calcCost(promptToks, rulesTokens, refinements, cacheHit, v);
              const isSelected = v === volume;
              return (
                <div key={v} className={`cost-vol-row${isSelected ? ' cost-vol-active' : ''}`}
                  onClick={() => setVolume(v)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setVolume(v)}
                >
                  <span>{v.toLocaleString()} validations / mo</span>
                  <span style={{ fontWeight: 700 }}>{fmtBig(r.total)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---- Breakdown table ---- */}
      <div className="card" style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>Cost breakdown</div>
        <div className="cost-table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th>Component</th>
                <th style={{ textAlign: 'right' }}>Monthly cost</th>
                <th style={{ textAlign: 'right' }}>Share</th>
                <th style={{ minWidth: 140 }}>Bar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.service}>
                  <td>{row.service}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtBig(row.cost)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {result.total > 0 ? `${(row.share * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td>
                    <div className="cost-bar-cell">
                      <div className="cost-bar-fill" style={{ width: `${Math.max(1, row.share * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtBig(result.total)}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>100%</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-faint)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          Lambda free tier ({(1_000_000).toLocaleString()} req + 400,000 GB-s/mo) applied. Step Functions
          standard-workflow pricing. Estimates exclude data-transfer, API Gateway, CloudWatch, and S3 costs
          (all &lt; $1/mo at typical volumes). Actual costs may vary with warm-start behaviour and cache TTL.
        </div>
      </div>
    </div>
  );
}
