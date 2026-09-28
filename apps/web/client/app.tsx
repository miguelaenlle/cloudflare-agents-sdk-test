import { useEffect, useState, useRef, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  conversationApi,
  type ApprovalDisplay,
  type ChatSnapshot,
} from "@playground/chat-contract";
import { SandboxStatus } from "./sandbox-status.tsx";
import "./style.css";

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? (undefined as T) : response.json();
}
function steering(
  part: UIMessage["parts"][number],
): { id: string; text: string } | undefined {
  if (
    part.type !== "data-steering" ||
    typeof part.data !== "object" ||
    !part.data
  )
    return;
  if (
    !("id" in part.data) ||
    !("text" in part.data) ||
    typeof part.data.id !== "string" ||
    typeof part.data.text !== "string"
  )
    return;
  return { id: part.data.id, text: part.data.text };
}
function ApprovalCard({
  approval,
  snapshot,
  sending,
  decide,
}: {
  approval: ApprovalDisplay;
  snapshot: ChatSnapshot;
  sending: boolean;
  decide: (approved: boolean) => Promise<void>;
}) {
  const current = snapshot.approval?.id === approval.id;
  const publication = current ? snapshot.publication : undefined;
  return (
    <section className="approval-card" aria-label="Publication approval">
      <strong>Review changes · {approval.status}</strong>
      {publication && (
        <p>
          {publication.repository} · {publication.branch}
        </p>
      )}
      <details>
        <summary>View diff</summary>
        <p>
          Base <code>{approval.baseSha.slice(0, 8)}</code> → proposed{" "}
          <code>{approval.proposedSha.slice(0, 8)}</code>
        </p>
        <pre>{approval.diff}</pre>
      </details>
      {approval.status === "pending" ? (
        <>
          <p>Approve publishes these files. Course Sync is simulated.</p>
          {publication?.error && <p role="alert">{publication.error}</p>}
          <div className="actions">
            <button
              disabled={
                !current ||
                sending ||
                publication?.status === "invalid" ||
                publication?.status === "publishing"
              }
              onClick={() => void decide(true)}
            >
              Approve
            </button>
            <button
              disabled={
                !current || sending || publication?.status === "publishing"
              }
              onClick={() => void decide(false)}
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {approval.status === "approved"
              ? "You approved these changes."
              : "You denied these changes."}
          </p>
          {approval.result && (
            <details>
              <summary>Result</summary>
              <p>{approval.result}</p>
            </details>
          )}
          {current && snapshot.blocked && (
            <button
              disabled={sending}
              onClick={() => void decide(approval.status === "approved")}
            >
              Retry completion
            </button>
          )}
        </>
      )}
    </section>
  );
}
/** Render user-visible history; internal approval continuations stay available to Codex but are hidden here. */
function Transcript({
  messages,
  snapshot,
  sending,
  decide,
}: {
  messages: UIMessage[];
  snapshot: ChatSnapshot;
  sending: boolean;
  decide: (approved: boolean) => Promise<void>;
}) {
  const approvals =
    snapshot.approvals ?? (snapshot.approval ? [snapshot.approval] : []);
  const approvalIds = new Set(approvals.map((approval) => approval.id));
  const rendered = new Set<string>();
  function card(approval: ApprovalDisplay, key: string | number) {
    rendered.add(approval.id);
    return (
      <ApprovalCard
        key={key}
        approval={approval}
        snapshot={snapshot}
        sending={sending}
        decide={decide}
      />
    );
  }
  const interleaved = new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const value = steering(part);
        return value ? [value.id] : [];
      }),
    ),
  );
  return (
    <section aria-label="Conversation">
      {!messages.length && <p>No messages yet.</p>}
      {messages
        .filter((message) => {
          const metadata = message.metadata;
          const approvalResult =
            message.role === "user" &&
            ((typeof metadata === "object" &&
              metadata !== null &&
              "source" in metadata &&
              metadata.source === "tool-result") ||
              // Legacy continuations used the approval ID before metadata was added.
              approvalIds.has(message.id));
          return (
            !interleaved.has(message.id) &&
            !approvalResult &&
            !message.parts.some((part) => part.type === "data-tool-display")
          );
        })
        .map((message) => (
          <article key={message.id}>
            <strong>{message.role}</strong>
            {message.parts.map((part, index) => {
              if (
                part.type === "data-tool" &&
                typeof part.data === "object" &&
                part.data &&
                "id" in part.data
              ) {
                const data = part.data;
                const approval = approvals.find(
                  (value) => value.id === data.id,
                );
                return approval ? card(approval, index) : null;
              }
              // Older transcripts have a native tool part but no explicit approval marker.
              if (
                ((part.type === "dynamic-tool" &&
                  part.toolName === "push_sync") ||
                  part.type === "tool-push_sync") &&
                typeof part.input === "object" &&
                part.input &&
                "proposedSha" in part.input
              ) {
                const input = part.input;
                const approval = approvals.find(
                  (value) =>
                    value.proposedSha === input.proposedSha &&
                    !rendered.has(value.id),
                );
                const hasMarker =
                  approval &&
                  messages.some((message) =>
                    message.parts.some(
                      (p) =>
                        p.type === "data-tool" &&
                        typeof p.data === "object" &&
                        p.data &&
                        "id" in p.data &&
                        p.data.id === approval.id,
                    ),
                  );
                if (approval && !hasMarker) return card(approval, index);
              }
              const correction = steering(part);
              if (correction)
                return (
                  <blockquote key={index}>
                    <strong>User · steering</strong>
                    <p className="message">{correction.text}</p>
                  </blockquote>
                );
              if (part.type === "text")
                return (
                  <p className="message" key={index}>
                    {part.text}
                  </p>
                );
              if (part.type === "reasoning")
                return (
                  <details key={index}>
                    <summary>Reasoning summary</summary>
                    <p className="message">{part.text}</p>
                  </details>
                );
              if (part.type.startsWith("tool-") || part.type === "dynamic-tool")
                return (
                  <details key={index}>
                    <summary>Tool activity</summary>
                    <pre>{JSON.stringify(part, null, 2)}</pre>
                  </details>
                );
              return null;
            })}
          </article>
        ))}
      {approvals
        .filter((approval) => !rendered.has(approval.id))
        .map((approval) => card(approval, approval.id))}
    </section>
  );
}
function Conversation({ id, initial }: { id: string; initial: ChatSnapshot }) {
  const api = conversationApi(id);
  const [transport] = useState(
    () => new DefaultChatTransport({ api: api.chat }),
  );
  const [snapshot, setSnapshot] = useState(initial);
  const [revision, setRevision] = useState(initial.revision);
  const [input, setInput] = useState(
    () => sessionStorage.getItem(`draft:${id}`) ?? "",
  );
  const [failure, setFailure] = useState("");
  const [sending, setSending] = useState(false);
  const { messages, stop, status, error, setMessages, resumeStream } = useChat({
    id,
    messages: initial.messages,
    transport,
    resume: true,
  });
  const busy = status === "submitted" || status === "streaming";
  // Our pending send/approval reserves a revision before its response arrives.
  const stale = !sending && revision !== snapshot.revision;
  const approval = snapshot.approval;
  function draft(text: string) {
    setInput(text);
    sessionStorage.setItem(`draft:${id}`, text);
  }
  /** Replace the local snapshot/revision before reconnecting to the current stream. */
  async function refresh() {
    await stop();
    const next = await request<ChatSnapshot>(api.snapshot);
    setSnapshot(next);
    setRevision(next.revision);
    setMessages(next.messages);
    void resumeStream();
  }
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Subscribe once per conversation. EventSource reconnects and receives a fresh snapshot after transport failure.
  useEffect(() => {
    const source = new EventSource(api.events);
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as ChatSnapshot;
      setSnapshot(next);
      if (!busyRef.current) {
        setMessages(next.messages);
        void resumeStream();
      }
    };
    source.onerror = () =>
      setFailure(
        "Live updates disconnected; reconnecting. Your draft is preserved.",
      );
    source.onopen = () => setFailure("");
    return () => source.close();
  }, [id, setMessages, resumeStream]);
  /** Submit with the last observed revision; a rejected send keeps the draft for the user. */
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || sending || stale) return;
    setSending(true);
    setFailure("");
    await stop();
    try {
      await request(api.chat, {
        id: crypto.randomUUID(),
        text: input,
        expectedRevision: revision,
      });
      draft("");
      await refresh();
    } catch (error) {
      setFailure(String(error));
      // Do not advance the draft's revision on rejection or uncertain acceptance.
      try {
        const next = await request<ChatSnapshot>(api.snapshot);
        setSnapshot(next);
        setMessages(next.messages);
        void resumeStream();
      } catch {
        /* The explicit Refresh button retries. */
      }
    } finally {
      setSending(false);
    }
  }
  async function decide(approved: boolean) {
    if (!approval) return;
    setSending(true);
    setFailure("");
    try {
      await request(api.approval, {
        id: approval.id,
        digest: approval.digest,
        expectedRevision: revision,
        approved,
      });
      await refresh();
    } catch (error) {
      setFailure(String(error));
    } finally {
      setSending(false);
    }
  }
  return (
    <>
      <p role="status">
        {approval?.status === "pending"
          ? "Waiting for approval"
          : busy
            ? "Working…"
            : "Ready"}
      </p>
      <SandboxStatus
        diagnostics={snapshot.diagnostics}
        retryApi={api.cleanup}
      />
      <Transcript
        messages={messages}
        snapshot={snapshot}
        sending={sending}
        decide={decide}
      />
      {stale && (
        <p role="alert">
          This conversation changed. Refresh history before sending. Your draft
          is preserved.
        </p>
      )}
      {(failure || error) && <p role="alert">{failure || error?.message}</p>}
      <form onSubmit={send}>
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          rows={3}
          value={input}
          onChange={(event) => draft(event.target.value)}
        />
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              void refresh().catch((error) => setFailure(String(error)))
            }
          >
            Refresh history
          </button>
          <button
            disabled={sending || stale || snapshot.blocked || !input.trim()}
          >
            Send
          </button>
          <button
            type="button"
            onClick={() =>
              void request(api.cancel, {}).catch((error) =>
                setFailure(String(error)),
              )
            }
          >
            Stop
          </button>
        </div>
      </form>
    </>
  );
}
function App() {
  const [conversations, setConversations] = useState<
    { id: string; title: string }[]
  >([]);
  const [id, setId] = useState(
    new URLSearchParams(location.search).get("conversation") ?? "playground",
  );
  const [loaded, setLoaded] = useState<{
    id: string;
    snapshot: ChatSnapshot;
  }>();
  const [failure, setFailure] = useState("");
  // Conversation identity is in the URL so copying a tab opens the same durable conversation.
  useEffect(() => {
    let disposed = false;
    setLoaded(undefined);
    const url = new URL(location.href);
    url.searchParams.set("conversation", id);
    history.replaceState(null, "", url);
    void Promise.all([
      request<{ id: string; title: string }[]>("/api/conversations"),
      request<ChatSnapshot>(conversationApi(id).snapshot),
    ])
      .then(([list, snapshot]) => {
        if (!disposed) {
          setConversations(list);
          setLoaded({ id, snapshot });
        }
      })
      .catch((error) => {
        if (!disposed) setFailure(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [id]);
  async function create() {
    const value = await request<{ id: string }>("/api/conversations", {
      title: `Conversation ${conversations.length + 1}`,
    });
    setId(value.id);
  }
  return (
    <main>
      <h1>Agent chat</h1>
      <div className="actions">
        <select
          aria-label="Conversation"
          value={id}
          onChange={(event) => setId(event.target.value)}
        >
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title}
            </option>
          ))}
        </select>
        <button
          onClick={() =>
            void create().catch((error) => setFailure(String(error)))
          }
        >
          New conversation
        </button>
      </div>
      {failure && <p role="alert">{failure}</p>}
      {loaded ? (
        <Conversation
          key={loaded.id}
          id={loaded.id}
          initial={loaded.snapshot}
        />
      ) : (
        <p>Loading…</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
