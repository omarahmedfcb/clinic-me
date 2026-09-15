import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Turns a render error into something readable instead of a blank page.
 *
 * ## Why this exists
 *
 * This project has now had **three blank pages**, and each one cost a review cycle for the same
 * reason: an uncaught render error unmounts the whole React tree, so the symptom is an empty
 * document. `curl` returns 200, the HTML is well-formed, the dev server reports success — and the
 * only evidence is in a browser console nobody is looking at. A blank page reads as a missing
 * route, a stale build, or a caching problem, and it is none of those.
 *
 * The founder cannot paste an error he was never shown, and neither can anyone reviewing on a
 * phone. So the failure is made legible where it happens.
 *
 * ## Why it renders the message rather than a friendly apology
 *
 * A "something went wrong" card would replace one uninformative screen with a prettier one. The
 * point is the text: the message and the component stack are what turn "it's blank" into a
 * diagnosis, and they are what someone can copy into a message. This is a clinic system reviewed
 * by the person who builds it; hiding the cause helps nobody.
 *
 * In production the same reasoning holds for a different reason — a receptionist who can say
 * "it says TypeError in AppointmentDetailPanel" is giving a support report, while "it went blank"
 * is not one.
 */
interface Props {
  children: ReactNode;
  /** Names the region, so the message says which part failed rather than just "the app". */
  where: string;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, componentStack: info.componentStack ?? null });
    // Also to the console, so the browser's own error reporting still has it.
    console.error(`[${this.props.where}]`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        className="m-4 rounded-lg border border-danger bg-danger-soft p-4 text-start"
      >
        <h2 className="text-sm font-semibold text-danger">
          {this.props.where} — {error.name}
        </h2>
        <p className="mt-1 text-sm text-ink">{error.message}</p>
        {componentStack !== null && (
          <pre className="mt-3 max-h-64 overflow-auto rounded bg-surface p-2 text-[11px] leading-relaxed text-ink-muted">
            {componentStack.trim()}
          </pre>
        )}
        {error.stack !== undefined && (
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface p-2 text-[11px] leading-relaxed text-ink-subtle">
            {error.stack}
          </pre>
        )}
      </div>
    );
  }
}
