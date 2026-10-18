import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import Navigation from './navigation';
import CallOverlay from './components/CallOverlay';
import ContactsAutoSync from './contacts/ContactsAutoSync';

export default function App() {
  return (
    <SafeAreaProvider>
      <Navigation />
      <CallOverlay />
      <ContactsAutoSync />
    </SafeAreaProvider>
  );
}
