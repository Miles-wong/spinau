/**
 * ChatWindow.tsx - Scrollable message history panel for the conversational form.
 *
 * Renders a list of MessageBubble components (one per turn) and uses messagesEndRef
 * to auto-scroll to the latest message whenever the list grows.
 */
import './ChatWindow.css'
import MessageBubble from './MessageBubble'

type Message = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
}

type ChatWindowProps = {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

function ChatWindow({ messages, messagesEndRef }: ChatWindowProps) {
  return (
    <div className="chat-window">
      <div className="messages-container">
        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id || idx}
            role={msg.role}
            content={msg.content}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
    </div>
  )
}

export default ChatWindow
