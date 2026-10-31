/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { GlobalVoiceBar } from '../components/GlobalVoiceBar';
import { useLioraStore } from '../store/lioraStore';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { activeTab } = useLioraStore();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#050505] text-[#F5F5F5] font-sans antialiased">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {activeTab !== 'home' && <Header />}
        <main className="flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </div>
      <GlobalVoiceBar />
    </div>
  );
};

export default AppShell;
