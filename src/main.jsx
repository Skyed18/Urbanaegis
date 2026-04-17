import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: '' };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('App render error:', error, info);
    this.setState({ error, componentStack: info?.componentStack ?? '' });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
          <div className="mx-auto max-w-3xl rounded-2xl border border-red-400/30 bg-slate-900/80 p-6 shadow-2xl shadow-red-950/20">
            <p className="text-xs uppercase tracking-[0.2em] text-red-300">UrbanAegis</p>
            <h1 className="mt-3 text-3xl font-black text-white">The page hit a rendering error.</h1>
            <p className="mt-3 text-sm text-slate-300">
              The app failed to draw one of its panels. Refresh the page, and if it stays blank, I’ll patch the failing component next.
            </p>
            {this.state.error ? (
              <div className="mt-4 rounded-xl border border-red-400/20 bg-slate-950/70 p-3 text-xs text-red-100">
                <p className="font-semibold">Error message:</p>
                <p className="mt-1 break-words">{this.state.error.message}</p>
                {this.state.componentStack ? (
                  <pre className="mt-3 overflow-auto whitespace-pre-wrap text-[11px] text-red-200/80">{this.state.componentStack}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('app')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
