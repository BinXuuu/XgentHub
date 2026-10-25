import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 换了页面 / 选中项时自动清掉错误，重新渲染。 */
  resetKey?: string;
  /** 整个应用最外层用：没有左侧导航可点，只能刷新。 */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * 某个页面组件渲染时报错，React 默认会把整个页面卸载成白屏。这里兜住：只把出错的那块换成提示，
 * 左侧导航照常能用，切到别的页面就恢复；最外层那一个兜住剩下的情况，至少给个刷新按钮和错误原因。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Xgent] 页面渲染出错", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`error-boundary ${this.props.fullPage ? "full-page" : ""}`} role="alert">
        <strong>这个页面出错了</strong>
        <p>{this.props.fullPage ? "刷新一下通常就好。" : "可以切到别的页面再回来，或者刷新一下。"}如果反复出现，把下面的错误信息发给开发者。</p>
        <code>{error.message || String(error)}</code>
        <div className="error-boundary-actions">
          {!this.props.fullPage && (
            <button className="btn btn-sm" type="button" onClick={() => this.setState({ error: null })}>
              重试
            </button>
          )}
          <button className="btn btn-primary btn-sm" type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
