import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { captureException } from '@/services/errorTracking';
import { isChunkLoadError, reloadForNewVersion } from '@/lib/staleChunk';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorId: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorId: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // A stale chunk after a deploy is expected, and this screen already tells the user to
    // reload. Reporting it as a crash produced Sentry POSTORA-1 (30 events, 4 users).
    if (isChunkLoadError(error)) {
      console.warn('Stale chunk after deploy; prompting for reload:', error.message);
      return;
    }
    const errorId = captureException(error, {
      componentStack: errorInfo.componentStack || undefined,
      additionalContext: {
        type: 'react_error_boundary',
      },
    });
    
    this.setState({ errorId });
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, errorId: null });
  };

  private handleReload = () => {
    reloadForNewVersion();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isChunkError = isChunkLoadError(this.state.error);

      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="flex flex-col items-center gap-6 max-w-md text-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">
                {isChunkError ? "New version available" : "Something went wrong"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {isChunkError
                  ? "A new version of Postora was deployed. Please reload the page to continue."
                  : "An unexpected error occurred. Please try again or reload the page."}
              </p>
            </div>
            <div className="flex gap-3">
              {!isChunkError && (
                <Button variant="outline" onClick={this.handleRetry}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Try Again
                </Button>
              )}
              <Button onClick={this.handleReload}>
                Reload Page
              </Button>
            </div>
            {this.state.errorId && (
              <p className="text-xs text-muted-foreground">
                Error ID: {this.state.errorId}
              </p>
            )}
            {import.meta.env.DEV && this.state.error && (
              <details className="w-full text-left">
                <summary className="text-xs text-muted-foreground cursor-pointer">
                  Error details
                </summary>
                <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-auto max-h-40">
                  {this.state.error.message}
                  {'\n'}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
