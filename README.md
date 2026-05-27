# Salary Negotiation Cockpit

A Vite + React app for modeling startup compensation and liquidity outcomes.

It is built for situations where you want to reason about:

- salary in USD
- annual equity grant value
- vesting period
- current company valuation
- future funding rounds and dilution
- liquidity events such as IPOs, buybacks, or exits
- nominal vs inflation-adjusted payout

## Features

- Editable timeline with two item types:
  - `Funding` rows affect dilution
  - `Liquidity` rows define exit events
- Deterministic liquidation math
- Compact money entry like `3M`, `250k`, or `1.2B`
- Live USD/INR fetch on page load with local fallback
- Local persistence in `localStorage`
- Responsive layout for desktop and mobile

## Run It

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## How It Works

### Offer inputs

- `Salary` is annual cash salary in USD.
- `Annual equity grant value` is the dollar value of the yearly grant at the current valuation.
- `Vesting period` is how long each annual grant takes to vest.
- `Company valuation` is the current valuation used to convert dollar grant value into ownership percentage.
- `Inflation rate` is used to show real terms alongside nominal cash-out.

### Timeline

Add timeline items in order:

- `Funding` items
  - affect dilution
  - require `year from now`, `value`, and `dilution`
- `Liquidity` items
  - represent exit events
  - require `year from now` and `company worth`

The app applies only the funding rounds that happen before each liquidity event.

Equity is modeled as a yearly grant stream:

- a new grant is issued every year
- each grant vests linearly over the vesting period
- each grant is diluted by any funding rounds that happen after it is granted

### Outputs

For each liquidity event the app shows:

- final ownership
- nominal cash-out
- real cash-out
- how many funding rounds were applied before that exit

## Persistence

The form state is saved automatically in `localStorage` under:

- `salary-negotiation-model`

This means reloading the page restores the last entered values.

The live USD/INR FX rate is cached separately under:

- `usd-inr-rate`

## Tech Stack

- React 19
- TypeScript
- Vite

## Notes

- The app intentionally keeps the model simple and deterministic.
- It does not currently model liquidation preferences, strike prices, taxes, or secondary liquidity.
