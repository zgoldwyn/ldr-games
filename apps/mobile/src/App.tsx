/**
 * Root component: identity gate and the MVP stacks (task 22.1b).
 *
 * Boot restores the SecureStore session and the Local Store snapshot, then
 * picks SignIn / Pairing / the game stack. The paired stack opens the 23.1 live
 * channels so partner game invites and turns arrive without manual ids.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_COLOR_OPTION, type ColorOptionName } from '@ldr/core';

import { AppProvider } from './app-context';
import type { MainTabParamList, RootStackParamList } from './navigation';
import { primaryTab } from './primary-tabs';
import { bootRuntime, loadIdentity, type AppRuntime, type Identity } from './runtime';
import { BattleshipScreen } from './screens/BattleshipScreen';
import { GameListScreen } from './screens/GameListScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { LegalDocumentScreen } from './screens/LegalDocumentScreen';
import { LegalScreen } from './screens/LegalScreen';
import { PairingScreen } from './screens/PairingScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TicTacToeScreen } from './screens/TicTacToeScreen';
import { registerApnsToken, subscribeApnsTokenRotation } from './notifications/apns-registration';
import { navigationTheme, themeTokens } from './theme';
import { loadThemePreference, saveThemePreference } from './theme-preference';
import { bulkKv } from './session/expo-kv';
import { AppText } from './ui/AppText';
import { Screen } from './ui/Screen';
import { SkeletonLoader } from './ui/SkeletonLoader';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

function MainTabs({ tokens }: { readonly tokens: ReturnType<typeof themeTokens> }) {
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      safeAreaInsets={{ bottom: 0 }}
      screenOptions={({ route }) => {
        const tab = primaryTab(route.name);
        return {
          headerStyle: { backgroundColor: tokens.surface },
          headerTitleStyle: { color: tokens.textPrimary },
          headerTintColor: tokens.textPrimary,
          sceneStyle: { backgroundColor: tokens.background },
          tabBarActiveTintColor: tokens.textPrimary,
          tabBarInactiveTintColor: tokens.textMuted,
          tabBarLabel: tab.label,
          tabBarIcon: ({ color, focused }) => (
            <Text
              accessibilityElementsHidden
              style={[styles.tabIcon, { color, opacity: focused ? 1 : 0.72 }]}
            >
              {tab.icon}
            </Text>
          ),
          tabBarStyle: {
            backgroundColor: tokens.surface,
            borderTopColor: tokens.primary,
            borderTopWidth: 1.5,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            height: 58 + insets.bottom,
            marginHorizontal: 0,
            marginBottom: 0,
            overflow: 'hidden',
            paddingTop: 9,
            paddingBottom: Math.max(insets.bottom, 10),
            shadowColor: tokens.shadow,
            shadowOffset: { width: 0, height: -5 },
            shadowOpacity: 1,
            shadowRadius: 14,
            elevation: 8,
          },
          tabBarLabelStyle: styles.tabLabel,
        };
      }}
    >
      <Tabs.Screen name="GameList" component={GameListScreen} options={{ title: 'Play' }} />
      <Tabs.Screen
        name="Leaderboard"
        component={LeaderboardScreen}
        options={{ title: 'Leaderboard' }}
      />
      <Tabs.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Tabs.Navigator>
  );
}

function LegalRoutes() {
  return (
    <>
      <Stack.Screen name="Legal" component={LegalScreen} options={{ title: 'Legal & privacy' }} />
      <Stack.Screen
        name="LegalDocument"
        component={LegalDocumentScreen}
        options={({ route }) => ({
          title:
            route.params.document === 'privacy'
              ? 'Privacy Policy'
              : route.params.document === 'terms'
                ? 'Terms and Conditions'
                : route.params.document === 'cookies'
                  ? 'Cookie Policy'
                  : 'Refund Policy',
        })}
      />
    </>
  );
}

export type { RootStackParamList };

export function App() {
  const [colorOption, setColorOptionState] = useState<ColorOptionName>(DEFAULT_COLOR_OPTION);
  const tokens = themeTokens(colorOption);
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const runtimeRef = useRef<AppRuntime | null>(null);

  const setColorOption = useCallback((option: ColorOptionName) => {
    setColorOptionState(option);
    void saveThemePreference(bulkKv, option);
  }, []);

  const reload = useCallback(async () => {
    if (runtime === null) return;
    setIdentity(await loadIdentity(runtime));
  }, [runtime]);

  useEffect(() => {
    void loadThemePreference(bulkKv).then(setColorOptionState);
    void bootRuntime({
      onRevoked: () => {
        const current = runtimeRef.current;
        if (current === null) {
          setIdentity({ gate: 'signedOut', session: null, pairing: null });
          return;
        }
        void current.auth.signOut().then(() => {
          setIdentity({ gate: 'signedOut', session: null, pairing: null });
        });
      },
      onPairingEnded: () => {
        const current = runtimeRef.current;
        if (current !== null) void loadIdentity(current).then(setIdentity);
      },
    }).then((result) => {
      if (!result.ok) {
        setConfigError(result.message);
        return;
      }
      runtimeRef.current = result.runtime;
      setRuntime(result.runtime);
      setIdentity(result.identity);
    });
  }, []);

  useEffect(() => {
    if (runtime === null || identity?.session === null || identity?.session === undefined) return;

    // Refresh an already-authorized native token without ever prompting at
    // boot. Permission prompts are initiated only from Settings.
    void registerApnsToken(runtime.notifications, identity.session.accountId, false);
    const stopTokenRotation = subscribeApnsTokenRotation(
      runtime.notifications,
      identity.session.accountId,
    );
    return stopTokenRotation;
  }, [identity?.session?.accountId, runtime]);

  useEffect(() => {
    if (
      runtime === null ||
      identity === null ||
      identity.gate !== 'ready' ||
      identity.session === null ||
      identity.pairing === null
    ) {
      runtime?.connection.disconnect();
      runtime?.notifications.unsubscribe();
      return;
    }

    runtime.connection.connect({
      accountId: identity.session.accountId,
      pairingId: identity.pairing.id,
      epoch: identity.session.epoch,
    });
    runtime.notifications.subscribe(identity.session.accountId);
    void runtime.notifications.list(identity.session.accountId);
    void runtime.asyncGames.refresh();

    return () => {
      runtime.connection.disconnect();
      runtime.notifications.unsubscribe();
    };
  }, [identity, runtime]);

  if (configError !== null) {
    return (
      <SafeAreaProvider>
        <Screen tokens={tokens}>
          <AppText kind="title" tokens={tokens}>
            Almost ready
          </AppText>
          <AppText kind="muted" tokens={tokens} style={styles.lead}>
            {configError}
          </AppText>
        </Screen>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    );
  }

  if (runtime === null || identity === null) {
    return (
      <SafeAreaProvider>
        <View style={[styles.boot, { backgroundColor: tokens.background }]}>
          <SkeletonLoader tokens={tokens} />
        </View>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    );
  }

  const header = {
    headerStyle: { backgroundColor: tokens.surface },
    headerTitleStyle: { color: tokens.textPrimary },
    headerTintColor: tokens.onPrimary,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: tokens.background },
  };

  return (
    <SafeAreaProvider>
      <AppProvider value={{ runtime, identity, reload, tokens, colorOption, setColorOption }}>
        <NavigationContainer theme={navigationTheme(tokens)}>
          {identity.gate === 'signedOut' ? (
            <Stack.Navigator screenOptions={header}>
              <Stack.Screen
                name="SignIn"
                component={SignInScreen}
                options={{ title: 'LDR Companion', headerShown: false }}
              />
              {LegalRoutes()}
            </Stack.Navigator>
          ) : identity.gate === 'unpaired' ? (
            <Stack.Navigator screenOptions={header}>
              <Stack.Screen
                name="Pairing"
                component={PairingScreen}
                options={{ title: 'Pair up' }}
              />
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ title: 'Settings' }}
              />
              {LegalRoutes()}
            </Stack.Navigator>
          ) : (
            <Stack.Navigator screenOptions={header}>
              <Stack.Screen
                name="MainTabs"
                options={{ headerShown: false, title: 'Play' }}
                children={() => <MainTabs tokens={tokens} />}
              />
              {LegalRoutes()}
              <Stack.Screen
                name="TicTacToe"
                component={TicTacToeScreen}
                options={{ title: 'Tic-tac-toe', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="Battleship"
                component={BattleshipScreen}
                options={{ title: 'Battleship', headerBackTitle: 'Play' }}
              />
            </Stack.Navigator>
          )}
        </NavigationContainer>
      </AppProvider>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  lead: { marginTop: 16 },
  tabIcon: { fontSize: 21, lineHeight: 24, fontWeight: '600' },
  tabLabel: { fontSize: 11, fontWeight: '600' },
});
