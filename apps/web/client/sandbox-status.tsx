import { useEffect, useState } from "react";
import {
  sandboxDiagnosticsSchema,
  type SandboxDiagnostics,
} from "@playground/chat-contract";

function Expiration({
  label,
  at,
  now,
}: {
  label: string;
  at: number | null;
  now: number;
}) {
  if (at === null) return <div>{label}: —</div>;
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  const remaining =
    seconds === 0
      ? "due; awaiting cleanup"
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s remaining`;
  return (
    <div>
      {label}:{" "}
      <time dateTime={new Date(at).toISOString()}>
        {new Date(at).toLocaleString()}
      </time>{" "}
      ({remaining})
    </div>
  );
}

export function SandboxStatus({ api }: { api: string }) {
  const [diagnostics, setDiagnostics] = useState<SandboxDiagnostics | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now);

  // Read-only polling also observes lifecycle changes when no chat stream is attached.
  useEffect(() => {
    const controller = new AbortController();
    let poll: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(api, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Diagnostics unavailable");
        const value = sandboxDiagnosticsSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setDiagnostics(value);
          setUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) poll = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      controller.abort();
      clearTimeout(poll);
      clearInterval(clock);
    };
  }, [api]);

  return (
    <section aria-label="Sandbox diagnostics" className="hint">
      <strong>Sandbox</strong>
      {unavailable ? (
        <p>Diagnostics unavailable; retrying…</p>
      ) : diagnostics ? (
        <>
          <div>
            State: <code>{diagnostics.state}</code>
          </div>
          <Expiration
            label="Idle expiration"
            at={diagnostics.idleExpiresAt}
            now={now}
          />
          <Expiration
            label="Interaction expiration"
            at={diagnostics.interactionExpiresAt}
            now={now}
          />
        </>
      ) : (
        <p>Loading diagnostics…</p>
      )}
    </section>
  );
}
