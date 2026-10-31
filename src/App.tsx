/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useLioraStore } from './store/lioraStore';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { HomeView } from './components/views/HomeView';
import { ConversationView } from './components/views/ConversationView';
import { ActivityView } from './components/views/ActivityView';
import { MemoryView } from './components/views/MemoryView';
import { DevicesView } from './components/views/DevicesView';
import { AutomationsView } from './components/views/AutomationsView';
import { DeveloperView } from './components/views/DeveloperView';
import { IntegrationsView } from './components/views/IntegrationsView';
import { SettingsView } from './components/views/SettingsView';
import { CockpitHUDView } from './components/views/CockpitHUDView';
import { QuickOverlay } from './components/QuickOverlay';
import { GlobalVoiceBar } from './components/GlobalVoiceBar';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[LIORA UI ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#050505] text-white">
          <div className="p-4 rounded-full bg-[var(--accent-bg)] text-[var(--accent-primary)] mb-4">
            <span className="font-bold text-xl">!</span>
          </div>
          <h2 className="text-lg font-bold">Recuperação de Interface LIORA</h2>
          <p className="text-xs text-[#A8A8A8] mt-1 text-center max-w-md">
            Um componente visual reportou uma anomalia. O núcleo permaneceu seguro e soberano.
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white rounded-xl text-xs font-semibold transition-all shadow-md shadow-[var(--accent-glow)]"
          >
            Reinicializar Interface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { activeTab, loadSettings, setActiveTab, sendMessage } = useLioraStore();
  const [isQuickOverlayOpen, setIsQuickOverlayOpen] = React.useState(false);

  React.useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Global shortcut (Alt + Space or Option + Space) to toggle Quick Launcher
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.altKey || e.metaKey) && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        setIsQuickOverlayOpen((prev) => !prev);
      } else if (e.key === 'Escape' && isQuickOverlayOpen) {
        setIsQuickOverlayOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isQuickOverlayOpen]);

  const handleQuickOverlaySubmit = async (promptText: string, imageBase64?: string) => {
    setActiveTab('conversation');
    await sendMessage(
      promptText,
      imageBase64 ? { data: imageBase64, mimeType: 'image/jpeg' } : undefined
    );
  };

  const renderActiveView = () => {
    switch (activeTab) {
      case 'home': return <HomeView />;
      case 'conversation': return <ConversationView />;
      case 'activity': return <ActivityView />;
      case 'memory': return <MemoryView />;
      case 'devices': return <DevicesView />;
      case 'automations': return <AutomationsView />;
      case 'developer': return <DeveloperView />;
      case 'integrations': return <IntegrationsView />;
      case 'settings': return <SettingsView />;
      case 'cockpit': return <CockpitHUDView />;
      default: return <HomeView />;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#050505] text-[#F5F5F5] font-sans antialiased">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {activeTab !== 'home' && <Header />}
        <main className="flex-1 flex flex-col overflow-hidden">
          <ErrorBoundary>
            {renderActiveView()}
          </ErrorBoundary>
        </main>
      </div>
      <QuickOverlay 
        isOpen={isQuickOverlayOpen}
        onClose={() => setIsQuickOverlayOpen(false)}
        onSubmitPrompt={handleQuickOverlaySubmit}
      />
      <GlobalVoiceBar />
    </div>
  );
}
