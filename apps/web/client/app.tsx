import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, validateUIMessages, type UIMessage } from "ai";
import {
  CANCEL_API,
  CHAT_API,
  CONVERSATION_ID,
  HISTORY_API,
} from "@playground/chat-contract";
import "./style.css";

const transport = new DefaultChatTransport({ api: CHAT_API });
const RECONNECT_DELAY_MS = 2_000;
const DEMO_PROMPT =
  "Create a small hello.txt file, run a shell command that waits 60 seconds, then read the file and report the result.";

async function loadHistory(signal?: AbortSignal): Promise<UIMessage[]> {
  const response = await fetch(HISTORY_API, { signal });
  if (!response.ok)
    throw new Error(
      "Could not load history. Check that the local backend is running and AGENT_URL is set.",
    );
  const messages: unknown = await response.json();
  // An empty history is valid, although the SDK validates nonempty chat requests.
  if (Array.isArray(messages) && messages.length === 0) return [];
  return validateUIMessages({ messages });
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

function App({ initialMessages }: { initialMessages: UIMessage[] }) {
  const [input, setInput] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const { messages, sendMessage, status, error, setMessages, resumeStream } =
    useChat({
      id: CONVERSATION_ID,
      messages: initialMessages,
      transport,
      resume: true,
    });
  const busy = status === "submitted" || status === "streaming";
  // Reattach through a replacement webserver after a broken SSE connection.
  useEffect(() => {
    if (status !== "error") return;
    const attempt = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function reconnect() {
      try {
        const saved = await loadHistory(attempt.signal);
        if (attempt.signal.aborted) return;
        setMessages(saved);
        await resumeStream();
      } catch {
        if (!attempt.signal.aborted)
          timer = setTimeout(reconnect, RECONNECT_DELAY_MS);
      }
    }
    timer = setTimeout(reconnect, RECONNECT_DELAY_MS);
    return () => {
      attempt.abort();
      clearTimeout(timer);
    };
  }, [status, error, setMessages, resumeStream]);

  async function cancelTurn() {
    setCancelError("");
    setCancelling(true);
    try {
      const response = await fetch(CANCEL_API, { method: "POST" });
      if (!response.ok) throw new Error("Could not confirm Stop. Try again.");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelling(false);
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput("");
  }

  return (
    <main>
      <h1>Agent chat</h1>
      <p>
        One persistent conversation. Reload or reopen this page to reconnect.
      </p>
      <p role="status">
        {status === "error" ? "Reconnecting…" : busy ? "Working…" : "Ready"}
      </p>

      <Transcript messages={messages} />

      {error && <p role="alert">{error.message}</p>}
      {cancelError && <p role="alert">{cancelError}</p>}
      <form onSubmit={submitMessage}>
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          rows={3}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <div className="actions">
          <button type="button" onClick={() => window.location.reload()}>
            Reconnect / refresh history
          </button>
          <button disabled={busy || !input.trim()}>Send</button>
          <button
            type="button"
            disabled={cancelling}
            onClick={() => void cancelTurn()}
          >
            Stop
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void sendMessage({
                text: DEMO_PROMPT,
              })
            }
          >
            Run one-minute task
          </button>
        </div>
      </form>
      <p className="hint">
        Once the tool starts, close this tab. Come back after a minute to see
        its result.
      </p>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);

async function initialize() {
  root.render(<main>Loading conversation…</main>);
  try {
    const messages = await loadHistory();
    root.render(<App initialMessages={messages} />);
  } catch (error) {
    root.render(
      <main>
        <p role="alert">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <button onClick={() => void initialize()}>Retry</button>
      </main>,
    );
  }
}

void initialize();
