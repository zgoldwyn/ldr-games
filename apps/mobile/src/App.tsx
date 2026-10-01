/**
 * Root component: identity gate and the MVP stacks (task 22.1b).
 *
 * Boot restores the SecureStore session and the Local Store snapshot, then
 * picks SignIn / Pairing / the game stack. The paired stack opens the 23.1 live
 * channels so partner game invites and turns arrive without manual ids.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DEFAULT_COLOR_OPTION,
  type AccountDetails,
  type AccountId,
  type ColorOptionName,
  type ElementalRole,
  type RelationshipDate,
} from '@ldr/core';

import { AppProvider } from './app-context';
import type { MainTabParamList, RootStackParamList } from './navigation';
import { primaryTab } from './primary-tabs';
import type { PlatformerSessionAccess } from './games/elemental-online';
import type { LiveGameRoute } from './games/live-game-request';
import { bootRuntime, loadIdentity, type AppRuntime, type Identity } from './runtime';
import { BattleshipScreen } from './screens/BattleshipScreen';
import { AccountScreen } from './screens/AccountScreen';
import { PlayScreen } from './screens/PlayScreen';
import { MiniGamesScreen } from './screens/MiniGamesScreen';
import { AsyncGamesScreen } from './screens/AsyncGamesScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { LegalDocumentScreen } from './screens/LegalDocumentScreen';
import { LegalScreen } from './screens/LegalScreen';
import { PairingScreen } from './screens/PairingScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ImportantDatesScreen } from './screens/ImportantDatesScreen';
import { EditImportantDatesScreen } from './screens/EditImportantDatesScreen';
import { TicTacToeScreen } from './screens/TicTacToeScreen';
import { DrawTogetherScreen } from './screens/DrawTogetherScreen';
import { CouplesQuizScreen } from './screens/CouplesQuizScreen';
import { CardGamesScreen } from './screens/CardGamesScreen';
import { WordGamesScreen } from './screens/WordGamesScreen';
import { WordChainScreen } from './screens/WordChainScreen';
import { SpeedScreen } from './screens/SpeedScreen';
import { QuizLibraryScreen } from './screens/QuizLibraryScreen';
import { ElementalDuetScreen } from './screens/ElementalDuetScreen';
import { ElementalDuetSetupScreen } from './screens/ElementalDuetSetupScreen';
import { ElementalDuetWinScreen } from './screens/ElementalDuetWinScreen';
import { registerApnsToken, subscribeApnsTokenRotation } from './notifications/apns-registration';
import { navigationTheme, themeTokens } from './theme';
import { loadThemePreference, saveThemePreference } from './theme-preference';
import { bulkKv } from './session/expo-kv';
import { AppText } from './ui/AppText';
import { Screen } from './ui/Screen';
import { SkeletonLoader } from './ui/SkeletonLoader';
import { IncomingLiveGameRequest } from './ui/IncomingLiveGameRequest';
import { NavigationTitle } from './ui/NavigationTitle';
import { IllustratedHeaderBackground } from './ui/IllustratedHeaderBackground';
import { todayCalendarDate } from './important-dates';
import {
  INITIAL_PARTNER_PRESENCE,
  subscribePartnerAppPresence,
  type PartnerAppPresence,
} from './app-presence';

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
          headerShown: false,
          sceneStyle: { backgroundColor: tokens.background },
          tabBarActiveTintColor: tokens.primaryStrong,
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
            borderTopWidth: 0,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            height: 58 + insets.bottom,
            marginHorizontal: 0,
            marginBottom: 0,
            overflow: 'hidden',
            paddingTop: 9,
            paddingBottom: Math.max(insets.bottom, 10),
            shadowOpacity: 0,
            elevation: 0,
          },
          tabBarLabelStyle: styles.tabLabel,
        };
      }}
    >
      <Tabs.Screen name="Play" component={PlayScreen} options={{ title: 'Play' }} />
      <Tabs.Screen
        name="AsyncGames"
        component={AsyncGamesScreen}
        options={{ title: 'Your Games' }}
      />
      <Tabs.Screen
        name="Leaderboard"
        component={LeaderboardScreen}
        options={{ title: 'Leaderboard' }}
      />
      <Tabs.Screen
        name="ImportantDates"
        component={ImportantDatesScreen}
        options={{ title: 'Dates' }}
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
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const [colorOption, setColorOptionState] = useState<ColorOptionName>(DEFAULT_COLOR_OPTION);
  const tokens = themeTokens(colorOption);
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [accountDetails, setAccountDetails] = useState<AccountDetails | null>(null);
  const [partnerPresence, setPartnerPresence] = useState<PartnerAppPresence>(
    INITIAL_PARTNER_PRESENCE,
  );
  const [importantDates, setImportantDates] = useState<readonly RelationshipDate[]>([]);
  const runtimeRef = useRef<AppRuntime | null>(null);

  const openLiveGame = useCallback(
    (route: LiveGameRoute, id: string) => {
      if (!navigationRef.isReady()) return;
      switch (route) {
        case 'TicTacToe':
          navigationRef.navigate('TicTacToe', { sessionId: id });
          break;
        case 'DrawTogether':
          navigationRef.navigate('DrawTogether', { sessionId: id });
          break;
        case 'Speed':
          navigationRef.navigate('Speed', { sessionId: id });
          break;
        case 'WordChain':
          navigationRef.navigate('WordChain', { sessionId: id });
          break;
      }
    },
    [navigationRef],
  );

  const openPlatformer = useCallback(
    (role: ElementalRole, access: PlatformerSessionAccess) => {
      if (navigationRef.isReady()) navigationRef.navigate('ElementalDuet', { role, access });
    },
    [navigationRef],
  );

  const setColorOption = useCallback((option: ColorOptionName) => {
    setColorOptionState(option);
    void saveThemePreference(bulkKv, option);
  }, []);

  const reload = useCallback(async () => {
    if (runtime === null) return;
    setIdentity(await loadIdentity(runtime));
  }, [runtime]);

  const refreshAccount = useCallback(async () => {
    if (runtime === null || identity?.session === null || identity?.session === undefined) {
      setAccountDetails(null);
      return;
    }
    const self = identity.session.accountId;
    const pairing = identity.pairing;
    const partner: AccountId | undefined =
      pairing === null ? undefined : pairing.memberA === self ? pairing.memberB : pairing.memberA;
    const result = await runtime.profile.getDetails(self, partner);
    setAccountDetails(result.ok ? result.value : null);
  }, [identity, runtime]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (
      runtime === null ||
      identity?.gate !== 'ready' ||
      identity.session === null ||
      identity.pairing === null
    ) {
      setPartnerPresence(INITIAL_PARTNER_PRESENCE);
      return;
    }

    const selfAccountId = identity.session.accountId;
    const partnerAccountId =
      identity.pairing.memberA === selfAccountId
        ? identity.pairing.memberB
        : identity.pairing.memberA;

    return subscribePartnerAppPresence({
      client: runtime.client,
      pairingId: identity.pairing.id,
      selfAccountId,
      partnerAccountId,
      onChange: setPartnerPresence,
    });
  }, [identity, runtime]);

  const refreshImportantDates = useCallback(async () => {
    if (runtime === null || identity?.pairing === null || identity?.pairing === undefined) {
      setImportantDates([]);
      return;
    }
    setImportantDates(await runtime.calendar.listDates(todayCalendarDate()));
  }, [identity?.pairing, runtime]);

  useEffect(() => {
    if (runtime === null || identity?.gate !== 'ready' || identity.pairing === null) {
      setImportantDates([]);
      runtime?.calendar.unsubscribe();
      return;
    }
    const updateFromCache = () => {
      setImportantDates(runtime.calendar.cached(todayCalendarDate()));
    };
    runtime.calendar.subscribe(identity.pairing.id);
    const unsubscribeCache = runtime.calendar.subscribeCache(updateFromCache);
    void refreshImportantDates();
    return () => {
      unsubscribeCache();
      runtime.calendar.unsubscribe();
    };
  }, [identity?.gate, identity?.pairing, refreshImportantDates, runtime]);

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
    headerStyle: { backgroundColor: tokens.background },
    headerTitleStyle: {
      color: tokens.textPrimary,
      fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
      fontWeight: '700' as const,
    },
    headerTintColor: tokens.textPrimary,
    headerTitle: ({ children }: { readonly children: string }) => (
      <NavigationTitle title={children} tokens={tokens} />
    ),
    headerBackground: () => <IllustratedHeaderBackground tokens={tokens} />,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: tokens.background },
  };

  return (
    <SafeAreaProvider>
      <AppProvider
        value={{
          runtime,
          identity,
          reload,
          accountDetails,
          partnerPresence,
          importantDates,
          refreshImportantDates,
          refreshAccount,
          tokens,
          colorOption,
          setColorOption,
        }}
      >
        <NavigationContainer ref={navigationRef} theme={navigationTheme(tokens)}>
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
              <Stack.Screen
                name="Account"
                component={AccountScreen}
                options={{ title: 'Account' }}
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
                name="Account"
                component={AccountScreen}
                options={{ title: 'Account' }}
              />
              <Stack.Screen
                name="EditImportantDates"
                component={EditImportantDatesScreen}
                options={{ title: 'Important Dates', headerBackTitle: 'Dates' }}
              />
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
              <Stack.Screen
                name="DrawTogether"
                component={DrawTogetherScreen}
                options={{ title: 'Draw Together', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="MiniGames"
                component={MiniGamesScreen}
                options={{ title: 'Other Minigames', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="CardGames"
                component={CardGamesScreen}
                options={{ title: 'Card Games', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="WordGames"
                component={WordGamesScreen}
                options={{ title: 'Word Games', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="WordChain"
                component={WordChainScreen}
                options={{ title: 'Word Chain', headerBackTitle: 'Words' }}
              />
              <Stack.Screen
                name="Speed"
                component={SpeedScreen}
                options={{ title: 'Speed', headerBackTitle: 'Cards' }}
              />
              <Stack.Screen
                name="ElementalDuetSetup"
                component={ElementalDuetSetupScreen}
                options={{ title: 'Ember & Tide', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="ElementalDuet"
                component={ElementalDuetScreen}
                options={{ title: 'Ember & Tide', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="ElementalDuetWin"
                component={ElementalDuetWinScreen}
                options={{ title: 'You won!', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="QuizLibrary"
                component={QuizLibraryScreen}
                options={{ title: 'Couples Quiz', headerBackTitle: 'Play' }}
              />
              <Stack.Screen
                name="CouplesQuiz"
                component={CouplesQuizScreen}
                options={{ title: 'Couples Quiz', headerBackTitle: 'Quizzes' }}
              />
            </Stack.Navigator>
          )}
        </NavigationContainer>
        {identity.gate === 'ready' ? (
          <IncomingLiveGameRequest
            onOpenGame={openLiveGame}
            onOpenPlatformer={openPlatformer}
            isPlatformerOpen={() => navigationRef.getCurrentRoute()?.name === 'ElementalDuet'}
          />
        ) : null}
      </AppProvider>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  lead: { marginTop: 16 },
  tabIcon: { fontSize: 21, lineHeight: 24, fontWeight: '600' },
  tabLabel: {
    fontFamily: Platform.select({ ios: 'Avenir Next', android: 'sans-serif-rounded' }),
    fontSize: 11,
    fontWeight: '600',
  },
});
