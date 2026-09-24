import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { cx } from "../../lib/cx.ts";
import { sendWebchatMessage } from "./webchat-api.ts";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

const WELCOME =
  "أهلاً! أنا مساعد حجز المواعيد، تقدر تكتبلي بالعربي أو بالإنجليزي عشان نحجز موعدك.\n" +
  "Hi! I'm the appointment booking assistant. Write in Arabic or English, whichever you like.";

const SEND_ERROR = "تعذّر الإرسال، من فضلك حاول تاني. / Could not send that, please try again.";

/**
 * The web-chat booking prototype -- `/book`, reachable with no login (App.tsx's isWebchatPath()).
 *
 * `ARCHITECTURE.md §12`'s tool registry runs behind `/api/public/webchat/message`; this component
 * is deliberately nothing but a message list and an input, because the LLM's ability to carry the
 * flow is the thing this prototype exists to test, not this page.
 */
export function WebchatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || sending) return;

    setMessages((previous) => [...previous, { role: "user", text }]);
    setInput("");
    setSending(true);
    setError(undefined);

    try {
      const response = await sendWebchatMessage(sessionId, text);
      setSessionId(response.sessionId);
      setMessages((previous) => [...previous, { role: "assistant", text: response.reply }]);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-surface-sunken">
      <header className="border-b border-border-strong bg-surface px-4 py-3">
        <h1 className="text-base font-semibold text-ink">حجز موعد / Book an appointment</h1>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((message, index) => (
          <div key={index} className={cx("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cx(
                "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm",
                message.role === "user" ? "bg-primary text-white" : "border border-border-strong bg-surface text-ink",
              )}
            >
              {message.text}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <Spinner size="sm" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-4 pb-2 text-sm text-danger">{error}</p>}

      <form
        className="flex items-center gap-2 border-t border-border-strong bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-full border border-border-strong bg-surface-sunken px-4 py-2.5 text-sm text-ink outline-none focus:border-primary"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="اكتب رسالتك... / Type a message..."
          disabled={sending}
        />
        <Button type="submit" disabled={sending || input.trim().length === 0}>
          إرسال / Send
        </Button>
      </form>
    </div>
  );
}
