import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// 代码块：语言标签 + 复制按钮
function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false)
  const code = String(children)

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(code)
      } else {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <pre>
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'code'}</span>
        <button className={`code-copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
          {copied ? '✓ 已复制' : '⧉ 复制'}
        </button>
      </div>
      <code className={`hljs language-${language || 'text'}`}>{code}</code>
    </pre>
  )
}

export default function Markdown({ children }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => children,
          code: ({ node, inline, className, children, ...props }) => {
            const lang = /language-(\w+)/.exec(className || '')?.[1] || ''
            if (inline || !lang) {
              return <code className={className} {...props}>{children}</code>
            }
            return <CodeBlock language={lang}>{children}</CodeBlock>
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
