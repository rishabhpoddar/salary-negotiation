import { useEffect, useMemo, useState } from 'react';

type TimelineItem = {
  id: string;
  kind: 'funding' | 'liquidity';
  year: number;
  companyValueUsd?: number;
  valuationUsd?: number;
  dilutionPct?: number;
};

type TimelineLiquidityMetrics = TimelineItem & {
  roundsApplied: number;
  adjustedFinalOwnershipPct: number;
  nominalPayout: number;
  realPayout: number;
};

type LiveFx = {
  usdToInr: number;
  date: string | null;
  source: string;
  live: boolean;
};

const FALLBACK_USD_INR = 96;
const MODEL_STORAGE_KEY = 'salary-negotiation-model';

const newOfferDefaults = {
  salaryUsd: 100_000,
  equityUsd: 100_000,
  vestingYears: 4,
  valuationUsd: 300_000_000,
  inflationRatePct: 3.8,
};

const timelineDefaults: TimelineItem[] = [];

function createTimelineItemId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `timeline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type SavedModel = {
  salaryUsd?: number;
  equityUsd?: number;
  vestingYears?: number;
  valuationUsd?: number;
  inflationRatePct?: number;
  timelineItems?: TimelineItem[];
};

function loadSavedModel(): SavedModel {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SavedModel;
    return {
      salaryUsd: typeof parsed.salaryUsd === 'number' ? parsed.salaryUsd : undefined,
      equityUsd: typeof parsed.equityUsd === 'number' ? parsed.equityUsd : undefined,
      vestingYears: typeof parsed.vestingYears === 'number' ? parsed.vestingYears : undefined,
      valuationUsd: typeof parsed.valuationUsd === 'number' ? parsed.valuationUsd : undefined,
      inflationRatePct: typeof parsed.inflationRatePct === 'number' ? parsed.inflationRatePct : undefined,
      timelineItems: Array.isArray(parsed.timelineItems)
        ? parsed.timelineItems.map((item) => ({
            id: typeof item?.id === 'string' ? item.id : createTimelineItemId(),
            kind: item?.kind === 'liquidity' ? 'liquidity' : 'funding',
            year: typeof item?.year === 'number' ? item.year : 1,
            companyValueUsd: typeof item?.companyValueUsd === 'number' ? item.companyValueUsd : undefined,
            valuationUsd: typeof item?.valuationUsd === 'number' ? item.valuationUsd : undefined,
            dilutionPct: typeof item?.dilutionPct === 'number' ? item.dilutionPct : undefined,
          }))
        : undefined,
    };
  } catch {
    return {};
  }
}

function saveModel(model: SavedModel) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(model));
  } catch {
    // Ignore storage failures.
  }
}

function formatUsd(value: number, digits = 3) {
  if (!Number.isFinite(value)) return '$0';
  const abs = Math.abs(value);
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
  if (abs >= 1_000_000) return `$${formatter.format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `$${formatter.format(value / 1_000)}K`;
  return `$${formatter.format(value)}`;
}

function formatInr(value: number, digits = 3) {
  const formatter = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
  return `₹${formatter.format(value)}`;
}

function formatPct(value: number, digits = 3) {
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
  return `${formatter.format(value)}%`;
}

function formatCompactMoney(value: number) {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  const format = (scaled: number, suffix: string) => {
    const rounded = Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : scaled >= 1 ? 2 : 3);
    return `${sign}${rounded}${suffix}`;
  };

  if (abs >= 1_000_000_000) return format(abs / 1_000_000_000, 'B');
  if (abs >= 1_000_000) return format(abs / 1_000_000, 'M');
  if (abs >= 1_000) return format(abs / 1_000, 'K');
  return `${value}`;
}

function parseCompactMoney(input: string) {
  const cleaned = input.trim().replace(/[$,₹\s]/g, '').toLowerCase();
  if (!cleaned) return null;

  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (match) {
    const amount = Number(match[1]);
    const suffix = match[2];
    if (!Number.isFinite(amount)) return null;
    const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
    return amount * multiplier;
  }

  const plain = Number(cleaned);
  return Number.isFinite(plain) ? plain : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function fundingMultiplierBetweenYears(fundingRounds: TimelineItem[], fromYear: number, toYear: number) {
  const safeFromYear = Math.max(0, fromYear);
  const safeToYear = Math.max(safeFromYear, toYear);
  return fundingRounds
    .filter((item) => item.kind === 'funding' && item.year > safeFromYear && item.year <= safeToYear)
    .sort((a, b) => a.year - b.year)
    .reduce((multiplier, item) => multiplier * (1 - clamp(item.dilutionPct ?? 0, 0, 100) / 100), 1);
}

function vestedFractionAt(grantAgeYears: number, vestingYears: number) {
  const safeVest = Math.max(0.0001, vestingYears);
  return clamp(grantAgeYears / safeVest, 0, 1);
}

function equityOwnershipAtLiquidity(
  fundingRounds: TimelineItem[],
  liquidityYear: number,
  annualGrantOwnershipPct: number,
  vestingYears: number,
) {
  const safeLiquidityYear = Math.max(0, liquidityYear);
  let totalOwnershipPct = 0;

  for (let grantYear = 0; grantYear <= Math.floor(safeLiquidityYear + 1e-9); grantYear += 1) {
    const grantAge = safeLiquidityYear - grantYear;
    const vestedFraction = vestedFractionAt(grantAge, vestingYears);
    const dilutionMultiplier = fundingMultiplierBetweenYears(fundingRounds, grantYear, safeLiquidityYear);
    totalOwnershipPct += annualGrantOwnershipPct * vestedFraction * dilutionMultiplier;
  }

  return totalOwnershipPct;
}

function realTermsValue(nominalValue: number, yearsToLiquidity: number, inflationRatePct: number) {
  const safeYears = Math.max(0, yearsToLiquidity);
  const safeInflation = clamp(inflationRatePct, 0, 100);
  return nominalValue / Math.pow(1 + safeInflation / 100, safeYears);
}

function loadCachedFx(): LiveFx {
  if (typeof window === 'undefined') {
    return { usdToInr: FALLBACK_USD_INR, date: null, source: 'fallback', live: false };
  }

  try {
    const raw = window.localStorage.getItem('usd-inr-rate');
    if (!raw) return { usdToInr: FALLBACK_USD_INR, date: null, source: 'fallback', live: false };
    const parsed = JSON.parse(raw) as Partial<LiveFx> & { usdToInr?: number };
    if (!parsed.usdToInr) return { usdToInr: FALLBACK_USD_INR, date: null, source: 'fallback', live: false };
    return {
      usdToInr: parsed.usdToInr,
      date: parsed.date ?? null,
      source: parsed.source ?? 'cached',
      live: false,
    };
  } catch {
    return { usdToInr: FALLBACK_USD_INR, date: null, source: 'fallback', live: false };
  }
}

function FxPill({ fx }: { fx: LiveFx }) {
  return (
    <div className="fx-pill">
      <span>USD/INR</span>
      <strong>₹{fx.usdToInr.toFixed(3)}</strong>
      <small>
        {fx.live ? 'Live on page load' : fx.source === 'cached' ? 'Cached from prior load' : 'Fallback value'}
        {fx.date ? ` · ${fx.date}` : ''}
      </small>
    </div>
  );
}

function makeTimelineLabel(index: number, kind: TimelineItem['kind']) {
  return kind === 'funding' ? `Funding ${index + 1}` : `Liquidity ${index + 1}`;
}

function FieldCard({
  label,
  value,
  onChange,
  unit,
  question,
  hint,
  min,
  max,
  step,
  compact = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit: string;
  question: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  compact?: boolean;
}) {
  return (
    <label className="field-card">
      <div className="field-head">
        <div>
          <span>{label}</span>
          <small>{unit}</small>
        </div>
        <strong>{question}</strong>
      </div>
      <EditableNumberInput
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        placeholder={compact ? '3M' : ''}
        compact={compact}
      />
      <p>{hint}</p>
    </label>
  );
}

function EditableNumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  compact = false,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  placeholder?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(compact ? formatCompactMoney(value) : String(value));

  useEffect(() => {
    setDraft(compact ? formatCompactMoney(value) : String(value));
  }, [compact, value]);

  return (
    <input
      className="field-input"
      type="text"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);

        if (next.trim() === '') return;

        const parsed = compact ? parseCompactMoney(next) : Number(next);
        if (parsed !== null && Number.isFinite(parsed)) {
          onChange(clamp(parsed, min, max));
        }
      }}
      onBlur={() => {
        const parsed = compact ? parseCompactMoney(draft) : Number(draft);
        const nextValue = parsed === null || !Number.isFinite(parsed) ? value : clamp(parsed, min, max);
        setDraft(compact ? formatCompactMoney(nextValue) : String(nextValue));
        onChange(nextValue);
      }}
    />
  );
}

function TimelineEditor({
  items,
  onChange,
}: {
  items: TimelineItem[];
  onChange: (next: TimelineItem[]) => void;
}) {
  const updateItem = (index: number, patch: Partial<TimelineItem>) => {
    onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  const addItem = (kind: TimelineItem['kind']) => {
    const sameKindItems = items.filter((item) => item.kind === kind);
    const lastItem = sameKindItems[sameKindItems.length - 1];
    const nextYear = lastItem ? lastItem.year + 1 : 1;

    onChange([
      ...items,
      {
        id: createTimelineItemId(),
        kind,
        year: Number(nextYear.toFixed(3)),
        ...(kind === 'funding'
          ? {
            valuationUsd: lastItem?.valuationUsd ? lastItem.valuationUsd * 2 : 500_000_000,
            dilutionPct: lastItem ? Math.max(4, (lastItem.dilutionPct ?? 12) - 2) : 12,
          }
          : {
            companyValueUsd: lastItem?.companyValueUsd ? lastItem.companyValueUsd * 2 : 1_000_000_000,
          }),
      },
    ]);
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    onChange(items.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Funding + liquidity timeline</h2>
        <p>
          Add funding rounds and liquidity events in one timeline. Each liquidity row uses the funding rounds that happen before it.
        </p>
      </div>
      <div className="timeline-table">
        <div className="timeline-table-head">
          <span>Type</span>
          <span>Year from now (y)</span>
          <span>Value (USD)</span>
          <span>Dilution (%)</span>
          <span />
        </div>
        {items.length === 0 ? (
          <div className="timeline-empty">
            <strong>No timeline items yet.</strong>
            <p>Add a funding round or a liquidity event to start building the path.</p>
          </div>
        ) : null}
        {items.map((item, index) => (
          <div key={item.id} className="timeline-table-row">
            <label className="timeline-cell">
              <span className="timeline-label">Type</span>
              <select
                className="field-input"
                value={item.kind}
                onChange={(event) => {
                  const kind = event.currentTarget.value as TimelineItem['kind'];
                  updateItem(index, {
                    kind,
                    valuationUsd: kind === 'funding' ? item.valuationUsd ?? 500_000_000 : undefined,
                    dilutionPct: kind === 'funding' ? item.dilutionPct ?? 12 : undefined,
                    companyValueUsd: kind === 'liquidity' ? item.companyValueUsd ?? 1_000_000_000 : undefined,
                  });
                }}
              >
                <option value="funding">Funding</option>
                <option value="liquidity">Liquidity</option>
              </select>
            </label>
            <label className="timeline-cell">
              <span className="timeline-label">Year from now (y)</span>
              <EditableNumberInput
                value={item.year}
                onChange={(nextYear) => updateItem(index, { year: nextYear })}
                min={0}
                max={15}
                step={0.1}
              />
            </label>
            <label className="timeline-cell">
              <span className="timeline-label">Value (USD)</span>
              {item.kind === 'funding' ? (
                <EditableNumberInput
                  value={item.valuationUsd ?? 0}
                  onChange={(nextValue) => updateItem(index, { valuationUsd: nextValue })}
                  min={0}
                  max={100_000_000_000}
                  step={1_000_000}
                  compact
                  placeholder="500M"
                />
              ) : (
                <EditableNumberInput
                  value={item.companyValueUsd ?? 0}
                  onChange={(nextValue) => updateItem(index, { companyValueUsd: nextValue })}
                  min={0}
                  max={100_000_000_000}
                  step={1_000_000}
                  compact
                  placeholder="1B"
                />
              )}
            </label>
            <label className="timeline-cell">
              <span className="timeline-label">
                {item.kind === 'funding' ? 'Dilution (%)' : 'No extra field'}
              </span>
              {item.kind === 'funding' ? (
                <EditableNumberInput
                  value={item.dilutionPct ?? 0}
                  onChange={(nextValue) => updateItem(index, { dilutionPct: nextValue })}
                  min={0}
                  max={40}
                  step={0.5}
                  placeholder="12"
                />
              ) : (
                <div className="field-input field-input-disabled">—</div>
              )}
            </label>
            <div className="timeline-cell timeline-actions">
              <span className="timeline-label">Action</span>
              <button type="button" className="timeline-remove" onClick={() => removeItem(index)} disabled={items.length <= 1}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="timeline-footer">
        <div className="timeline-add-group">
          <button type="button" className="timeline-add" onClick={() => addItem('funding')}>
            + Add funding round
          </button>
          <button type="button" className="timeline-add" onClick={() => addItem('liquidity')}>
            + Add liquidity event
          </button>
        </div>
        <p>
          Funding rows change ownership. Liquidity rows define the possible exit events and probabilities. The table below is derived
          only from the liquidity rows.
        </p>
      </div>
    </section>
  );
}

export default function App() {
  const [fx, setFx] = useState<LiveFx>(loadCachedFx());
  const savedModel = useMemo(() => loadSavedModel(), []);
  const [newSalaryUsd, setNewSalaryUsd] = useState(() => savedModel.salaryUsd ?? newOfferDefaults.salaryUsd);
  const [newEquityUsd, setNewEquityUsd] = useState(() => savedModel.equityUsd ?? newOfferDefaults.equityUsd);
  const [vestingYears, setVestingYears] = useState(() => savedModel.vestingYears ?? newOfferDefaults.vestingYears);
  const [newValuationUsd, setNewValuationUsd] = useState(() => savedModel.valuationUsd ?? newOfferDefaults.valuationUsd);
  const [newInflationRatePct, setNewInflationRatePct] = useState(
    () => savedModel.inflationRatePct ?? newOfferDefaults.inflationRatePct,
  );
  const [timelineItems, setTimelineItems] = useState<TimelineItem[]>(() =>
    (savedModel.timelineItems ?? timelineDefaults).map((item) => ({
      ...item,
      id: item.id ?? createTimelineItemId(),
    })),
  );

  useEffect(() => {
    let active = true;

    async function fetchFx() {
      try {
        const response = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const data = (await response.json()) as { date?: string; rates?: { INR?: number } };
        const usdToInr = data.rates?.INR;
        if (!active || !usdToInr) return;

        const nextFx: LiveFx = {
          usdToInr,
          date: data.date ?? null,
          source: 'frankfurter.dev',
          live: true,
        };

        window.localStorage.setItem('usd-inr-rate', JSON.stringify(nextFx));
        setFx(nextFx);
      } catch {
        // Keep cached/fallback value if live fetch fails.
      }
    }

    void fetchFx();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    saveModel({
      salaryUsd: newSalaryUsd,
      equityUsd: newEquityUsd,
      vestingYears,
      valuationUsd: newValuationUsd,
      inflationRatePct: newInflationRatePct,
      timelineItems,
    });
  }, [newSalaryUsd, newEquityUsd, vestingYears, newValuationUsd, newInflationRatePct, timelineItems]);

  const liquidityItems = useMemo(
    () =>
      timelineItems.filter(
        (item): item is TimelineItem & { kind: 'liquidity'; companyValueUsd: number } =>
          item.kind === 'liquidity' && typeof item.companyValueUsd === 'number',
      ),
    [timelineItems],
  );
  const fundingItems = useMemo(
    () =>
      timelineItems.filter(
        (item): item is TimelineItem & { kind: 'funding'; valuationUsd: number; dilutionPct: number } =>
          item.kind === 'funding' && typeof item.valuationUsd === 'number' && typeof item.dilutionPct === 'number',
      ),
    [timelineItems],
  );
  const annualGrantOwnershipPct = (newEquityUsd / newValuationUsd) * 100;
  const newOutcomeRows = useMemo<TimelineLiquidityMetrics[]>(
    () =>
      liquidityItems.map((outcome) => {
        const adjustedFinalOwnershipPct = equityOwnershipAtLiquidity(
          fundingItems,
          outcome.year,
          annualGrantOwnershipPct,
          vestingYears,
        );
        const nominalPayout = (outcome.companyValueUsd ?? 0) * (adjustedFinalOwnershipPct / 100);
        const realPayout = realTermsValue(nominalPayout, outcome.year, newInflationRatePct);
        return {
          ...outcome,
          roundsApplied: fundingItems.filter((round) => round.year <= outcome.year).length,
          adjustedFinalOwnershipPct,
          nominalPayout,
          realPayout,
        };
      }),
    [fundingItems, liquidityItems, newEquityUsd, newInflationRatePct, newValuationUsd, vestingYears],
  );
  const salaryInUsd = newSalaryUsd;

  return (
    <div className="page-shell">
      <main className="layout">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Startup compensation decision model</p>
            <h1>Offer, funding timeline, liquidity outcomes.</h1>
            <p className="hero-text">
              This sheet models one offer. You can specify the future funding path separately, then see how much dilution happens before
              each possible exit.
            </p>
          </div>

          <aside className="summary-panel">
            <div className="summary-badge">Offer only</div>
            <FxPill fx={fx} />
          </aside>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Offer inputs</h2>
            <p>Salary, equity grant, current valuation, and inflation assumptions for the offer.</p>
          </div>
          <div className="field-grid">
            <FieldCard
              label="Salary"
              unit="USD / year"
              value={newSalaryUsd}
              onChange={setNewSalaryUsd}
              question="What is the annual cash salary in US dollars?"
              hint="Set to zero if this is equity-only."
              min={0}
              max={500_000}
              step={5_000}
              compact
            />
            <FieldCard
              label="Annual equity grant value"
              unit="USD at today's valuation"
              value={newEquityUsd}
              onChange={setNewEquityUsd}
              question="What is the annual equity grant worth at the current valuation?"
              hint={`This is granted every year and is about ${formatPct(annualGrantOwnershipPct, 3)} of the company at today's valuation.`}
              min={0}
              max={2_000_000}
              step={5_000}
              compact
            />
            <FieldCard
              label="Vesting period"
              unit="years"
              value={vestingYears}
              onChange={setVestingYears}
              question="How many years does each grant take to vest?"
              hint="Each yearly grant starts vesting from its grant date."
              min={1}
              max={5}
              step={0.5}
            />
            <FieldCard
              label="Company valuation"
              unit="USD"
              value={newValuationUsd}
              onChange={setNewValuationUsd}
              question="What is the company currently valued at?"
              hint="This converts dollar grant value into ownership percentage."
              min={10_000_000}
              max={10_000_000_000}
              step={10_000_000}
              compact
            />
            <FieldCard
              label="Inflation rate"
              unit="% per year"
              value={newInflationRatePct}
              onChange={setNewInflationRatePct}
              question="What inflation rate should I assume over the holding period?"
              hint="Used only for the real-terms cash-out column."
              min={0}
              max={20}
              step={0.1}
            />
          </div>
        </section>

        <TimelineEditor items={timelineItems} onChange={setTimelineItems} />

        <section className="panel">
          <div className="panel-head">
            <h2>Liquidation outcomes</h2>
            <p>Each liquidity item is evaluated after all funding rounds that happen before its year.</p>
          </div>
          <div className="liquidity-table">
            {newOutcomeRows.length === 0 ? (
              <div className="liquidity-empty">
                <strong>No liquidity events yet.</strong>
                <p>Add one or more liquidity items in the timeline above to see liquidation outcomes.</p>
              </div>
            ) : (
              <>
                <div className="liquidity-table-head">
                  <span>Liquidity event</span>
                  <span>Exit year (y)</span>
                  <span>Company worth (USD)</span>
                  <span>Rounds</span>
                  <span>Final ownership (%)</span>
                  <span>Nominal cash-out (USD)</span>
                  <span>Real cash-out (USD)</span>
                </div>
                {newOutcomeRows.map((row, index) => (
                  <div key={row.id} className="liquidity-table-row">
                    <div className="liquidity-cell liquidity-cell-title">
                      <span className="liquidity-label">Liquidity event</span>
                      <strong>{makeTimelineLabel(index, 'liquidity')}</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Exit year (y)</span>
                      <strong>{row.year.toFixed(3)}y</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Company worth (USD)</span>
                      <strong>{formatUsd(row.companyValueUsd ?? 0, 3)}</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Rounds</span>
                      <strong>{row.roundsApplied}</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Final ownership (%)</span>
                      <strong>{formatPct(row.adjustedFinalOwnershipPct, 3)}</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Nominal cash-out (USD)</span>
                      <strong>{formatUsd(row.nominalPayout, 3)}</strong>
                    </div>
                    <div className="liquidity-cell">
                      <span className="liquidity-label">Real cash-out (USD)</span>
                      <strong>{formatUsd(row.realPayout, 3)}</strong>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
