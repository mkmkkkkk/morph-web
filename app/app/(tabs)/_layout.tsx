import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { TabProvider, useActiveTab, type TabName } from '../../lib/TabContext';

console.log('[TabLayout] module loaded');

// Map expo-router screen names to user-facing tab names
const SCREEN_TO_TAB: Record<string, TabName> = {
  index: 'Canvas',
  config: 'Config',
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.4, color: '#fff' }}>
      {label}
    </Text>
  );
}

function TabLayoutInner() {
  console.log('[TabLayout] render');
  const { setActiveTab } = useActiveTab();

  return (
    <Tabs
      screenListeners={{
        tabPress: (e) => {
          console.log('[TabLayout] TAB PRESSED:', e.target);
        },
        focus: (e) => {
          console.log('[TabLayout] TAB FOCUSED:', e.target);
          // e.target looks like "index-XXXX" or "config-XXXX"
          const screenName = (e.target || '').split('-')[0];
          const tabName = SCREEN_TO_TAB[screenName];
          if (tabName) {
            setActiveTab(tabName);
          }
        },
      }}
      screenOptions={{
        tabBarStyle: {
          backgroundColor: '#000',
          borderTopColor: 'rgba(255,255,255,0.08)',
          borderTopWidth: 0.5,
        },
        tabBarActiveTintColor: '#fff',
        tabBarInactiveTintColor: '#555',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        headerStyle: {
          backgroundColor: '#000',
        },
        headerTintColor: '#fff',
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Canvas',
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon label="◇" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="config"
        options={{
          title: 'Config',
          tabBarIcon: ({ focused }) => <TabIcon label="⚙" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  return (
    <TabProvider>
      <TabLayoutInner />
    </TabProvider>
  );
}
