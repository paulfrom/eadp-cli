# Rollback workflow

Use this workflow only when the user asks to undo a prior create or assignment made by the EADP CLI.

1. Require the exact `operationId` returned by the original applied command. Do not infer it from names,
   timestamps, remote IDs, or shell history.
2. Run `eadp rollback --help`, then execute:

```text
eadp rollback <operation-id>
```

3. Do not add `--apply`; `rollback` is an explicitly authorized write and executes directly.
4. The local operation log is retained for 30 days and binds the operation to its original environment.
   Never edit the log, change the environment, or reconstruct an expired log.
5. The CLI checks current remote state, rolls actions back in reverse order, and verifies each inverse
   operation. A later modification, server-side dependency, missing environment, expired log, or request
   failure stops the workflow immediately. Do not retry or replace the command with raw API calls.
6. Report `rolledBack`, `alreadyAbsent`, `verified`, and final status. A `rollback-failed` status is a
   partial result, not success; state that no retry was attempted.

Updates to records that already existed are not included. Preview and unchanged commands do not create
an `operationId`.
