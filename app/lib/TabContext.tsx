/**
 * Tracks which tab the user is currently viewing (Canvas / Config).
 * Consumed by prompt.ts to add context awareness to outgoing messages.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

export type TabName = 'Canvas' | 'Config';

interface TabContextValue {
  activeTab: TabName;
  setActiveTab: (tab: TabName) => void;
}

const TabContext = createContext<TabContextValue>({
  activeTab: 'Canvas',
  setActiveTab: () => {},
});

export function useActiveTab() {
  return useContext(TabContext);
}

export function TabProvider({ children }: { children: React.ReactNode }) {
  const [activeTab, setActiveTabRaw] = useState<TabName>('Canvas');

  const setActiveTab = useCallback((tab: TabName) => {
    setActiveTabRaw(tab);
  }, []);

  return (
    <TabContext.Provider value={{ activeTab, setActiveTab }}>
      {children}
    </TabContext.Provider>
  );
}
