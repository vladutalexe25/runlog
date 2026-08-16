import './sentry.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong. Try reloading the page.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
