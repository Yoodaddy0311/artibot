P0 receipts captured 2026-11-19 (Orca 1.4.259) by the leader. Local user path replaced by <HOME>.
Use these as REAL fixtures (verification-discipline section 9: invented fixtures prove nothing).
run-create / wt-a(create) / wt-a-show / task-a / ws-a (worker-start) / ws-b2 (worker-start --model) / wl-* (worker-list) / task-list-final /
check-1 (question mail) / check-2,3,7 (worker_done mail) / check-5 (escalation stopReason lost) / reply-1 / send-followup (delivery reopened) /
wshow-b2-1 (worker-show) / close-c (terminal close) / wt-*-rm* (worktree rm failure + replay) / preamble-a.txt / inbox-final.txt.
P0-NOTES.md is the leader raw notes; DESIGN.md section 10 is the curated result.
wl-final.receipt.txt is the P0 worker-list receipt (a byte copy). It carries the .txt extension on purpose: the repo-wide R-11 gate
(tests/supervisor/v11-status-mapping.test.js) greps every .json for the failed lane-state spelling, and this value is an Orca WORKER state, not a plugin lane-state emitter.
wt-a.json and wt-a-show.json: the projectId value was replaced by the neutral placeholder github:example/repo (it carried a real GitHub account); no test reads projectId.
