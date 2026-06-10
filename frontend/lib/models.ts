export type ModelProfile = {
  id: string;
  display: string;
  provider: string;
  context_window: number;
  tokens_per_word: number;
  guardrail: 'strong' | 'moderate' | 'weak';
  guardrail_note?: string;
  format_hint: string;
};

export const MODELS: ModelProfile[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  { id: 'claude-opus-4',     display: 'Claude Opus 4',     provider: 'Anthropic', context_window: 200000, tokens_per_word: 1.30, guardrail: 'strong', format_hint: 'XML tags, extended thinking, long-form reasoning' },
  { id: 'claude-sonnet-4',   display: 'Claude Sonnet 4.5', provider: 'Anthropic', context_window: 200000, tokens_per_word: 1.30, guardrail: 'strong', format_hint: 'XML tags, natural language instructions, markdown' },
  { id: 'claude-haiku-4',    display: 'Claude Haiku 4.5',  provider: 'Anthropic', context_window: 200000, tokens_per_word: 1.30, guardrail: 'strong', format_hint: 'XML tags, concise instructions, structured output' },
  { id: 'claude-sonnet-3-5', display: 'Claude 3.5 Sonnet', provider: 'Anthropic', context_window: 200000, tokens_per_word: 1.30, guardrail: 'strong', format_hint: 'XML tags, natural language, markdown' },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { id: 'gpt-4.1',      display: 'GPT-4.1',      provider: 'OpenAI', context_window: 1047576, tokens_per_word: 1.25, guardrail: 'strong',   format_hint: 'Numbered steps, structured markdown, role assignment' },
  { id: 'gpt-4.1-mini', display: 'GPT-4.1 mini', provider: 'OpenAI', context_window: 1047576, tokens_per_word: 1.25, guardrail: 'strong',   format_hint: 'Numbered steps, explicit format specs' },
  { id: 'o3',           display: 'o3',            provider: 'OpenAI', context_window: 200000,  tokens_per_word: 1.25, guardrail: 'strong',   format_hint: 'Clear problem statements — avoid step-by-step handholding; let model reason', guardrail_note: 'Reasoning model — over-prompting degrades output; keep system prompts minimal' },
  { id: 'o4-mini',      display: 'o4-mini',       provider: 'OpenAI', context_window: 200000,  tokens_per_word: 1.25, guardrail: 'strong',   format_hint: 'Concise problem statements, STEM and code tasks', guardrail_note: 'Efficient reasoning model — best for well-scoped technical tasks' },
  { id: 'gpt-4o',       display: 'GPT-4o',        provider: 'OpenAI', context_window: 128000,  tokens_per_word: 1.25, guardrail: 'strong',   format_hint: 'Numbered steps, role assignment, markdown' },
  { id: 'gpt-4o-mini',  display: 'GPT-4o mini',   provider: 'OpenAI', context_window: 128000,  tokens_per_word: 1.25, guardrail: 'moderate', format_hint: 'Numbered steps, explicit format specs', guardrail_note: 'Moderate guardrails — safety scoring applied stricter than GPT-4o' },
  // ── Meta ───────────────────────────────────────────────────────────────────
  { id: 'llama-4-maverick', display: 'Llama 4 Maverick', provider: 'Meta', context_window: 1000000, tokens_per_word: 1.40, guardrail: 'weak', format_hint: 'Natural conversational prompts, multimodal capable', guardrail_note: 'No built-in safety filters — injection and harmful content not blocked at runtime; scored strictly' },
  { id: 'llama-4-scout',    display: 'Llama 4 Scout',    provider: 'Meta', context_window: 10000000, tokens_per_word: 1.40, guardrail: 'weak', format_hint: 'Direct instructions, extremely long context capable',  guardrail_note: 'No safety filters — 10M token context but weak guardrails; strictest safety scoring applied' },
  { id: 'llama-3.1-70b',    display: 'Llama 3.1 70B',    provider: 'Meta', context_window: 128000,   tokens_per_word: 1.40, guardrail: 'weak', format_hint: 'Direct flat instructions, avoid XML tags', guardrail_note: 'No built-in safety filters — injection risks scored significantly stricter' },
  // ── Google ─────────────────────────────────────────────────────────────────
  { id: 'gemini-2.5-pro',   display: 'Gemini 2.5 Pro',   provider: 'Google', context_window: 1000000, tokens_per_word: 1.30, guardrail: 'strong',   format_hint: 'Natural language, deep reasoning, long-context analysis' },
  { id: 'gemini-2.5-flash', display: 'Gemini 2.5 Flash', provider: 'Google', context_window: 1000000, tokens_per_word: 1.30, guardrail: 'strong',   format_hint: 'Concise natural language, fast multimodal tasks' },
  { id: 'gemini-2.0-flash', display: 'Gemini 2.0 Flash', provider: 'Google', context_window: 1000000, tokens_per_word: 1.30, guardrail: 'moderate', format_hint: 'Natural language, agentic tasks', guardrail_note: 'Moderate guardrails — apply stricter safety scoring' },
  { id: 'gemini-1.5-pro',   display: 'Gemini 1.5 Pro',   provider: 'Google', context_window: 1000000, tokens_per_word: 1.30, guardrail: 'strong',   format_hint: 'Natural language, markdown, handles long context well' },
  // ── Mistral ────────────────────────────────────────────────────────────────
  { id: 'mistral-large-2', display: 'Mistral Large 2', provider: 'Mistral', context_window: 128000, tokens_per_word: 1.35, guardrail: 'moderate', format_hint: 'Markdown, numbered steps, explicit instructions', guardrail_note: 'Moderate guardrails — more conservative safety scoring applies' },
  { id: 'mistral-small-3', display: 'Mistral Small 3', provider: 'Mistral', context_window: 32000,  tokens_per_word: 1.35, guardrail: 'moderate', format_hint: 'Simple structured prompts, avoid complex nesting', guardrail_note: 'Moderate guardrails + limited context — keep prompts concise' },
  { id: 'codestral',       display: 'Codestral',       provider: 'Mistral', context_window: 256000, tokens_per_word: 1.20, guardrail: 'moderate', format_hint: 'Code-focused instructions, specify language and task clearly', guardrail_note: 'Code-specialist model — optimise prompts for programming tasks only' },
];

export const MODEL_PROVIDERS = [...new Set(MODELS.map((m) => m.provider))];

export function getModel(id: string): ModelProfile | undefined {
  return MODELS.find((m) => m.id === id);
}

export function groupByProvider(): Record<string, ModelProfile[]> {
  return MODELS.reduce<Record<string, ModelProfile[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});
}

export const GUARDRAIL_LABEL: Record<ModelProfile['guardrail'], string> = {
  strong:   'Strong guardrails',
  moderate: 'Moderate guardrails',
  weak:     'Weak guardrails',
};

export const GUARDRAIL_TAG: Record<ModelProfile['guardrail'], string> = {
  strong:   'LOW',
  moderate: 'MED',
  weak:     'HIGH',
};
