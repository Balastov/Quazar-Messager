import React from 'react';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import Navigation from './navigation';
import CallOverlay from './components/CallOverlay';
import ContactsAutoSync from './contacts/ContactsAutoSync';
import ActivityTracker from './presence/ActivityTracker';
import PhoneVerificationPrompt from './components/PhoneVerificationPrompt';

export default function App() {
  return (
    <SafeAreaProvider>
      <Navigation />
      <CallOverlay />
      <ContactsAutoSync />
      <ActivityTracker />
      <PhoneVerificationPrompt />
    </SafeAreaProvider>
  );
}
