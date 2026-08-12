# Rollback workflow

Use this workflow only when the user asks to undo a prior create or assignment made by the EADP CLI.

1. Require one or more exact `operationId` values returned by the original applied commands. Do not infer
   them from names, timestamps, remote IDs, or shell history.
2. Run `eadp rollback --help`, then execute:

```text
eadp rollback <operation-id> [operation-id...]
```

3. Do not add `--apply`; `rollback` is an explicitly authorized write and executes directly.
4. The local operation log is retained for 30 days and binds the operation to its original environment.
   Never edit the log, change the environment, or reconstruct an expired log.
5. With multiple operation IDs, the CLI validates every log and environment before remote access, then
   rolls operations back by `completedAt` from newest to oldest. Logs without `completedAt`, duplicate IDs,
   or identical completion timestamps cannot be batch rolled back. Within each operation, actions are also
   rolled back in reverse order. A later modification, server-side dependency, missing environment, expired
   log, or request failure stops the workflow immediately. Do not retry or replace the command with raw API calls.
6. Report `rolledBack`, `alreadyAbsent`, `verified`, and final status. A `rollback-failed` status is a
   partial result, not success; state that no retry was attempted.

Updates to records that already existed are not included. Preview and unchanged commands do not create
an `operationId`.
