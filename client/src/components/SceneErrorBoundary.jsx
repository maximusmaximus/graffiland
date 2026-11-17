import React from 'react';
import XeroIcon from './XeroIcon.jsx';

export class SceneErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || 'The 3D AR viewport encountered a rendering issue.'
    };
  }

  componentDidCatch(error) {
    if (typeof this.props.onError === 'function') {
      this.props.onError(error);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="scene-error-fallback" role="alert">
          <div className="scene-error-card card">
            <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 0 }}>
              <XeroIcon emoji="⚠️" size={20} />
              <span>3D AR Scene Interrupted</span>
            </h3>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>{this.state.message}</p>
            <p style={{ fontSize: 11, color: 'var(--muted)' }}>
              Your local draft voxels remain safe. Tap below to reinitialize WebGL cleanly.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  this.setState({ hasError: false, message: '' });
                  this.props.onRecover?.();
                }}
              >
                <XeroIcon emoji="🔄" size={15} /> Reload 3D Viewport
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default SceneErrorBoundary;
