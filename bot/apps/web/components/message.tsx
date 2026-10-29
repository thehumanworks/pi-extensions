import type { BotUIMessage } from "@nothumanwork/bot-ai-sdk";
import Markdown from "react-markdown";
import { readableJson } from "../lib/chat";

export function SafeMarkdown({ text }: { text: string }) {
  return <div className="markdown"><Markdown
    skipHtml
    // Do not fetch arbitrary remote images or allow tracking pixels in transcripts.
    disallowedElements={["img"]}
    components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
  >{text}</Markdown></div>;
}

export function ChatMessage({ message }: { message: BotUIMessage }) {
  const isUser = message.role === "user";
  return <article className={`message ${isUser ? "message-user" : "message-bot"}`} aria-label={isUser ? "Your message" : "Bot message"}>
    <div className="message-avatar" aria-hidden="true">{isUser ? "Y" : "B"}</div>
    <div className="message-body">
      <div className="message-author">{isUser ? "You" : "Bot"}</div>
      {message.parts.map((part, index) => {
        const key = `${message.id}-${index}`;
        if (part.type === "text") return isUser
          ? <p className="user-text" key={key}>{part.text}</p>
          : <SafeMarkdown text={part.text} key={key} />;
        if (part.type === "reasoning") return <details className="tool-detail" key={key}><summary>Reasoning</summary><SafeMarkdown text={part.text} /></details>;
        if (part.type === "data-bot-tool") {
          const tool = part.data;
          return <details className="tool-detail" key={tool.toolCallId}>
            <summary><span className={`tool-dot tool-${tool.state}`} aria-hidden="true" /><span>{tool.toolName}</span><span className="tool-state">{tool.state}</span></summary>
            <div className="tool-content"><h4>Input</h4><pre>{readableJson(tool.input)}</pre><h4>Result</h4><pre>{readableJson(tool.output)}</pre></div>
          </details>;
        }
        // Backend tools are display-only data, not a browser tool execution loop.
        return null;
      })}
    </div>
  </article>;
}
