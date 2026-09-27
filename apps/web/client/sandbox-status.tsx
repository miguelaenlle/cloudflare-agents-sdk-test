import { useEffect, useState } from "react";
import { type SandboxDiagnostics } from "@playground/chat-contract";

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

export function SandboxStatus({
  diagnostics,
  retryApi,
}: {
  diagnostics?: SandboxDiagnostics;
  retryApi: string;
}) {
  const [now, setNow] = useState(Date.now);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");

  async function retryCleanup() {
    setRetrying(true);
    setRetryError("");
    try {
      const response = await fetch(retryApi, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(
          "Could not retry cleanup. Refresh diagnostics and try again.",
        );
    } catch (error) {
      setRetryError(
        error instanceof Error ? error.message : "Cleanup retry failed.",
      );
    } finally {
      setRetrying(false);
    }
  }

  // This timer only renders the countdown; lifecycle changes arrive through conversation events.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  return (
    <section aria-label="Sandbox diagnostics" className="hint">
      <strong>Sandbox</strong>
      {diagnostics ? (
        <>
          <div>
            State: <code>{diagnostics.state}</code>
          </div>
          {diagnostics.cleanup?.error ? (
            <div role="alert">
              <strong>
                {diagnostics.cleanup.stage === "destroy"
                  ? "Sandbox destruction unconfirmed."
                  : "Cleanup failed; sandbox retained."}
              </strong>
              <div>{diagnostics.cleanup.error}</div>
              <div>
                Attempts: {diagnostics.cleanup.attempts}.{" "}
                {diagnostics.cleanup.retryAt === null
                  ? "Automatic retries exhausted."
                  : `Next retry: ${new Date(diagnostics.cleanup.retryAt).toLocaleTimeString()}.`}
              </div>
              <button
                type="button"
                disabled={retrying}
                onClick={() => void retryCleanup()}
              >
                {retrying ? "Requesting cleanup…" : "Retry cleanup"}
              </button>
            </div>
          ) : (
            <>
              {diagnostics.cleanup && (
                <div>Cleanup stage: {diagnostics.cleanup.stage}</div>
              )}
              <Expiration
                label="Idle expiration"
                at={diagnostics.idleExpiresAt}
                now={now}
              />
            </>
          )}
          {retryError && <p role="alert">{retryError}</p>}
          {diagnostics.checkpointError && (
            <p role="alert">{diagnostics.checkpointError}</p>
          )}
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
