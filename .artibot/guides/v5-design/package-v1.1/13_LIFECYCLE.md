# Mission Artifact Lifecycle

```text
USER REQUEST
 ↓
Intent Detection
 ↓
Substantive Mission?
 ├─ no → runtime-only interaction
 └─ yes
      ↓
Create mission_id
      ↓
Create intent.md
      ↓
Update state.yaml
      ↓
Plan / Ultraplan
      ↓
ADR if needed
      ↓
Execute
      ↓
Live state updates
      ↓
Independent Fable Review
      ↓
Verify
      ↓
Create outcome.md
      ↓
Close mission
      ↓
Archive
      ↓
Memory Promotion Review
```

## End-state behavior

When a mission closes:

- `state.yaml` removes/moves it from active state
- final outcome is stored
- ledger retains execution events
- reusable knowledge is considered for memory
- temporary raw logs may be pruned/archived
