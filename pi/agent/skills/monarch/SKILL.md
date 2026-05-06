---
name: monarch
description: "Query the Monarch Money GraphQL API directly using the `gq` CLI. Use when the user wants account balances, transactions, budgets, cashflow, categories — without the Python library."
user_invocable: true
---

# Monarch GraphQL via gq

Endpoint: `https://api.monarch.com/graphql`. Token in `$MONARCH_TOKEN`. Introspection is **disabled** — rely on the catalog below or copy operations from browser DevTools (Network → `graphql`).

```bash
gq https://api.monarch.com/graphql \
  -H "authorization: Token $MONARCH_TOKEN" \
  -H "client-platform: web" \
  -q 'QUERY' -j 'VARIABLES_JSON'
```

For anything non-trivial: `--queryFile q.gql --variablesFile v.json`. For JSON output, use `curl ... | jq`.

All operations below are verified against the live API.

## Profile

### `Common_GetMe` — current user
```graphql
query Common_GetMe { me { id email name timezone } }
```

### `GetTrialStatus` — subscription / entitlements
```graphql
query GetTrialStatus {
  subscription { id hasPremiumEntitlement entitlements eligibleForTrial }
}
```

## Accounts

### `GetAccounts` — list all accounts
```graphql
query GetAccounts {
  accounts {
    id displayName currentBalance isAsset isHidden includeInNetWorth
    type { name display } subtype { name display }
    institution { id name }
  }
}
```

### `GetInstitutions` — connected credentials
```graphql
query GetInstitutions { credentials { id institution { id name } } }
```

## Transactions

### `GetTransactionsList` — paginated + filterable
```graphql
query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: $orderBy) {
      id amount date plaidName notes pending
      category { id name } merchant { id name } account { id displayName }
    }
  }
}
```
Variables:
```json
{"offset":0,"limit":100,"orderBy":"date",
 "filters":{"startDate":"2026-01-01","endDate":"2026-04-23","search":"","categories":[],"accounts":[],"tags":[]}}
```

### `GetTransactionDrawer($id: UUID!)` — single transaction
```graphql
query GetTransactionDrawer($id: UUID!) { getTransaction(id: $id) { id amount notes } }
```

## Categories & tags

### `GetCategories`
```graphql
query GetCategories { categories { id name group { id name type } } }
```

### `GetHouseholdTransactionTags`
```graphql
query GetHouseholdTransactionTags { householdTransactionTags { id name color order } }
```

## Budgets & goals

### `Common_GetJointPlanningData($startDate: Date!, $endDate: Date!)`
Planned vs actual per category per month.
```graphql
query Common_GetJointPlanningData($startDate: Date!, $endDate: Date!) {
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory {
      category { id name }
      monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount }
    }
  }
  categoryGroups { id name type }
}
```
Variables: `{"startDate":"2026-04-01","endDate":"2026-04-30"}`

### `GetGoalsV2`
```graphql
query GetGoalsV2 { goalsV2 { id name targetAmount currentAmount } }
```

### `Common_GetBudgetStatus` — does the user have a budget set up
```graphql
query Common_GetBudgetStatus {
  budgetStatus { hasBudget hasTransactions willCreateBudgetFromEmptyDefaultCategories }
}
```

## Cashflow & net worth

### `Web_GetCashFlowPage($filters: TransactionFilterInput)`
Income / expense / savings, groupable.
```graphql
query Web_GetCashFlowPage($filters: TransactionFilterInput) {
  summary: aggregates(filters: $filters) {
    summary { sumIncome sumExpense savings savingsRate }
  }
  byCategory: aggregates(filters: $filters, groupBy: ["category"]) {
    groupBy { category { id name } }
    summary { sum }
  }
}
```
Variables: `{"filters":{"startDate":"2026-04-01","endDate":"2026-04-23"}}`

### `Web_GetAggregateSnapshots($filters: AggregateSnapshotFilters)`
Net worth time series.
```graphql
query Web_GetAggregateSnapshots($filters: AggregateSnapshotFilters) {
  aggregateSnapshots(filters: $filters) {
    date balance assetsBalance liabilitiesBalance
  }
}
```
Variables: `{"filters":{"startDate":"2026-01-01","endDate":"2026-04-23"}}`

### `snapshotsByAccountType($startDate: Date!, $timeframe: Timeframe!)`
Balance over time bucketed by account type. `Timeframe`: `day` | `week` | `month` | `quarter` | `year` (lowercase).
```graphql
query Q($startDate: Date!, $timeframe: Timeframe!) {
  snapshotsByAccountType(startDate: $startDate, timeframe: $timeframe) {
    accountType balance
  }
}
```

## Recurring

### `Web_GetRecurringStreams`
```graphql
query Web_GetRecurringStreams { recurringTransactionStreams { stream { id name } } }
```

## Mutations (write operations)

Mutations are not introspectable. Generic `Something went wrong while processing` errors come back when the input shape is wrong, so blind probing won't reveal the schema. Two reliable discovery paths:

1. **Browser DevTools**: open `app.monarch.com`, perform the action manually, copy the `graphql` request payload (operationName + query + variables) from the Network tab.
2. **`hammem/monarchmoney` Python library**: the source at `https://raw.githubusercontent.com/hammem/monarchmoney/main/monarchmoney/monarchmoney.py` contains every supported mutation with full query strings and input shapes. Grep it for `mutation `. Faster than DevTools when the action exists in the library.

When adding a new verified mutation, document it below with its exact input type name — that's the part you can't guess.

### `Common_UpdateBudgetItem` — set/clear a category or category-group budget
Setting `amount: 0` **clears** the budget (unsets it). `applyToFuture: true` propagates to all future months; `false` is current month only. Specify exactly one of `categoryId` / `categoryGroupId`, not both.

```graphql
mutation Common_UpdateBudgetItem($input: UpdateOrCreateBudgetItemMutationInput!) {
  updateOrCreateBudgetItem(input: $input) {
    budgetItem { id budgetAmount }
  }
}
```
Variables:
```json
{"input":{
  "startDate":"2026-04-01",
  "timeframe":"month",
  "categoryId":"217986499707517289",
  "categoryGroupId":null,
  "amount":450,
  "applyToFuture":true
}}
```
`timeframe` is believed to only accept `"month"`. `startDate` should be the first of the month.
