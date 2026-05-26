import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, ArrowLeft, Loader } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { Message } from '../api'
import './Chat.css'

interface Props {
  title:       string
  color:       string
  onSend:      (message: string, history: Message[]) => Promise<string>
  header?:     React.ReactNode
}

export default function Chat({ title, color, onSend, header }: Props) {
  const navigate  = useNavigate()
  const [messages, setMessages]   = useState<Message[]>([])
  const [input,    setInput]      = useState('')
  const [loading,  setLoading]    = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = async () => {
    if (!input.trim() || loading) return

    const userMessage: Message = { role: 'user', content: input.trim() }
    const newHistory = [...messages, userMessage]
    setMessages(newHistory)
    setInput('')
    setLoading(true)

    try {
      const response = await onSend(input.trim(), messages)
      setMessages([...newHistory, { role: 'assistant', content: response }])
    } catch (err) {
      setMessages([
        ...newHistory,
        {
          role:    'assistant',
          content:
            'This demo could not complete your request right now. Please check your connection and try again.'
        }
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-page">
      <div className="chat-topbar">
        <button className="back-btn" onClick={() => navigate('/')}>
          <ArrowLeft size={18} />
          Back
        </button>
        <h2 style={{ color }}>{title}</h2>
      </div>

      {header && <div className="chat-header-slot">{header}</div>}

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Start the conversation below</p>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              className={`message ${msg.role}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y:  0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="message-bubble">
                {msg.content}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {loading && (
          <motion.div
            className="message assistant"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="message-bubble loading">
              <Loader size={16} className="spin" />
              Thinking...
            </div>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Type your message..."
          rows={1}
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          style={{ background: color }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}