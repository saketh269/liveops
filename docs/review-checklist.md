# Review checklist (agent-review)

A branch is approved only when every line is true.

**Contract**
- [ ] Connector implements every method in `docs/design.md` §3 and passes the contract kit against a real system
- [ ] `spec.maturity` is honest (`needs_real_test` if not run against the real system)
- [ ] First stream batch is full state; then only differences

**Correctness**
- [ ] Edge cases: empty dataset, missing key, nulls, unicode, very large values, source restart
- [ ] Timeouts on every network call; no unbounded reads
- [ ] Async code never blocks the event loop with long sync work

**Safety**
- [ ] Read-only against sources; no string-built queries
- [ ] Secrets only in `secrets_schema`; never logged, returned, or in errors
- [ ] Encryption defaults to `required`

**Quality**
- [ ] Tests included and meaningful (not just "it runs")
- [ ] Errors say what went wrong and how to fix it
- [ ] No dead code, no TODOs without a ticket
- [ ] `ruff`, `mypy`, `pytest` / `tsc`, `eslint`, `vitest`, `build` all green
- [ ] Front end: works at 400 px width, light and dark, keyboard focus visible
