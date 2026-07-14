"use client";

import { Component, type ReactNode } from "react";

/** Per-widget error boundary: one crashing panel (options chain, value-chain
 *  SVG, a chart) degrades to a clear inline error with a retry, instead of
 *  unmounting the whole Terminal page. Reset by changing `resetKey`. */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string; resetKey?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel-2 p-4 text-sm">
          <div className="text-red mb-1">
            {this.props.label || "This panel"} hit an error and was isolated —
            the rest of the page is unaffected.
          </div>
          <div className="text-mut text-xs mb-2 font-mono">
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button onClick={() => this.setState({ error: null })} className="btn-ghost text-xs">
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
