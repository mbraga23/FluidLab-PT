## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Reasoning

<!-- What did you try that did not work? What alternative did you reject, and on what grounds?
     For a physics or solver change: which equation, and where does it come from? -->

## Evidence

<!-- How do you know it is right? Paste the relevant gate output, or the numbers before/after. -->

```
npm test
```

## Checklist

- [ ] `npm test` is green (90 tests, 4 suites)
- [ ] No new dependency — no `node_modules`, no bare import specifiers outside `node:`
- [ ] New behaviour has a test that asserts the physical consequence, not that code exists
- [ ] A new component is a catalog entry only — no engine or inspector change
- [ ] [docs/LIMITATIONS.md](../docs/LIMITATIONS.md) updated if this adds or removes a modelling boundary
- [ ] README claims still true (component count, test count, feature list)
