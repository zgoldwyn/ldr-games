/**
 * Root component: identity gate and the MVP stacks (task 22.1b).
 *
 * Boot restores the SecureStore session and the Local Store snapshot, then
 * picks SignIn / Pairing / the game stack. The paired stack opens the 23.1 live
 * channels so partner game invites and turns arrive without manual ids.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider } from './app-context';
import type { RootStackParamList } from './navigation';
import { bootRuntime, loadIdentity, type AppRuntime, type Identity } from './runtime';
import { BattleshipScreen } from './screens/BattleshipScreen';
import { GameListScreen } from './screens/GameListScreen';
import { PairingScreen } from './screens/PairingScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TicTacToeScreen } from './screens/TicTacToeScreen';
import { registerApnsToken, subscribeApnsTokenRotation } from './notifications/apns-registration';
import { navigationTheme, themeTokens } from './theme';
import { AppText } from './ui/AppText';
import { Screen } from './ui/Screen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export type { RootStackParamList };

export function App() {
  const tokens = themeTokens();
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const runtimeRef = useRef<AppRuntime | null>(null);

  const reload = useCallback(async () => {
    if (runtime === null) return;
    setIdentity(await loadIdentity(runtime));
  }, [runtime]);

  useEffect(() => {
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
          <ActivityIndicator color={tokens.primaryStrong} />
          <AppText kind="muted" tokens={tokens} style={styles.lead}>
            Restoring your session
          </AppText>
        </View>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    );
  }

  const header = {
    headerStyle: { backgroundColor: tokens.surface },
    headerTitleStyle: { color: tokens.textPrimary },
    headerTintColor: tokens.primaryStrong,
    contentStyle: { backgroundColor: tokens.background },
  };

  return (
    <SafeAreaProvider>
      <AppProvider value={{ runtime, identity, reload }}>
        <NavigationContainer theme={navigationTheme(tokens)}>
          {identity.gate === 'signedOut' ? (
            <Stack.Navigator screenOptions={header}>
              <Stack.Screen
                name="SignIn"
                component={SignInScreen}
                options={{ title: 'LDR Companion', headerShown: false }}
              />
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
            </Stack.Navigator>
          ) : (
            <Stack.Navigator screenOptions={header}>
              <Stack.Screen
                name="GameList"
                component={GameListScreen}
                options={{ title: 'Play' }}
              />
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ title: 'Settings' }}
              />
              <Stack.Screen
                name="TicTacToe"
                component={TicTacToeScreen}
                options={{ title: 'Tic-tac-toe' }}
              />
              <Stack.Screen
                name="Battleship"
                component={BattleshipScreen}
                options={{ title: 'Battleship' }}
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
});
