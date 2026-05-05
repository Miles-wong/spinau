/**
 * MessageInput.tsx - Dynamic input widget for the conversational form.
 *
 * Renders different input controls depending on the `hints.type` of the current field:
 * - boolean: Yes/No quick-reply buttons (auto-submit on click when no detail needed).
 * - enum: Single-select option pills (auto-submit on click).
 * - multi_select: Multi-select checkbox-style pills.
 * - default: Plain text input with optional placeholder.
 *
 * An optional `hints.suggestion` string (AI tip) is shown above the input
 * for category and severity fields.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import './MessageInput.css'

type HintOption = {
  value: string | boolean;
  label: string;
}

type DetailHint = {
  label: string;
  placeholder: string;
}

type InputHints = {
  type?: string;
  options?: HintOption[];
  placeholder?: string;
  suggestion?: string;
  recommendedValue?: string;
  recommendedTip?: string;
  autoSelectRecommended?: boolean;
  detail_hint?: DetailHint;
}

type MessageInputProps = {
  onSendMessage: (message: string, rawValues?: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  hints?: InputHints;
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function MessageInput({ onSendMessage, disabled, placeholder, hints }: MessageInputProps) {
  const [message, setMessage] = useState('')
  const [singleChoice, setSingleChoice] = useState<string>('')
  const [multiChoice, setMultiChoice] = useState<string[]>([])
  const [detailText, setDetailText] = useState('')
  const [otherText, setOtherText] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const inputType = hints?.type || 'text'
  const hintOptions = hints?.options
  const options = useMemo(() => hintOptions || [], [hintOptions])
  const suggestion = hints?.suggestion || hints?.recommendedTip
  const optionsKey = useMemo(() => JSON.stringify(options), [options])

  // Reset local input state whenever the expected input contract changes.
  // For enum prompts, optionally preselect the backend-recommended value when
  // the server marks it as safe for auto-selection.
  useEffect(() => {
    const resetId = window.setTimeout(() => {
      const recommendedValue = String(hints?.recommendedValue || '').trim()
      const shouldAutoSelectRecommended =
        inputType === 'enum'
        && hints?.autoSelectRecommended === true
        && recommendedValue.length > 0
        && options.some((opt) => String(opt.value) === recommendedValue)

      setSingleChoice(shouldAutoSelectRecommended ? recommendedValue : '')
      setMultiChoice([])
      setMessage('')
      setDetailText('')
      setOtherText('')
    }, 0)
    return () => window.clearTimeout(resetId)
  }, [inputType, placeholder, optionsKey, hints?.recommendedValue, hints?.autoSelectRecommended, options])

  // Auto-focus the textarea when the input type is text-based
  useEffect(() => {
    if (inputType === 'text' || inputType === 'textarea') {
      textareaRef.current?.focus()
    }
  }, [inputType, placeholder, optionsKey])

  const showDetailInput =
    inputType === 'boolean' && singleChoice === 'true' && Boolean(hints?.detail_hint)

  const canSubmit = useMemo(() => {
    if (disabled) return false
    if (inputType === 'boolean') {
      if (!singleChoice) return false
      // When Yes is selected and a detail field is required, wait for the detail text
      if (showDetailInput) return Boolean(detailText.trim())
      return true
    }
    if (inputType === 'enum') return Boolean(singleChoice)
    if (inputType === 'multi_select') return multiChoice.length > 0
    return Boolean(message.trim())
  }, [disabled, inputType, message, multiChoice.length, singleChoice, detailText, showDetailInput])

  const buildOutgoingText = () => {
    if (inputType === 'boolean') {
      if (showDetailInput && detailText.trim()) {
        // Send boolean answer combined with detail so AI extracts both in one turn
        return `Yes. ${detailText.trim()}`
      }
      return singleChoice === 'true' ? 'Yes' : 'No'
    }
    if (inputType === 'enum') {
      return String(singleChoice).trim()
    }
    if (inputType === 'multi_select') {
      const parts = multiChoice.join(', ')
      if (multiChoice.includes('other') && otherText.trim()) {
        return `${parts}. Other: ${otherText.trim()}`
      }
      return parts
    }
    return message.trim()
  }

  const doSubmit = () => {
    const outgoing = buildOutgoingText()
    if (outgoing) {
      const rawValues = inputType === 'multi_select' ? [...multiChoice] : undefined
      onSendMessage(outgoing, rawValues)
      setMessage('')
      setSingleChoice('')
      setMultiChoice([])
      setDetailText('')
      setOtherText('')
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    doSubmit()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSubmit) doSubmit()
    }
  }

  const toggleMultiChoice = (value: string) => {
    setMultiChoice((prev) => {
      if (prev.includes(value)) {
        return prev.filter((item) => item !== value)
      }
      return [...prev, value]
    })
  }

  const handleOptionClick = (optValue: string, optLabel: string) => {
    if (disabled) return
    setSingleChoice(optValue)
    setDetailText('')

    // Keep fast interaction for single-step prompts:
    // boolean/enum answers are submitted immediately unless a detail textarea
    // must be shown (for example Yes + detail_hint).
    const willShowDetail = inputType === 'boolean' && optValue === 'true' && Boolean(hints?.detail_hint)
    if (!willShowDetail) {
      const outgoing = inputType === 'boolean'
        ? (optValue === 'true' ? 'Yes' : 'No')
        : optLabel
      onSendMessage(outgoing)
    }
  }

  return (
    <form className="message-input-form" onSubmit={handleSubmit}>
      {suggestion && (
        <div className="ai-suggestion-tip" role="note" aria-label="AI suggestion">
          <span className="ai-suggestion-icon">💡</span>
          <span className="ai-suggestion-text">{suggestion}</span>
        </div>
      )}

      {(inputType === 'boolean' || inputType === 'enum') && options.length > 0 && (
        <div className="choice-row" role="group" aria-label="Choose an option">
          {options.map((opt) => {
            const optValue = String(opt.value)
            const selected = singleChoice === optValue
            return (
              <button
                key={optValue}
                type="button"
                className={`choice-btn ${selected ? 'selected' : ''}`}
                onClick={() => handleOptionClick(optValue, opt.label)}
                disabled={disabled}
              >
                {formatLabel(opt.label)}
              </button>
            )
          })}
        </div>
      )}

      {showDetailInput && hints?.detail_hint && (
        <div className="boolean-detail-prompt">
          <span className="boolean-detail-label">{hints.detail_hint.label}</span>
          <textarea
            className="message-input boolean-detail-textarea"
            value={detailText}
            onChange={(e) => setDetailText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hints.detail_hint.placeholder}
            rows={2}
            disabled={disabled}
            autoFocus
          />
        </div>
      )}

      {inputType === 'multi_select' && options.length > 0 && (
        <>
          <div className="choice-grid" role="group" aria-label="Select one or more options">
            {options.map((opt) => {
              const optValue = String(opt.value)
              const checked = multiChoice.includes(optValue)
              return (
                <label key={optValue} className={`choice-check ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleMultiChoice(optValue)}
                    disabled={disabled}
                  />
                  <span>{formatLabel(opt.label)}</span>
                </label>
              )
            })}
          </div>
          {multiChoice.includes('other') && (
            <textarea
              className="message-input boolean-detail-textarea"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Please describe the other data type..."
              rows={2}
              disabled={disabled}
              autoFocus
            />
          )}
        </>
      )}

      <div className="input-wrapper">
        {showDetailInput ? (
          <div className="message-input fixed-hint-text">
            Fill in the details above, then send.
          </div>
        ) : (inputType === 'boolean' || inputType === 'enum') ? (
          <div className="message-input fixed-hint-text">
            Choose one option above to continue.
          </div>
        ) : inputType === 'multi_select' ? (
          <div className="message-input fixed-hint-text">
            Select one or more options above, then send.
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="message-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || 'Type your response...'}
            disabled={disabled}
            rows={3}
          />
        )}
        <button
          type="submit"
          className="send-btn"
          disabled={!canSubmit}
          title="Send (Enter)"
        >
          📤 Send
        </button>
      </div>
    </form>
  )
}

export default MessageInput
