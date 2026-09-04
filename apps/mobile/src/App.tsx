/**
 * Root component: navigation container and the app's stack (task 22.1a).
 *
 * The stack is declared here rather than per-screen so task 22.1b adds routes to
 * one list: sign in / register, pairing, the game list, and the two boards. The
 * route map is typed, so a navigate() to a route that does not exist — or with
 * the wrong params — fails at compile time rather than on a phone.
 */
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BootScreen } from './screens/BootScreen';
import { navigationTheme, themeTokens } from './theme';

/** Routes and their params. Task 22.1b extends this. */
export type RootStackParamList = {
  readonly Boot: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function App() {
  const tokens = themeTokens();

  return (
    // SafeAreaProvider wraps the navigator because the boards (22.1b) need the
    // inset values to keep a grid clear of the home indicator.
    <SafeAreaProvider>
      <NavigationContainer theme={navigationTheme(tokens)}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: tokens.surface },
            headerTitleStyle: { color: tokens.textPrimary },
            headerTintColor: tokens.primaryStrong,
            contentStyle: { backgroundColor: tokens.background },
          }}
        >
          <Stack.Screen name="Boot" component={BootScreen} options={{ title: 'LDR Companion' }} />
        </Stack.Navigator>
      </NavigationContainer>
      {/* Dark glyphs: every colour option's background is a light pastel. */}
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
