import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { conversationApi, type ChatSnapshot } from "@playground/chat-contract";
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
function Transcript({ messages }: { messages: UIMessage[] }) {
  return (
    <section aria-label="Conversation">
      {messages.length === 0 && <p>No messages yet.</p>}
      {messages.map((message) => (
        <article key={message.id}>
          <strong>{message.role}</strong>
          {message.parts.map((part, index) => {
            if (part.type === "text") {
              return (
                <p className="message" key={index}>
                  {part.text}
                </p>
              );
            }
            if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
              return (
                <details key={index} open>
                  <summary>Tool activity</summary>
                  <pre>{JSON.stringify(part, null, 2)}</pre>
                </details>
              );
            }
            return null;
          })}
        </article>
      ))}
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
  const stale = revision !== snapshot.revision;
  function draft(text: string) {
    setInput(text);
    sessionStorage.setItem(`draft:${id}`, text);
  }
  async function refresh() {
    await stop();
    const next = await request<ChatSnapshot>(api.snapshot);
    setSnapshot(next);
    setRevision(next.revision);
    setMessages(next.messages);
    void resumeStream();
  }
  // Other-tab revisions can change while this tab has no active stream.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await request<ChatSnapshot>(api.snapshot);
        if (disposed) return;
        setSnapshot(next);
        if (!busy) {
          setMessages(next.messages);
          void resumeStream();
        }
      } catch (error) {
        if (!disposed) setFailure(String(error));
      } finally {
        if (!disposed) timer = setTimeout(poll, 2000);
      }
    }
    timer = setTimeout(poll, 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id, busy, setMessages, resumeStream]);
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
  return (
    <>
      <p role="status">{busy ? "Working…" : "Ready"}</p>
      <SandboxStatus api={api.diagnostics} />
      <Transcript messages={messages} />
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
          <button disabled={sending || busy || stale || !input.trim()}>
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
