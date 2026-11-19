P0 receipts captured 2026-11-19 (Orca 1.4.259) by the leader. Local user path replaced by <HOME>.
Use these as REAL fixtures (verification-discipline section 9: invented fixtures prove nothing).
run-create / wt-a(create) / wt-a-show / task-a / ws-a (worker-start) / ws-b2 (worker-start --model) / wl-* (worker-list) / task-list-final /
check-1 (question mail) / check-2,3,7 (worker_done mail) / check-5 (escalation stopReason lost) / reply-1 / send-followup (delivery reopened) /
wshow-b2-1 (worker-show) / close-c (terminal close) / wt-*-rm* (worktree rm failure + replay) / preamble-a.txt / inbox-final.txt.
P0-NOTES.md is the leader raw notes; DESIGN.md section 10 is the curated result.