/**
 * MessageBubble.tsx - Single chat message bubble.
 *
 * Applies `message-user` or `message-assistant` CSS class based on role
 * so that conversation sides are visually distinct.
 * Preserves line breaks in multi-line replies.
 */
import './MessageBubble.css'

type MessageBubbleProps = {
  role: 'user' | 'assistant';
  content: string;
}

function MessageBubble({ role, content }: MessageBubbleProps) {
  return (
    <div className={`message-bubble message-${role}`}>
      <div className="bubble-content">
        {role === 'assistant' && <span className="message-icon">🤖</span>}
        {role === 'user' && <span className="message-icon">👤</span>}
        <div className="message-text">
          {content === '__loading__' ? (
            <div className="typing-dots">
              <span />
              <span />
              <span />
            </div>
          ) : (
            content.split('\n').map((line, idx) => (
              <div key={idx} className="message-line">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default MessageBubble
