import { Tabs } from 'expo-router';
import { Text, useColorScheme } from 'react-native';

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.4 }}>
      {label}
    </Text>
  );
}

export default function TabLayout() {
  const isDark = useColorScheme() !== 'light';

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: isDark ? '#000' : '#f8f8f8',
          borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
          borderTopWidth: 0.5,
        },
        tabBarActiveTintColor: isDark ? '#fff' : '#000',
        tabBarInactiveTintColor: isDark ? '#555' : '#999',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        headerStyle: {
          backgroundColor: isDark ? '#000' : '#f8f8f8',
        },
        headerTintColor: isDark ? '#fff' : '#000',
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
