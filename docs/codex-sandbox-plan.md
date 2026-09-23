# Codex sandbox implementation

The initial per-turn Codex SDK runner has been replaced by a persistent native app-server. See the [current architecture](architecture.md) for implementation, ownership, lifecycle, and recovery, and [README](../README.md) for setup.

The [proposal status](architecture-proposed.md) records implemented changes and remaining deployment checks. Backups happen only before planned destruction. Course sync/publishing, multi-window synchronization, and usage accounting remain follow-up work.
