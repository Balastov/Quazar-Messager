import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import Navigation from './navigation';
import CallOverlay from './components/CallOverlay';

export default function App() {
  return (
    <SafeAreaProvider>
      <Navigation />
      <CallOverlay />
    </SafeAreaProvider>
  );
}
